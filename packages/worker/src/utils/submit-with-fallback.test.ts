import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { AIModel } from "@metabox/shared";
import type { AcquiredKey } from "@metabox/api/services/key-pool";

// ── Mock external deps via vi.hoisted ────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  acquireKey: vi.fn(),
  markRateLimited: vi.fn(),
  recordSuccess: vi.fn(),
  recordError: vi.fn(),
  isProviderInLongCooldown: vi.fn(),
  markProviderLongCooldown: vi.fn(),
  getProviderLongCooldownRemaining: vi.fn(),
  tripThrottle: vi.fn(),
  delayJob: vi.fn(),
  notifyRateLimit: vi.fn(),
  notifyFallback: vi.fn(),
  notifyTechErrorThrottled: vi.fn(),
}));

vi.mock("@metabox/api/services/key-pool", () => ({
  acquireKey: mocks.acquireKey,
  markRateLimited: mocks.markRateLimited,
  recordSuccess: mocks.recordSuccess,
  recordError: mocks.recordError,
}));

vi.mock("@metabox/api/services/throttle", () => ({
  isProviderInLongCooldown: mocks.isProviderInLongCooldown,
  markProviderLongCooldown: mocks.markProviderLongCooldown,
  getProviderLongCooldownRemaining: mocks.getProviderLongCooldownRemaining,
  tripThrottle: mocks.tripThrottle,
}));

vi.mock("./delay-job.js", () => ({ delayJob: mocks.delayJob }));
vi.mock("./notify-error.js", () => ({
  notifyRateLimit: mocks.notifyRateLimit,
  notifyFallback: mocks.notifyFallback,
  notifyTechErrorThrottled: mocks.notifyTechErrorThrottled,
}));

// Real resolveKeyProviderForModel это маленькая pure функция, но при моке
// других @metabox/api подмодулей vitest не может зарезолвить полный barrel —
// проще явно подменить упрощённой версией (model.provider напрямую).
vi.mock("@metabox/api/ai/key-provider", () => ({
  resolveKeyProvider: vi.fn(),
  resolveKeyProviderForModel: (model: { provider: string }) => model.provider,
}));

// rate-limit-error: pure utility функции. Подменяем simplified-версиями
// (полная schema есть в реальном коде, для тестов достаточно status-based).
vi.mock("@metabox/api/utils/rate-limit-error", () => ({
  LONG_WINDOW_THRESHOLD_MS: 60 * 60 * 1000,
  isFiveXxError: (err: unknown): boolean => {
    if (!err || typeof err !== "object") return false;
    const e = err as { status?: number };
    return typeof e.status === "number" && e.status >= 500 && e.status < 600;
  },
  classifyRateLimit: (err: unknown) => {
    if (!err || typeof err !== "object") {
      return { isRateLimit: false, cooldownMs: 0, isLongWindow: false, reason: "" };
    }
    const e = err as { status?: number; message?: string };
    const status = e.status;
    const message = e.message ?? "";
    const isRateLimit =
      status === 429 ||
      status === 402 ||
      /rate limit|too many|quota|throttl|insufficient credits/i.test(message);
    if (!isRateLimit) return { isRateLimit: false, cooldownMs: 0, isLongWindow: false, reason: "" };
    // "insufficient credits" — pattern-matched long-window с КОРОТКИМ cooldown
    // (per-account ошибка одного ключа, не длинный quota-reset). Используется
    // для теста что markProviderLongCooldown НЕ вызывается в этом случае.
    const isPerAccountQuota = /insufficient credits/i.test(message);
    const isLongWindow =
      isPerAccountQuota || /daily quota|monthly|out of credits|tier limit/i.test(message);
    const cooldownMs = isPerAccountQuota ? 60_000 : isLongWindow ? 2 * 60 * 60 * 1000 : 60_000;
    return {
      isRateLimit: true,
      cooldownMs,
      isLongWindow,
      reason: `${status ?? ""}: ${message}`,
    };
  },
}));

// ── Real imports (no mock) ───────────────────────────────────────────────────
import { submitWithFallback } from "./submit-with-fallback.js";
import { PoolExhaustedError } from "@metabox/api/utils/pool-exhausted-error";
import { RateLimitLongWindowError } from "./submit-with-throttle.js";
import { UserFacingError } from "@metabox/shared";

