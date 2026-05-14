import { describe, test, expect, vi, beforeEach } from "vitest";

// vi.hoisted: спаи должны существовать ДО того как hoisted vi.mock factory
// выполнятся. Мокаем key-pool / key-provider, чтобы resolveElKey() не лез в БД.
const { acquireKeySpy, envKeySpy } = vi.hoisted(() => ({
  acquireKeySpy: vi.fn(),
  envKeySpy: vi.fn(),
}));
vi.mock("../../services/key-pool.service.js", () => ({
  acquireKey: acquireKeySpy,
}));
vi.mock("../key-provider.js", () => ({
  envKeyForProvider: envKeySpy,
}));

import { KieElevenLabsAdapter } from "./kie-elevenlabs.adapter.js";
import type { AudioInput } from "./base.adapter.js";
import { UserFacingError } from "@metabox/shared";
import { PoolExhaustedError } from "../../utils/pool-exhausted-error.js";

/** Premade-голос ElevenLabs (Rachel) — ElevenLabsAdapter берёт его, когда voice не задан. */
const EL_DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Двоичный аудио-ответ (как от ElevenLabs TTS / sound-generation). */
function audioResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
}

interface MockRoutes {
  kieSubmit?: () => Response | Promise<Response>;
  kiePoll?: () => Response | Promise<Response>;
  elTts?: (voiceId: string) => Response | Promise<Response>;
  elSound?: () => Response | Promise<Response>;
}

/**
 * Роутящий мок fetch — диспатчит по URL на kie / ElevenLabs хендлеры и считает
 * вызовы. Один и тот же fetchFn прокидывается из KieElevenLabsAdapter в
 * ElevenLabsAdapter, поэтому покрывает оба провайдера.
 */
