/**
 * Wraps a provider `submit()` call with a per-model throttle gate.
 *
 * Why this exists: our staged BullMQ pattern (submit → exit → poll → exit → poll …)
 * means worker concurrency slots aren't held across long-running provider
 * generations. So a naive `concurrency: 2` on the BullMQ Worker can still drive
 * a provider's parallel-job ceiling into the ground. This helper introduces a
 * Redis-backed cooldown gate keyed per `modelId` so that:
 *
 *  1. Before submitting, we check the gate. If active, we defer **the same**
 *     BullMQ job via `moveToDelayed` (preserving its `jobId = dbJobId`) and
 *     throw `DelayedError`. The processor's outer catch rethrows it and
 *     BullMQ moves the job to the delayed set without marking it failed.
 *
 *  2. If the submit itself throws a rate-limit / concurrency error, the helper
 *     trips the gate, fires a one-time tech-channel notification (the Redis
 *     `SET … NX` makes "first tripper wins" atomic), and then either:
 *
 *      - defers the job (short-window cooldown), or
 *      - throws `RateLimitLongWindowError` (long-window quota — the processor
 *        maps it to a localised "model temporarily unavailable" reply).
 */

import type { Job, Queue } from "bullmq";
import {
  checkThrottle,
  tripThrottle,
  markProviderLongCooldown,
} from "@metabox/api/services/throttle";
import { classifyRateLimit, LONG_WINDOW_THRESHOLD_MS } from "@metabox/api/utils/rate-limit-error";
import { markRateLimited, recordSuccess, recordError } from "@metabox/api/services/key-pool";
import { isOpenAiBillingExhaustion } from "@metabox/api/utils/openai-billing-error";
import { UserFacingError } from "@metabox/shared";
import { notifyRateLimit, notifyTechErrorThrottled } from "./notify-error.js";
import { delayJob } from "./delay-job.js";
import { logger } from "../logger.js";

export class RateLimitLongWindowError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly cooldownMs: number,
  ) {
    super(`Long-window rate limit for ${modelId} (cooldown=${cooldownMs}ms)`);
    this.name = "RateLimitLongWindowError";
  }
}

export function isRateLimitLongWindowError(err: unknown): err is RateLimitLongWindowError {
  return err instanceof RateLimitLongWindowError;
}

interface SubmitWithThrottleOptions<T, D> {
  modelId: string;
  /** Provider key for cooldown lookup (e.g. "fal", "runway"). Falls back to default if unknown. */
  provider?: string;
  /** Section label used in tech notifications ("video" | "image" | …). */
  section: string;
  /** The current BullMQ job — used to defer via moveToDelayed if rate-limited. */
  job: Job<D>;
  /**
   * BullMQ worker token for the current job. Required for `moveToDelayed`.
   * Forward from the second arg of the processor function.
   */
  token?: string;
  /**
   * The queue this job belongs to. Kept in the API for symmetry with other
   * helpers; not used directly anymore (deferral is via `job.moveToDelayed`).
   */
  queue?: Queue;
  /** Job name to use when re-enqueueing (defaults to "generate"). */
  jobName?: string;
  /**
   * ID ключа из ProviderKey-пула. Если задан — при 429 throttle ставится
   * на ключ (не на модель), чтобы остальные ключи провайдера продолжали работу.
   * null/undefined → трипается model-gate (env-fallback режим).
   */
  keyId?: string | null;
  /** The actual provider submit call. */
  submit: () => Promise<T>;
}

const MIN_DEFER_MS = 1_000;
const JITTER_MS = 2_000;

function withJitter(ms: number): number {
  return Math.max(MIN_DEFER_MS, ms + Math.floor(Math.random() * JITTER_MS));
}