// ── Test sentinel — delayJob throws this in tests ────────────────────────────
class TestDelayedSentinel extends Error {
  constructor(
    public delayMs: number,
    public newJobData: Record<string, unknown>,
  ) {
    super("test:delayed");
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeModel(opts: { id: string; provider: string }): AIModel {
  return {
    id: opts.id,
    name: opts.id,
    description: "",
    section: "design",
    provider: opts.provider,
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: false,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
  };
}

function makeJob(data: object = {}): Job<object> {
  return { data, attemptsMade: 0 } as unknown as Job<object>;
}

function makeAcquiredKey(keyId: string | null = "key-1"): AcquiredKey {
  return { keyId, apiKey: "test-api-key", proxy: null };
}

const PRIMARY = makeModel({ id: "test-model", provider: "primary-prov" });
const FALLBACK_1 = makeModel({ id: "test-model", provider: "fallback-1" });
const FALLBACK_2 = makeModel({ id: "test-model", provider: "fallback-2" });

beforeEach(() => {
  // Reset all mocks
  Object.values(mocks).forEach((m) => m.mockReset());
  // Sane defaults
  mocks.isProviderInLongCooldown.mockResolvedValue(false);
  mocks.tripThrottle.mockResolvedValue(true);
  mocks.delayJob.mockImplementation(async (job, newData, delay) => {
    throw new TestDelayedSentinel(delay as number, newData as Record<string, unknown>);
  });
  // markProviderLongCooldown / getProviderLongCooldownRemaining default returns
  mocks.markProviderLongCooldown.mockResolvedValue(undefined);
  mocks.getProviderLongCooldownRemaining.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────────
describe("submitWithFallback — happy path", () => {
  test("primary success → возвращает result, без попыток fallback", async () => {
    mocks.acquireKey.mockResolvedValueOnce(makeAcquiredKey("k1"));
    const submit = vi.fn().mockResolvedValue("ok-result");

    const res = await submitWithFallback({
      primaryModel: PRIMARY,
      fallbacks: [FALLBACK_1],
      section: "design",
      job: makeJob(),
      allowFiveXxFallback: false,
      submit,
    });

    expect(res.result).toBe("ok-result");
    expect(res.usedFallback).toBe(false);
    expect(res.effectiveProvider).toBe("primary-prov");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(mocks.acquireKey).toHaveBeenCalledTimes(1);
    expect(mocks.notifyFallback).not.toHaveBeenCalled();
    expect(mocks.recordSuccess).toHaveBeenCalledWith("k1");
  });

  test("fallback success после primary PoolExhausted → usedFallback=true + notifyFallback", async () => {
    // primary acquireKey throws PoolExhausted
    mocks.acquireKey
      .mockRejectedValueOnce(new PoolExhaustedError("primary-prov", 30000))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    const submit = vi.fn().mockResolvedValue("fallback-ok");

    const res = await submitWithFallback({
      primaryModel: PRIMARY,
      fallbacks: [FALLBACK_1],
      section: "design",
      job: makeJob(),
      allowFiveXxFallback: false,
      submit,
    });

    expect(res.result).toBe("fallback-ok");
    expect(res.usedFallback).toBe(true);
    expect(res.effectiveProvider).toBe("fallback-1");
    expect(submit).toHaveBeenCalledTimes(1); // primary skip'нулся на acquireKey
    expect(mocks.notifyFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryProvider: "primary-prov",
        fallbackProvider: "fallback-1",
        reason: "pool_exhausted",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("submitWithFallback — trigger conditions", () => {
  test("PoolExhausted на primary → пробует fallback", async () => {
    mocks.acquireKey
      .mockRejectedValueOnce(new PoolExhaustedError("primary-prov", 30000))
      .mockResolvedValueOnce(makeAcquiredKey());
    const submit = vi.fn().mockResolvedValue("ok");

    await submitWithFallback({
      primaryModel: PRIMARY,
      fallbacks: [FALLBACK_1],
      section: "design",
      job: makeJob(),
      allowFiveXxFallback: false,
      submit,
    });

    expect(submit).toHaveBeenCalledTimes(1); // только fallback
  });

  test("long-window 429 на primary → markProviderLongCooldown + tries fallback", async () => {
    mocks.acquireKey
      .mockResolvedValueOnce(makeAcquiredKey("k-primary"))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    // primary submit throws long-window 429
    const longErr = Object.assign(new Error("daily quota exceeded"), { status: 429 });
    const submit = vi.fn().mockRejectedValueOnce(longErr).mockResolvedValueOnce("fallback-ok");

    const res = await submitWithFallback({
      primaryModel: PRIMARY,
      fallbacks: [FALLBACK_1],
      section: "design",
      job: makeJob(),
      allowFiveXxFallback: false,
      submit,
    });

    expect(res.usedFallback).toBe(true);
    // markProviderLongCooldown вызван для primary keyProvider
    expect(mocks.markProviderLongCooldown).toHaveBeenCalledWith(
      "primary-prov",
      expect.any(Number),
      expect.any(String),
    );
    expect(mocks.markRateLimited).toHaveBeenCalledWith(
      "k-primary",
      expect.any(Number),
      expect.any(String),
    );
    expect(mocks.notifyFallback).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "long_window_rate_limit" }),
    );
  });

  test("isLongWindow с КОРОТКИМ cooldown (per-account quota) → fallback, но БЕЗ markProviderLongCooldown", async () => {
    // Кейс: evolink 402 "Insufficient credits" — одному ключу не хватает $$,
    // у других ключей могут быть деньги. Provider-wide marker блокировал бы
    // их зря на 60с. Только per-key markRateLimited.
    mocks.acquireKey
      .mockResolvedValueOnce(makeAcquiredKey("k-primary"))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    const perAccountErr = Object.assign(new Error("insufficient credits: need 200"), {
      status: 402,
    });
    const submit = vi
      .fn()
      .mockRejectedValueOnce(perAccountErr)
      .mockResolvedValueOnce("fallback-ok");

    const res = await submitWithFallback({
      primaryModel: PRIMARY,
      fallbacks: [FALLBACK_1],
      section: "design",
      job: makeJob(),
      allowFiveXxFallback: false,
      submit,
    });

    expect(res.usedFallback).toBe(true);
    // Per-key throttle — да.
    expect(mocks.markRateLimited).toHaveBeenCalledWith(
      "k-primary",
      expect.any(Number),
      expect.any(String),
    );
    // Provider-wide marker — НЕТ (cooldownMs 60s ≤ LONG_WINDOW_THRESHOLD_MS 1ч).
    expect(mocks.markProviderLongCooldown).not.toHaveBeenCalled();
    // notifyRateLimit зовётся (юзер-видимый алерт сохраняется).
    expect(mocks.notifyRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ isLongWindow: true }),
    );
  });

  test("short 429 на primary → defer (НЕ fallback)", async () => {
    mocks.acquireKey.mockResolvedValueOnce(makeAcquiredKey("k1"));
    const shortErr = Object.assign(new Error("too many requests"), { status: 429 });
    const submit = vi.fn().mockRejectedValueOnce(shortErr);

    await expect(
      submitWithFallback({
        primaryModel: PRIMARY,
        fallbacks: [FALLBACK_1],
        section: "design",
        job: makeJob(),
        allowFiveXxFallback: false,
        submit,
      }),
    ).rejects.toBeInstanceOf(TestDelayedSentinel);

    // submit вызван только 1 раз (primary), fallback НЕ пробовался
    expect(submit).toHaveBeenCalledTimes(1);
    expect(mocks.delayJob).toHaveBeenCalled();
    expect(mocks.markRateLimited).toHaveBeenCalledWith(
      "k1",
      expect.any(Number),
      expect.any(String),
    );
    // markProviderLongCooldown НЕ вызван (это short window)
    expect(mocks.markProviderLongCooldown).not.toHaveBeenCalled();
    // notifyFallback НЕ вызван (fallback не пробовался)
    expect(mocks.notifyFallback).not.toHaveBeenCalled();
  });

  test("5xx на attempt 0-1 (allowFiveXxFallback=false) → throws", async () => {
    mocks.acquireKey.mockResolvedValueOnce(makeAcquiredKey("k1"));
    const err5xx = Object.assign(new Error("internal"), { status: 503 });
    const submit = vi.fn().mockRejectedValueOnce(err5xx);

    await expect(
      submitWithFallback({
        primaryModel: PRIMARY,
        fallbacks: [FALLBACK_1],
        section: "design",
        job: makeJob(),
        allowFiveXxFallback: false,
        submit,
      }),
    ).rejects.toBe(err5xx);

    expect(submit).toHaveBeenCalledTimes(1); // fallback не пробовался
    expect(mocks.recordError).toHaveBeenCalled();
  });

  test("5xx на attempt 2+ (allowFiveXxFallback=true) → пробует fallback", async () => {
    mocks.acquireKey
      .mockResolvedValueOnce(makeAcquiredKey("k-primary"))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    const err5xx = Object.assign(new Error("internal"), { status: 503 });
    const submit = vi.fn().mockRejectedValueOnce(err5xx).mockResolvedValueOnce("ok");

    const res = await submitWithFallback({
      primaryModel: PRIMARY,
      fallbacks: [FALLBACK_1],
      section: "design",
      job: makeJob(),
      allowFiveXxFallback: true,
      submit,
    });

    expect(res.usedFallback).toBe(true);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(mocks.notifyFallback).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "persistent_5xx" }),
    );
  });

  test("non-rate-limit non-5xx error (primary) → пробует fallback + шлёт tech-alert", async () => {
    mocks.acquireKey
      .mockResolvedValueOnce(makeAcquiredKey("k-primary"))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    const validationErr = Object.assign(new Error("bad request"), { status: 400 });
    const submit = vi.fn().mockRejectedValueOnce(validationErr).mockResolvedValueOnce("ok");

    const res = await submitWithFallback({
      primaryModel: PRIMARY,
      fallbacks: [FALLBACK_1],
      section: "design",
      job: makeJob(),
      allowFiveXxFallback: true,
      submit,
    });

    expect(res.usedFallback).toBe(true);
    expect(submit).toHaveBeenCalledTimes(2);
    // Tech-alert ушёл per-candidate (даже если fallback успел спасти запрос).
    expect(mocks.notifyTechErrorThrottled).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTechErrorThrottled).toHaveBeenCalledWith(
      validationErr,
      expect.objectContaining({ section: "design", modelId: PRIMARY.id }),
      expect.stringMatching(/^unknown-error:/),
    );
    // notifyFallback (success switch) — с reason unknown_error.
    expect(mocks.notifyFallback).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "unknown_error" }),
    );
  });

  test("non-rate-limit non-5xx error везде → throws lastError + per-candidate tech-alerts", async () => {
    mocks.acquireKey
      .mockResolvedValueOnce(makeAcquiredKey("k-primary"))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    const err1 = Object.assign(new Error("primary boom"), { status: 400 });
    const err2 = Object.assign(new Error("fallback boom"), { status: 400 });
    const submit = vi.fn().mockRejectedValueOnce(err1).mockRejectedValueOnce(err2);

    await expect(
      submitWithFallback({
        primaryModel: PRIMARY,
        fallbacks: [FALLBACK_1],
        section: "design",
        job: makeJob(),
        allowFiveXxFallback: true,
        submit,
      }),
    ).rejects.toBe(err2);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(mocks.notifyTechErrorThrottled).toHaveBeenCalledTimes(2);
    // notifyFallback (all_candidates_failed) тоже улетел.
    expect(mocks.notifyFallback).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "all_candidates_failed" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("submitWithFallback — candidate iteration", () => {
  test("primary в long-cooldown marker → skipped без acquireKey", async () => {
    mocks.isProviderInLongCooldown.mockImplementation((provider: string) =>
      Promise.resolve(provider === "primary-prov"),
    );
    mocks.getProviderLongCooldownRemaining.mockResolvedValueOnce(120000); // 2 min remaining
    mocks.acquireKey.mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    const submit = vi.fn().mockResolvedValue("fallback-ok");

    const res = await submitWithFallback({
      primaryModel: PRIMARY,
      fallbacks: [FALLBACK_1],
      section: "design",
      job: makeJob(),
      allowFiveXxFallback: false,
      submit,
    });

    expect(res.usedFallback).toBe(true);
    // acquireKey НЕ вызывался для primary (skipped по marker)
    expect(mocks.acquireKey).toHaveBeenCalledTimes(1);
    expect(mocks.acquireKey).toHaveBeenCalledWith("fallback-1");
    expect(mocks.notifyFallback).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "provider_long_cooldown_marker" }),
    );
  });

  test("первый fallback PoolExhausted → переходит ко второму fallback", async () => {
    mocks.acquireKey
      .mockResolvedValueOnce(makeAcquiredKey("k-primary"))
      .mockRejectedValueOnce(new PoolExhaustedError("fallback-1", 30000))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb2"));
    // primary submit throws long-window
    const longErr = Object.assign(new Error("daily quota exceeded"), { status: 429 });
    const submit = vi.fn().mockRejectedValueOnce(longErr).mockResolvedValueOnce("ok-fb2");

    const res = await submitWithFallback({
      primaryModel: PRIMARY,
      fallbacks: [FALLBACK_1, FALLBACK_2],
      section: "design",
      job: makeJob(),
      allowFiveXxFallback: false,
      submit,
    });

    expect(res.effectiveProvider).toBe("fallback-2");
  });

  test("все candidates exhausted → defer + notifyFallback с all_candidates_failed", async () => {
    mocks.acquireKey
      .mockRejectedValueOnce(new PoolExhaustedError("primary-prov", 60000))
      .mockRejectedValueOnce(new PoolExhaustedError("fallback-1", 30000));
    const submit = vi.fn();

    await expect(
      submitWithFallback({
        primaryModel: PRIMARY,
        fallbacks: [FALLBACK_1],
        section: "design",
        job: makeJob(),
        allowFiveXxFallback: false,
        submit,
      }),
    ).rejects.toBeInstanceOf(TestDelayedSentinel);

    expect(submit).not.toHaveBeenCalled();
    expect(mocks.notifyFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackProvider: null,
        reason: "all_candidates_failed",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("submitWithFallback — env-mode (keyId=null)", () => {
  test("env-mode 429 → tripThrottle on modelId, не markRateLimited", async () => {
    mocks.acquireKey.mockResolvedValueOnce(makeAcquiredKey(null)); // env-mode
    const shortErr = Object.assign(new Error("too many requests"), { status: 429 });
    const submit = vi.fn().mockRejectedValueOnce(shortErr);

    await expect(
      submitWithFallback({
        primaryModel: PRIMARY,
        fallbacks: [],
        section: "design",
        job: makeJob(),
        allowFiveXxFallback: false,
        submit,
      }),
    ).rejects.toBeInstanceOf(TestDelayedSentinel);

    expect(mocks.tripThrottle).toHaveBeenCalledWith(
      "test-model",
      expect.any(Number),
      expect.any(String),
    );
    expect(mocks.markRateLimited).not.toHaveBeenCalled();
  });

  test("env-mode 429: notifyRateLimit вызван только если tripThrottle вернул true", async () => {
    mocks.acquireKey.mockResolvedValueOnce(makeAcquiredKey(null));
    mocks.tripThrottle.mockResolvedValueOnce(false); // gate уже стоит — не дублируем notify
    const shortErr = Object.assign(new Error("too many requests"), { status: 429 });
    const submit = vi.fn().mockRejectedValueOnce(shortErr);

    await expect(
      submitWithFallback({
        primaryModel: PRIMARY,
        fallbacks: [],
        section: "design",
        job: makeJob(),
        allowFiveXxFallback: false,
        submit,
      }),
    ).rejects.toBeInstanceOf(TestDelayedSentinel);

    expect(mocks.notifyRateLimit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("submitWithFallback — Fix #1: ignore retryAfterMs=0 in MIN", () => {
  test("primary в marker (большой TTL) + misconfigured fallback (retry=0) → defer использует TTL primary", async () => {
    // Primary skipped via marker, large remaining TTL
    mocks.isProviderInLongCooldown.mockImplementation((provider: string) =>
      Promise.resolve(provider === "primary-prov"),
    );
    mocks.getProviderLongCooldownRemaining.mockResolvedValueOnce(6_000_000); // 100 min

    // Misconfigured fallback throws PoolExhausted with retry=0
    mocks.acquireKey.mockRejectedValueOnce(new PoolExhaustedError("fallback-1", 0));
    const submit = vi.fn();

    let captured: TestDelayedSentinel | null = null;
    try {
      await submitWithFallback({
        primaryModel: PRIMARY,
        fallbacks: [FALLBACK_1],
        section: "design",
        job: makeJob(),
        allowFiveXxFallback: false,
        submit,
      });
    } catch (e) {
      if (e instanceof TestDelayedSentinel) captured = e;
      else throw e;
    }

    expect(captured).not.toBeNull();
    // Без Fix #1 delay был бы ~1с (MIN(6_000_000, 0) → 0 → withJitter ≥ 1000ms).
    // С Fix #1 delay должен быть capped на 10мин (Fix #3, потому что 100min > 10min cap).
    // Минимум: > 1с (значит 0 не выиграл MIN), максимум: ≤ 10min + jitter (≤ 12с jitter не будет
    // — withJitter добавляет 0-2с к 600_000ms = ~600_000-602_000).
    expect(captured!.delayMs).toBeGreaterThan(60_000); // не схлопнулся в секунды
    expect(captured!.delayMs).toBeLessThan(15 * 60 * 1000); // не больше 10min + jitter
  });

  test("fallback PoolExhausted с retry=30s → defer ≤ 30s + jitter (Fix #1 не задействован, обычный кейс)", async () => {
    mocks.acquireKey
      .mockRejectedValueOnce(new PoolExhaustedError("primary-prov", 60000))
      .mockRejectedValueOnce(new PoolExhaustedError("fallback-1", 30000));
    const submit = vi.fn();

    let captured: TestDelayedSentinel | null = null;
    try {
      await submitWithFallback({
        primaryModel: PRIMARY,
        fallbacks: [FALLBACK_1],
        section: "design",
        job: makeJob(),
        allowFiveXxFallback: false,
        submit,
      });
    } catch (e) {
      if (e instanceof TestDelayedSentinel) captured = e;
      else throw e;
    }

    expect(captured).not.toBeNull();
    // MIN(60000, 30000) = 30000, + jitter (0-2000ms) = 30_000-32_000
    expect(captured!.delayMs).toBeGreaterThanOrEqual(30_000);
    expect(captured!.delayMs).toBeLessThanOrEqual(32_500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("submitWithFallback — Fix #2: circuit breaker", () => {
  test("первый defer: deferCount → 1 в job data", async () => {
    mocks.acquireKey.mockRejectedValueOnce(new PoolExhaustedError("primary-prov", 60000));
    const submit = vi.fn();

    let captured: TestDelayedSentinel | null = null;
    try {
      await submitWithFallback({
        primaryModel: PRIMARY,
        fallbacks: [],
        section: "design",
        job: makeJob({ existingField: "value" }),
        allowFiveXxFallback: false,
        submit,
      });
    } catch (e) {
      if (e instanceof TestDelayedSentinel) captured = e;
      else throw e;
    }

    expect(captured!.newJobData).toMatchObject({
      existingField: "value",
      fallbackDeferCount: 1,
    });
  });

  test("counter инкрементится: existing fallbackDeferCount=3 → next=4", async () => {
    mocks.acquireKey.mockRejectedValueOnce(new PoolExhaustedError("primary-prov", 60000));
    const submit = vi.fn();

    let captured: TestDelayedSentinel | null = null;
    try {
      await submitWithFallback({
        primaryModel: PRIMARY,
        fallbacks: [],
        section: "design",
        job: makeJob({ fallbackDeferCount: 3 }),
        allowFiveXxFallback: false,
        submit,
      });
    } catch (e) {
      if (e instanceof TestDelayedSentinel) captured = e;
      else throw e;
    }

    expect(captured!.newJobData.fallbackDeferCount).toBe(4);
  });

  test("при достижении MAX_FALLBACK_DEFERS бросает RateLimitLongWindowError", async () => {
    mocks.acquireKey.mockRejectedValueOnce(new PoolExhaustedError("primary-prov", 60000));
    const submit = vi.fn();

    // MAX = 6, fallbackDeferCount = 5 → next=6 → fail terminally
    await expect(
      submitWithFallback({
        primaryModel: PRIMARY,
        fallbacks: [],
        section: "design",
        job: makeJob({ fallbackDeferCount: 5 }),
        allowFiveXxFallback: false,
        submit,
      }),
    ).rejects.toBeInstanceOf(RateLimitLongWindowError);

    expect(mocks.delayJob).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("submitWithFallback — Fix #3: 10-min cap", () => {
  test("delay > 10min → capped на 10min", async () => {
    // Primary in marker with 100-min TTL
    mocks.isProviderInLongCooldown.mockImplementation((provider: string) =>
      Promise.resolve(provider === "primary-prov"),
    );
    mocks.getProviderLongCooldownRemaining.mockResolvedValueOnce(100 * 60 * 1000);

    const submit = vi.fn();

    let captured: TestDelayedSentinel | null = null;
    try {
      await submitWithFallback({
        primaryModel: PRIMARY,
        fallbacks: [],
        section: "design",
        job: makeJob(),
        allowFiveXxFallback: false,
        submit,
      });
    } catch (e) {
      if (e instanceof TestDelayedSentinel) captured = e;
      else throw e;
    }

    // Cap 10 мин = 600_000 ms, + jitter (0-2000 ms) = 600_000-602_000
    expect(captured!.delayMs).toBeGreaterThanOrEqual(600_000);
    expect(captured!.delayMs).toBeLessThanOrEqual(602_500);
  });

  test("delay <= 10min → используется как есть", async () => {
    mocks.acquireKey.mockRejectedValueOnce(new PoolExhaustedError("primary-prov", 5 * 60 * 1000)); // 5 min
    const submit = vi.fn();

    let captured: TestDelayedSentinel | null = null;
    try {
      await submitWithFallback({
        primaryModel: PRIMARY,
        fallbacks: [],
        section: "design",
        job: makeJob(),
        allowFiveXxFallback: false,
        submit,
      });
    } catch (e) {
      if (e instanceof TestDelayedSentinel) captured = e;
      else throw e;
    }

    // 5 min + jitter
    expect(captured!.delayMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(captured!.delayMs).toBeLessThanOrEqual(5 * 60 * 1000 + 2500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("submitWithFallback — return values & attempts tracking", () => {
  test("attempts list содержит все попытки в порядке (primary first, then fallback)", async () => {
    mocks.acquireKey
      .mockRejectedValueOnce(new PoolExhaustedError("primary-prov", 30000))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    const submit = vi.fn().mockResolvedValue("ok");

    const res = await submitWithFallback({
      primaryModel: PRIMARY,
      fallbacks: [FALLBACK_1],
      section: "design",
      job: makeJob(),
      allowFiveXxFallback: false,
      submit,
    });

    expect(res.attempts).toEqual([
      expect.objectContaining({ provider: "primary-prov", outcome: "pool_exhausted" }),
      expect.objectContaining({ provider: "fallback-1", outcome: "success" }),
    ]);
  });

  test("effectiveModel — это AIModel объект кандидата на котором success", async () => {
    mocks.acquireKey
      .mockRejectedValueOnce(new PoolExhaustedError("primary-prov", 30000))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    const submit = vi.fn().mockResolvedValue("ok");

    const res = await submitWithFallback({
      primaryModel: PRIMARY,
      fallbacks: [FALLBACK_1, FALLBACK_2],
      section: "design",
      job: makeJob(),
      allowFiveXxFallback: false,
      submit,
    });

    expect(res.effectiveModel).toBe(FALLBACK_1);
    expect(res.acquired.keyId).toBe("k-fb");
  });

  test("submit fn получает (model, acquired) для каждой попытки — model каждый раз новый", async () => {
    mocks.acquireKey
      .mockResolvedValueOnce(makeAcquiredKey("k-primary"))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    const longErr = Object.assign(new Error("daily quota exceeded"), { status: 429 });
    const submit = vi.fn().mockRejectedValueOnce(longErr).mockResolvedValueOnce("ok");

    await submitWithFallback({
      primaryModel: PRIMARY,
      fallbacks: [FALLBACK_1],
      section: "design",
      job: makeJob(),
      allowFiveXxFallback: false,
      submit,
    });

    expect(submit).toHaveBeenNthCalledWith(
      1,
      PRIMARY,
      expect.objectContaining({ keyId: "k-primary" }),
    );
    expect(submit).toHaveBeenNthCalledWith(
      2,
      FALLBACK_1,
      expect.objectContaining({ keyId: "k-fb" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("submitWithFallback — OpenAI billing exhaustion", () => {
  // Симметрия с KIE credits-exhausted веткой: не штрафуем ключ (это
  // account-wide состояние), шлём дедуп'ный алерт в balance-тему, идём к
  // следующему кандидату. При отсутствии fallback'а — all_candidates_failed
  // тоже летит в balance (а не в общий fallback-канал).

  test("400 billing_hard_limit_reached → openai_billing_exhausted, balance alert, NO recordError", async () => {
    mocks.acquireKey.mockResolvedValueOnce(makeAcquiredKey("k1"));
    const billingErr = Object.assign(new Error("400 Billing hard limit has been reached."), {
      code: "billing_hard_limit_reached",
      status: 400,
    });
    const submit = vi.fn().mockRejectedValue(billingErr);

    await expect(
      submitWithFallback({
        primaryModel: makeModel({ id: "gpt-image-1.5", provider: "openai" }),
        fallbacks: [],
        section: "image",
        job: makeJob(),
        allowFiveXxFallback: false,
        submit,
      }),
    ).rejects.toBe(billingErr);

    expect(mocks.notifyTechErrorThrottled).toHaveBeenCalledWith(
      billingErr,
      expect.objectContaining({ section: "image", modelId: "gpt-image-1.5" }),
      "openai-billing-exhaustion:k1",
      { channel: "balance" },
    );
    expect(mocks.recordError).not.toHaveBeenCalled();
    expect(mocks.markRateLimited).not.toHaveBeenCalled();
    expect(mocks.notifyFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "all_candidates_failed",
        channel: "balance",
      }),
    );
  });

  test("429 insufficient_quota → ловится billing-веткой, не rate-limit'ом", async () => {
    mocks.acquireKey.mockResolvedValueOnce(makeAcquiredKey("k1"));
    const quotaErr = Object.assign(new Error("429 You exceeded your current quota"), {
      code: "insufficient_quota",
      status: 429,
    });
    const submit = vi.fn().mockRejectedValue(quotaErr);

    await expect(
      submitWithFallback({
        primaryModel: makeModel({ id: "tts-openai", provider: "openai" }),
        fallbacks: [],
        section: "audio",
        job: makeJob(),
        allowFiveXxFallback: false,
        submit,
      }),
    ).rejects.toBe(quotaErr);

    expect(mocks.notifyTechErrorThrottled).toHaveBeenCalledWith(
      quotaErr,
      expect.any(Object),
      "openai-billing-exhaustion:k1",
      { channel: "balance" },
    );
    // Билинг-ветка интерсептит до rate-limit классификатора — ни ключ-throttle,
    // ни recordError не должны сработать.
    expect(mocks.recordError).not.toHaveBeenCalled();
    expect(mocks.markRateLimited).not.toHaveBeenCalled();
    expect(mocks.notifyRateLimit).not.toHaveBeenCalled();
  });

  test("billing на primary + успешный fallback → fallback используется, billing alert всё равно летит", async () => {
    mocks.acquireKey
      .mockResolvedValueOnce(makeAcquiredKey("k-primary"))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    const billingErr = Object.assign(new Error("400 Billing hard limit has been reached."), {
      code: "billing_hard_limit_reached",
      status: 400,
    });
    const submit = vi.fn().mockRejectedValueOnce(billingErr).mockResolvedValueOnce("fallback-ok");

    const res = await submitWithFallback({
      primaryModel: makeModel({ id: "gpt-image-1.5", provider: "openai" }),
      fallbacks: [makeModel({ id: "gpt-image-1.5", provider: "evolink" })],
      section: "image",
      job: makeJob(),
      allowFiveXxFallback: false,
      submit,
    });

    expect(res.result).toBe("fallback-ok");
    expect(res.usedFallback).toBe(true);
    expect(res.effectiveProvider).toBe("evolink");
    // billing alert летит даже при успешном fallback'е — оператор должен
    // увидеть что у primary биллинг пуст независимо от того, спас ли fallback.
    expect(mocks.notifyTechErrorThrottled).toHaveBeenCalledWith(
      billingErr,
      expect.any(Object),
      "openai-billing-exhaustion:k-primary",
      { channel: "balance" },
    );
    // Primary key не штрафуется
    expect(mocks.recordError).not.toHaveBeenCalledWith("k-primary", expect.anything());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("submitWithFallback — UserFacingError early-throw (validation)", () => {
  // Pre-flight адаптеров (Suno length, Cartesia empty transcript, Nano Banana
  // length и т.п.) бросает UserFacingError без notifyOps. Такие ошибки — это
  // юзерская валидация, fallback не лечит (один backend → один лимит), tech
  // не должен шуметь, ключ не штрафуется.

  test("UserFacingError без notifyOps → throw сразу, без fallback, без tech-alert, без recordError", async () => {
    mocks.acquireKey.mockResolvedValueOnce(makeAcquiredKey("k1"));
    const validationErr = new UserFacingError("Suno: prompt 980 > 500 chars", {
      key: "sunoPromptTooLongNoLyrics",
      params: { current: 980 },
    });
    const submit = vi.fn().mockRejectedValue(validationErr);

    await expect(
      submitWithFallback({
        primaryModel: makeModel({ id: "suno", provider: "kie" }),
        fallbacks: [makeModel({ id: "suno", provider: "apipass" })],
        section: "audio",
        job: makeJob(),
        allowFiveXxFallback: false,
        submit,
      }),
    ).rejects.toBe(validationErr);

    // Только primary попробован, fallback НЕ задействован.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(mocks.recordError).not.toHaveBeenCalled();
    expect(mocks.notifyTechErrorThrottled).not.toHaveBeenCalled();
    expect(mocks.notifyFallback).not.toHaveBeenCalled();
  });

  test("UserFacingError c notifyOps:true → попадает в обычный flow (fallback пробуется)", async () => {
    mocks.acquireKey
      .mockResolvedValueOnce(makeAcquiredKey("k-primary"))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    const providerErr = new UserFacingError("Suno API: credits insufficient", {
      key: "modelTemporarilyUnavailable",
      section: "audio",
      notifyOps: true,
      opsAlertDedupKey: "suno-credits-exhausted",
    });
    const submit = vi.fn().mockRejectedValueOnce(providerErr).mockResolvedValueOnce("fallback-ok");

    const res = await submitWithFallback({
      primaryModel: makeModel({ id: "suno", provider: "kie" }),
      fallbacks: [makeModel({ id: "suno", provider: "apipass" })],
      section: "audio",
      job: makeJob(),
      allowFiveXxFallback: false,
      submit,
    });

    // Fallback задействован (это provider-side issue, имеет смысл попробовать соседа)
    expect(res.result).toBe("fallback-ok");
    expect(res.usedFallback).toBe(true);
    expect(submit).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("submitWithFallback — transient network error", () => {
  // ENOTFOUND / ECONNRESET / ETIMEDOUT и т.п. — DNS/socket лёг у провайдера.
  // Ключ не виноват → НЕ recordError. Пробуем следующего кандидата (у него
  // может быть другой хост). Если все упали — caller (processor catch) защемит
  // через deferIfTransientNetworkError (до 3 раундов).

  test("ENOTFOUND на primary → пробует fallback, без recordError, без штрафа", async () => {
    mocks.acquireKey
      .mockResolvedValueOnce(makeAcquiredKey("k-primary"))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    const dnsErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND kieai.redpandaai.co"), {
        code: "ENOTFOUND",
      }),
    });
    const submit = vi.fn().mockRejectedValueOnce(dnsErr).mockResolvedValueOnce("fallback-ok");

    const res = await submitWithFallback({
      primaryModel: makeModel({ id: "nano-banana-pro", provider: "kie" }),
      fallbacks: [makeModel({ id: "nano-banana-pro", provider: "evolink" })],
      section: "image",
      job: makeJob(),
      allowFiveXxFallback: false,
      submit,
    });

    expect(res.result).toBe("fallback-ok");
    expect(res.usedFallback).toBe(true);
    expect(res.effectiveProvider).toBe("evolink");
    // Дедуп-алерт ушёл per-candidate (key network-transient:provider:code).
    expect(mocks.notifyTechErrorThrottled).toHaveBeenCalledWith(
      dnsErr,
      expect.any(Object),
      "network-transient:kie:ENOTFOUND",
    );
    // Primary key не штрафуется на DNS-проблеме провайдера.
    expect(mocks.recordError).not.toHaveBeenCalledWith("k-primary", expect.anything());
  });

  test("ENOTFOUND на всех кандидатах → throw lastError (caller сделает defer-transient)", async () => {
    mocks.acquireKey
      .mockResolvedValueOnce(makeAcquiredKey("k-primary"))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    const dnsErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND example.com"), { code: "ENOTFOUND" }),
    });
    const submit = vi.fn().mockRejectedValue(dnsErr);

    await expect(
      submitWithFallback({
        primaryModel: makeModel({ id: "nano-banana-pro", provider: "kie" }),
        fallbacks: [makeModel({ id: "nano-banana-pro", provider: "evolink" })],
        section: "image",
        job: makeJob(),
        allowFiveXxFallback: false,
        submit,
      }),
    ).rejects.toBe(dnsErr);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(mocks.recordError).not.toHaveBeenCalled();
    // Notify per-candidate (2 алерта с разными provider в dedup-ключе).
    expect(mocks.notifyTechErrorThrottled).toHaveBeenCalledTimes(2);
    // notifyFallback(all_candidates_failed) НЕ должен звать на transient — иначе
    // на каждом retry-раунде (×3) был бы лишний алерт без дедупа в fallback-канал.
    // Per-candidate notifyTechErrorThrottled уже дедуп'нут (5/30мин), этого хватит.
    expect(mocks.notifyFallback).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("submitWithFallback — provider temporarily unavailable (infra)", () => {
  // "high demand" / "Service unavailable" / Cloudflare Tunnel error / etc. —
  // provider-wide инфра-проблема (узел перегружен, CDN edge упал). Ключ
  // здоровый, штрафовать его нельзя — это не его вина. Пробуем следующего
  // кандидата.

  test("high demand на primary → fallback пробуется, recordError НЕ вызван", async () => {
    mocks.acquireKey
      .mockResolvedValueOnce(makeAcquiredKey("k-primary"))
      .mockResolvedValueOnce(makeAcquiredKey("k-fb"));
    // KIE-style "high demand" — matched через isProviderTemporaryUnavailable.
    const overloadErr = new Error("KIE submit error 422: Service is currently unavailable");
    const submit = vi.fn().mockRejectedValueOnce(overloadErr).mockResolvedValueOnce("fallback-ok");

    const res = await submitWithFallback({
      primaryModel: makeModel({ id: "kling", provider: "kie" }),
      fallbacks: [makeModel({ id: "kling", provider: "evolink" })],
      section: "video",
      job: makeJob(),
      allowFiveXxFallback: false,
      submit,
    });

    expect(res.usedFallback).toBe(true);
    expect(res.effectiveProvider).toBe("evolink");
    // Главное: ключ primary НЕ штрафуется на инфра-проблеме провайдера.
    expect(mocks.recordError).not.toHaveBeenCalled();
  });
});
