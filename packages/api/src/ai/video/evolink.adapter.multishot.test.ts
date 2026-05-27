import { describe, test, expect, vi, beforeEach } from "vitest";

import { EvolinkVideoAdapter } from "./evolink.adapter.js";
import type { VideoInput } from "./base.adapter.js";

/**
 * EvolinkVideoAdapter зовёт `fetchWithLog(url, init, this.fetchFn)`, который
 * форвардит (url, init) в переданный fetchFn. Передаём мок 3-м аргументом
 * конструктора и ловим тело submit-запроса.
 */
function mockSubmitFetch() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "task-1", status: "pending" }),
      text: async () => "",
    } as unknown as Response;
  });
  return { calls, fetchFn: fetchFn as unknown as typeof globalThis.fetch };
}

const baseInput = (overrides: Partial<VideoInput> = {}): VideoInput => ({
  prompt: "",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EvolinkVideoAdapter — Kling-o3 multi-shot", () => {
  test("t2v: model_params.multi_shot, string per-shot durations, empty prompt, duration = sum", async () => {
    const { calls, fetchFn } = mockSubmitFetch();
    const adapter = new EvolinkVideoAdapter("kling", "test-key", fetchFn);

    await adapter.submit(
      baseInput({
        prompt: "ignored single prompt",
        modelSettings: {
          multishot: true,
          shots: [
            { prompt: "a happy dog running", duration: 3 },
            { prompt: "the dog plays with a cat", duration: 4 },
          ],
          aspect_ratio: "16:9",
        },
      }),
    );

    const body = calls[0]!.body;
    expect(body.model).toBe("kling-o3-text-to-video");
    expect(body.prompt).toBe("");
    expect(body.duration).toBe(7); // 3 + 4, число
    const mp = body.model_params as Record<string, unknown>;
    expect(mp.multi_shot).toBe(true);
    expect(mp.shot_type).toBe("customize");
    expect(mp.multi_prompt).toEqual([
      { index: 1, prompt: "a happy dog running", duration: "3" },
      { index: 2, prompt: "the dog plays with a cat", duration: "4" },
    ]);
  });

  test("i2v: keeps image_start alongside model_params multi_shot", async () => {
    const { calls, fetchFn } = mockSubmitFetch();
    const adapter = new EvolinkVideoAdapter("kling-pro", "test-key", fetchFn);

    await adapter.submit(
      baseInput({
        modelSettings: {
          multishot: true,
          shots: [{ prompt: "scene one", duration: 5 }],
        },
        mediaInputs: { first_frame: ["https://start.png"] },
      }),
    );

    const body = calls[0]!.body;
    expect(body.model).toBe("kling-o3-image-to-video");
    expect(body.image_start).toBe("https://start.png");
    expect(body.prompt).toBe("");
    expect(body.duration).toBe(5);
    expect((body.model_params as Record<string, unknown>).multi_shot).toBe(true);
  });

  test("single-shot regression: no model_params, prompt set, duration clamped", async () => {
    const { calls, fetchFn } = mockSubmitFetch();
    const adapter = new EvolinkVideoAdapter("kling", "test-key", fetchFn);

    await adapter.submit(
      baseInput({
        prompt: "a single-shot clip",
        modelSettings: { duration: 6, aspect_ratio: "9:16" },
      }),
    );

    const body = calls[0]!.body;
    expect(body.model).toBe("kling-o3-text-to-video");
    expect(body.prompt).toBe("a single-shot clip");
    expect(body.model_params).toBeUndefined();
    expect(body.duration).toBe(6);
  });

  test("empty shots fall back to single-prompt behaviour", async () => {
    const { calls, fetchFn } = mockSubmitFetch();
    const adapter = new EvolinkVideoAdapter("kling", "test-key", fetchFn);

    await adapter.submit(
      baseInput({
        prompt: "fallback prompt",
        modelSettings: { multishot: true, shots: [] },
      }),
    );

    const body = calls[0]!.body;
    expect(body.model_params).toBeUndefined();
    expect(body.prompt).toBe("fallback prompt");
  });
});

describe("EvolinkVideoAdapter.validateRequest — multi-shot bounds", () => {
  const adapter = new EvolinkVideoAdapter("kling", "test-key");
  const ms = (shots: unknown) => baseInput({ modelSettings: { multishot: true, shots } });

  test("rejects empty shot list", () => {
    expect(adapter.validateRequest(ms([]))?.key).toBe("multishotEmpty");
  });

  test("rejects more than 5 shots", () => {
    const shots = Array.from({ length: 6 }, () => ({ prompt: "x", duration: 2 }));
    expect(adapter.validateRequest(ms(shots))?.key).toBe("multishotTooManyShots");
  });

  test("rejects empty shot prompt", () => {
    expect(adapter.validateRequest(ms([{ prompt: "  ", duration: 3 }]))?.key).toBe(
      "multishotEmptyShotPrompt",
    );
  });

  test("rejects shot duration out of 1..12", () => {
    expect(adapter.validateRequest(ms([{ prompt: "x", duration: 13 }]))?.key).toBe(
      "multishotShotDurationOutOfRange",
    );
  });

  test("rejects total duration out of 3..15", () => {
    const shots = [
      { prompt: "a", duration: 8 },
      { prompt: "b", duration: 9 },
    ];
    expect(adapter.validateRequest(ms(shots))?.key).toBe("multishotTotalDurationOutOfRange");
  });

  test("accepts a valid shot list", () => {
    const shots = [
      { prompt: "a", duration: 3 },
      { prompt: "b", duration: 4 },
    ];
    expect(adapter.validateRequest(ms(shots))).toBeNull();
  });

  test("returns null for non-multishot request", () => {
    expect(adapter.validateRequest(baseInput({ prompt: "hi", modelSettings: {} }))).toBeNull();
  });
});