export async function submitWithThrottle<T, D extends object>(
  opts: SubmitWithThrottleOptions<T, D>,
): Promise<T> {
  const { modelId, provider, section, job, submit, keyId, token } = opts;

  // 1. Pre-check the model-level gate (legacy; protects env-fallback case).
  // Per-key gate is pre-checked inside KeyPool.acquireKey before we get here.
  if (!keyId) {
    const status = await checkThrottle(modelId);
    if (status) {
      const delay = withJitter(status.remainingMs);
      logger.info(
        { modelId, delay, reason: status.reason },
        "submitWithThrottle: gate active, deferring job",
      );
      // Defers the SAME job (preserves jobId=dbJobId) — recovery & dedup keep working.
      // delayJob throws DelayedError; the throw below is unreachable but
      // restores TS's control-flow narrowing.
      await delayJob(job, job.data as Record<string, unknown>, delay, token);
      throw new Error("unreachable: delayJob did not throw");
    }
  }

  // 2. Try the submit.
  try {
    const result = await submit();
    if (keyId) void recordSuccess(keyId);
    return result;
  } catch (err) {
    // OpenAI billing-исчерпание (`billing_hard_limit_reached` 400 или
    // `insufficient_quota` 429) — account-wide состояние. НЕ recordError'им
    // ключ (это не сбой ключа, кончились деньги org/project), не пенализим
    // markRateLimited (для 429 он бы прибил ключ на 1ч из-за паттерна
    // /exceeded your current quota/). Дедуп'ный алерт в balance-тему +
    // throw наверх — processor покажет user-facing "временно недоступна".
    if (isOpenAiBillingExhaustion(err)) {
      const dedupKey = keyId ? `openai-billing-exhaustion:${keyId}` : "openai-billing-exhaustion";
      void notifyTechErrorThrottled(
        err instanceof Error ? err : new Error(String(err)),
        { section, modelId, jobId: job.id },
        dedupKey,
        { channel: "balance" },
      );
      throw err;
    }

    const cls = classifyRateLimit(err, provider);
    if (!cls.isRateLimit) {
      // UserFacingError (адаптер отказался обрабатывать ввод: пустой
      // transcript, content policy и т.п.) — НЕ штрафуем ключ, он здоров.
      if (keyId && !(err instanceof UserFacingError)) {
        void recordError(keyId, err instanceof Error ? err.message : String(err));
      }
      throw err;
    }

    // Per-key trip when KeyPool supplied a keyId — isolates bad key, other keys keep flowing.
    // Per-model trip as fallback for env-only case.
    let tripped: boolean;
    if (keyId) {
      await markRateLimited(keyId, cls.cooldownMs, cls.reason);
      tripped = true;
    } else {
      tripped = await tripThrottle(modelId, cls.cooldownMs, cls.reason);
    }

    if (tripped) {
      await notifyRateLimit({
        section,
        modelId,
        cooldownMs: cls.cooldownMs,
        reason: cls.reason,
        isLongWindow: cls.isLongWindow,
        err,
      });
    }

    // Provider-wide outage: cooldownMs реально длинный (> 1ч из Retry-After
    // или подобного explicit-сигнала). Ставим provider-wide маркер и фейлим
    // job — fallback-логика покажет user-facing "временно недоступна".
    if (cls.cooldownMs > LONG_WINDOW_THRESHOLD_MS) {
      if (provider) {
        void markProviderLongCooldown(provider, cls.cooldownMs, cls.reason);
      }
      logger.warn(
        { modelId, keyId, cooldownMs: cls.cooldownMs, reason: cls.reason },
        "submitWithThrottle: provider-wide long-window quota — failing job",
      );
      throw new RateLimitLongWindowError(modelId, cls.cooldownMs);
    }

    // Pattern-matched long-window per-account quota (Google billing, "out of
    // credits", "trial limit" и т.п.) ИЛИ short-window 429 — defer'им SHORT,
    // чтобы BullMQ retry попал в acquireKey'ем; priority-логика skip'нет
    // throttled key#1 и возьмёт другой ключ из пула. Если все ключи throttled —
    // acquireForSubmit поймает PoolExhaustedError и defer'нет на actual cooldown.
    //
    // До фикса: defer был на cooldownMs (для long-window — 1ч), что заставляло
    // юзера ждать час даже когда соседний ключ свободен.
    const isPatternLongWindow = cls.isLongWindow;
    const delay = isPatternLongWindow ? withJitter(MIN_DEFER_MS) : withJitter(cls.cooldownMs);
    logger.info(
      {
        modelId,
        keyId,
        delay,
        cooldownMs: cls.cooldownMs,
        isLongWindow: cls.isLongWindow,
        reason: cls.reason,
      },
      isPatternLongWindow
        ? "submitWithThrottle: per-key long-window quota — deferring short to retry with fresh key"
        : "submitWithThrottle: rate-limited, deferring job",
    );
    await delayJob(job, job.data as Record<string, unknown>, delay, token);
    throw new Error("unreachable: delayJob did not throw");
  }
}