function createMockFetch(routes: MockRoutes) {
  const calls = { kieSubmit: 0, kiePoll: 0, elTts: [] as string[], elSound: 0 };
  const fn = (async (url: unknown): Promise<Response> => {
    const u = String(url);
    if (u.includes("/jobs/createTask")) {
      calls.kieSubmit++;
      if (!routes.kieSubmit) throw new Error("unexpected kie createTask call");
      return routes.kieSubmit();
    }
    if (u.includes("/jobs/recordInfo")) {
      calls.kiePoll++;
      if (!routes.kiePoll) throw new Error("unexpected kie recordInfo call");
      return routes.kiePoll();
    }
    if (u.includes("/text-to-speech/")) {
      const voiceId = u.split("/text-to-speech/")[1].split("?")[0];
      calls.elTts.push(voiceId);
      if (!routes.elTts) throw new Error("unexpected ElevenLabs TTS call");
      return routes.elTts(voiceId);
    }
    if (u.includes("/sound-generation")) {
      calls.elSound++;
      if (!routes.elSound) throw new Error("unexpected ElevenLabs sound call");
      return routes.elSound();
    }
    throw new Error(`unrouted fetch: ${u}`);
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

const baseInput = (overrides: Partial<AudioInput> = {}): AudioInput => ({
  prompt: "test prompt",
  ...overrides,
});

beforeEach(() => {
  acquireKeySpy.mockReset();
  envKeySpy.mockReset();
  // По умолчанию EL-ключ резолвится из пула.
  acquireKeySpy.mockResolvedValue({ keyId: "el-key-1", apiKey: "test-el-key", proxy: null });
  envKeySpy.mockReturnValue("test-el-env-key");
});

describe("KieElevenLabsAdapter — submit()", () => {
  test("kie 200 → возвращает реальный taskId", async () => {
    const { fn, calls } = createMockFetch({
      kieSubmit: () => jsonResponse({ code: 200, msg: "ok", data: { taskId: "kie-task-abc" } }),
    });
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    expect(await adapter.submit(baseInput())).toBe("kie-task-abc");
    expect(calls.kieSubmit).toBe(1);
  });

  test("kie HTTP 500 → sentinel taskId", async () => {
    const { fn } = createMockFetch({
      kieSubmit: () => new Response("internal error", { status: 500 }),
    });
    const adapter = new KieElevenLabsAdapter("sounds-el", "test-kie-key", fn);
    expect(await adapter.submit(baseInput())).toBe("el-fallback:http-500");
  });

  test("kie code 402 (HTTP 200 body) → sentinel taskId", async () => {
    const { fn } = createMockFetch({
      kieSubmit: () => jsonResponse({ code: 402, msg: "Insufficient Credits" }),
    });
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    expect(await adapter.submit(baseInput())).toBe("el-fallback:code-402");
  });

  test("kie сетевая ошибка → sentinel taskId", async () => {
    const { fn } = createMockFetch({
      kieSubmit: () => {
        throw new Error("ECONNRESET");
      },
    });
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    expect(await adapter.submit(baseInput())).toBe("el-fallback:error");
  });

  test("промпт > 5000 символов → UserFacingError, kie не дёргается (не фолбэк)", async () => {
    const { fn, calls } = createMockFetch({});
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    await expect(adapter.submit(baseInput({ prompt: "x".repeat(5001) }))).rejects.toBeInstanceOf(
      UserFacingError,
    );
    expect(calls.kieSubmit).toBe(0);
  });
});

describe("KieElevenLabsAdapter — poll() kie-путь", () => {
  test("kie success → результат с kie-URL, без actualProvider", async () => {
    const { fn } = createMockFetch({
      kiePoll: () =>
        jsonResponse({
          code: 200,
          msg: "ok",
          data: {
            state: "success",
            resultJson: JSON.stringify({ resultUrls: ["https://cdn.example/r.mp3"] }),
          },
        }),
    });
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    const result = await adapter.poll("kie-task-1", baseInput());
    expect(result).toEqual({
      url: "https://cdn.example/r.mp3",
      ext: "mp3",
      contentType: "audio/mpeg",
    });
    expect(result?.actualProvider).toBeUndefined();
  });

  test("kie state waiting → null", async () => {
    const { fn } = createMockFetch({
      kiePoll: () => jsonResponse({ code: 200, msg: "ok", data: { state: "waiting" } }),
    });
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    expect(await adapter.poll("kie-task-1", baseInput())).toBeNull();
  });

  test("ошибка самого poll-запроса (HTTP 502) → throw, БЕЗ фолбэка", async () => {
    const { fn, calls } = createMockFetch({
      kiePoll: () => new Response("bad gateway", { status: 502 }),
    });
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    await expect(adapter.poll("kie-task-1", baseInput())).rejects.toThrow(/poll error 502/);
    expect(calls.elTts.length).toBe(0);
  });

  test("HTTP 200 но body code !== 200 → throw, БЕЗ фолбэка", async () => {
    const { fn, calls } = createMockFetch({
      kiePoll: () => jsonResponse({ code: 500, msg: "server busy" }),
    });
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    await expect(adapter.poll("kie-task-1", baseInput())).rejects.toThrow(/poll failed: 500/);
    expect(calls.elTts.length).toBe(0);
  });
});

describe("KieElevenLabsAdapter — poll() EL-фолбэк", () => {
  test("sentinel taskId → генерит через ElevenLabs, ставит actualProvider", async () => {
    const { fn, calls } = createMockFetch({ elTts: () => audioResponse() });
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    const result = await adapter.poll(
      "el-fallback:http-500",
      baseInput({ modelSettings: { voice_id: "REALVOICE" } }),
    );
    expect(result?.actualProvider).toBe("elevenlabs");
    expect(result?.buffer).toBeInstanceOf(Buffer);
    expect(result?.ext).toBe("mp3");
    // Попытка 1 идёт с реальным голосом юзера.
    expect(calls.elTts).toEqual(["REALVOICE"]);
    expect(acquireKeySpy).toHaveBeenCalledWith("elevenlabs");
  });

  test("kie state:fail failCode 500 → EL-фолбэк", async () => {
    const { fn, calls } = createMockFetch({
      kiePoll: () =>
        jsonResponse({
          code: 200,
          msg: "ok",
          data: { state: "fail", failCode: "500", failMsg: "internal error" },
        }),
      elTts: () => audioResponse(),
    });
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    const result = await adapter.poll(
      "kie-task-1",
      baseInput({ modelSettings: { voice_id: "V1" } }),
    );
    expect(result?.actualProvider).toBe("elevenlabs");
    expect(calls.elTts).toEqual(["V1"]);
  });

  test("kie state:fail failCode 501 (модерация) → UserFacingError, EL не вызван", async () => {
    const { fn, calls } = createMockFetch({
      kiePoll: () =>
        jsonResponse({
          code: 200,
          msg: "ok",
          data: { state: "fail", failCode: "501", failMsg: "content blocked" },
        }),
    });
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    await expect(adapter.poll("kie-task-1", baseInput())).rejects.toBeInstanceOf(UserFacingError);
    expect(calls.elTts.length).toBe(0);
    expect(calls.elSound).toBe(0);
  });

  test("kie state:fail модерация по regex (без 501) → UserFacingError, EL не вызван", async () => {
    const { fn, calls } = createMockFetch({
      kiePoll: () =>
        jsonResponse({
          code: 200,
          msg: "ok",
          data: { state: "fail", failCode: "400", failMsg: "prompt rejected: policy violation" },
        }),
    });
    const adapter = new KieElevenLabsAdapter("sounds-el", "test-kie-key", fn);
    await expect(adapter.poll("kie-task-1", baseInput())).rejects.toBeInstanceOf(UserFacingError);
    expect(calls.elSound).toBe(0);
  });

  test("kie state:fail без input → throw plain Error (legacy in-flight джоба)", async () => {
    const { fn, calls } = createMockFetch({
      kiePoll: () =>
        jsonResponse({
          code: 200,
          msg: "ok",
          data: { state: "fail", failCode: "500", failMsg: "internal error" },
        }),
    });
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    const err = await adapter.poll("kie-task-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UserFacingError);
    expect(String(err)).toMatch(/no input for EL fallback/);
    expect(calls.elTts.length).toBe(0);
  });

  test("sentinel taskId без input → throw plain Error", async () => {
    const { fn } = createMockFetch({});
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    await expect(adapter.poll("el-fallback:error")).rejects.toThrow(/no input/);
  });
});

describe("KieElevenLabsAdapter — userfacing-ошибки не фолбэчатся", () => {
  test("sounds-el: EL вернул text_too_long → UserFacingError пробрасывается (не глотается)", async () => {
    const { fn, calls } = createMockFetch({
      elSound: () =>
        new Response(
          JSON.stringify({
            detail: { code: "text_too_long", message: "maximum 450 characters ... received 500" },
          }),
          { status: 400 },
        ),
    });
    const adapter = new KieElevenLabsAdapter("sounds-el", "test-kie-key", fn);
    await expect(
      adapter.poll("el-fallback:error", baseInput({ prompt: "x".repeat(500) })),
    ).rejects.toBeInstanceOf(UserFacingError);
    expect(calls.elSound).toBe(1);
  });
});

describe("KieElevenLabsAdapter — tts-el try-real-then-default", () => {
  test("попытка 1 (реальный голос) plain-падает → попытка 2 с premade-голосом EL", async () => {
    let n = 0;
    const { fn, calls } = createMockFetch({
      elTts: () => {
        n++;
        if (n === 1) return new Response("voice not found", { status: 400 });
        return audioResponse();
      },
    });
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    const result = await adapter.poll(
      "el-fallback:error",
      baseInput({ modelSettings: { voice_id: "KIE_VOICE_X" } }),
    );
    expect(result?.actualProvider).toBe("elevenlabs");
    expect(calls.elTts).toEqual(["KIE_VOICE_X", EL_DEFAULT_VOICE_ID]);
  });

  test("обе попытки упали → пробрасывается ошибка попытки 2", async () => {
    const { fn, calls } = createMockFetch({
      elTts: () => new Response("server error", { status: 500 }),
    });
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn);
    await expect(
      adapter.poll("el-fallback:error", baseInput({ modelSettings: { voice_id: "V" } })),
    ).rejects.toThrow(/ElevenLabs TTS failed: 500/);
    expect(calls.elTts.length).toBe(2);
  });
});

describe("KieElevenLabsAdapter — resolveElKey()", () => {
  test("пул исчерпан → env-fallback", async () => {
    acquireKeySpy.mockRejectedValue(new PoolExhaustedError("elevenlabs", 0));
    envKeySpy.mockReturnValue("env-el-key");
    const { fn, calls } = createMockFetch({ elSound: () => audioResponse() });
    const adapter = new KieElevenLabsAdapter("music-el", "test-kie-key", fn);
    const result = await adapter.poll("el-fallback:error", baseInput());
    expect(result?.actualProvider).toBe("elevenlabs");
    expect(calls.elSound).toBe(1);
    expect(envKeySpy).toHaveBeenCalledWith("elevenlabs");
  });

  test("пул исчерпан И нет env-ключа → throw", async () => {
    acquireKeySpy.mockRejectedValue(new PoolExhaustedError("elevenlabs", 0));
    envKeySpy.mockReturnValue(undefined);
    const { fn } = createMockFetch({ elSound: () => audioResponse() });
    const adapter = new KieElevenLabsAdapter("music-el", "test-kie-key", fn);
    await expect(adapter.poll("el-fallback:error", baseInput())).rejects.toThrow(
      /fallback key unavailable/,
    );
  });
});

describe("KieElevenLabsAdapter — onFallback visibility callback", () => {
  test("успешный EL-фолбэк → onFallback(false) вызван один раз", async () => {
    const { fn } = createMockFetch({ elSound: () => audioResponse() });
    const onFallback = vi.fn();
    const adapter = new KieElevenLabsAdapter("sounds-el", "test-kie-key", fn, onFallback);
    const result = await adapter.poll("el-fallback:error", baseInput());
    expect(result?.actualProvider).toBe("elevenlabs");
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(false);
  });

  test("EL-фолбэк упал → onFallback(true) вызван, ошибка проброшена", async () => {
    const { fn } = createMockFetch({
      elSound: () => new Response("server error", { status: 500 }),
    });
    const onFallback = vi.fn();
    const adapter = new KieElevenLabsAdapter("sounds-el", "test-kie-key", fn, onFallback);
    await expect(adapter.poll("el-fallback:error", baseInput())).rejects.toThrow(
      /sound generation failed: 500/,
    );
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(true);
  });

  test("kie success без фолбэка → onFallback не вызван", async () => {
    const { fn } = createMockFetch({
      kiePoll: () =>
        jsonResponse({
          code: 200,
          msg: "ok",
          data: {
            state: "success",
            resultJson: JSON.stringify({ resultUrls: ["https://cdn.example/r.mp3"] }),
          },
        }),
    });
    const onFallback = vi.fn();
    const adapter = new KieElevenLabsAdapter("tts-el", "test-kie-key", fn, onFallback);
    await adapter.poll("kie-task-1", baseInput());
    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe("KieElevenLabsAdapter — EL quota_exceeded", () => {
  test("EL 401 quota_exceeded → UserFacingError(notifyOps), не plain Error", async () => {
    const { fn, calls } = createMockFetch({
      elSound: () =>
        new Response(
          JSON.stringify({
            detail: {
              status: "quota_exceeded",
              message: "This request exceeds your quota. You have 69 credits remaining.",
            },
          }),
          { status: 401 },
        ),
    });
    const onFallback = vi.fn();
    const adapter = new KieElevenLabsAdapter("sounds-el", "test-kie-key", fn, onFallback);
    const err = await adapter.poll("el-fallback:error", baseInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as UserFacingError).notifyOps).toBe(true);
    expect((err as UserFacingError).opsAlertDedupKey).toBe("elevenlabs-credits-exhausted");
    expect(calls.elSound).toBe(1);
    // фолбэк сработал и упал → onFallback(true)
    expect(onFallback).toHaveBeenCalledWith(true);
  });

  test("EL 401 не-quota (битый ключ) → остаётся plain Error", async () => {
    const { fn } = createMockFetch({
      elSound: () => new Response('{"detail":{"status":"invalid_api_key"}}', { status: 401 }),
    });
    const adapter = new KieElevenLabsAdapter("sounds-el", "test-kie-key", fn);
    const err = await adapter.poll("el-fallback:error", baseInput()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UserFacingError);
  });
});
