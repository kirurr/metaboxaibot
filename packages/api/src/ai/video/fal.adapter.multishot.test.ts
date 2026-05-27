import { describe, test, expect, vi, beforeEach } from "vitest";

/**
 * FAL использует @fal-ai/client SDK (не global fetch), поэтому ловим payload
 * через мок `fal.queue.submit`. `vi.hoisted` нужен, чтобы submitMock существовал
 * на момент вычисления фабрики vi.mock (она поднимается над импортами).
 */
const { submitMock, configMock } = vi.hoisted(() => ({
  submitMock: vi.fn(),
  configMock: vi.fn(),
}));

vi.mock("@fal-ai/client", () => ({
  fal: {
    config: configMock,
    queue: {
      submit: submitMock,
      status: vi.fn(),
      result: vi.fn(),
    },
  },
}));

import { FalVideoAdapter } from "./fal.adapter.js";
import type { VideoInput } from "./base.adapter.js";

const baseInput = (overrides: Partial<VideoInput> = {}): VideoInput => ({
  prompt: "",
  ...overrides,
});

/** Извлечь { endpoint, input } последнего вызова fal.queue.submit. */
function lastSubmit(): { endpoint: string; input: Record<string, unknown> } {
  const call = submitMock.mock.calls.at(-1);
  if (!call) throw new Error("fal.queue.submit was not called");
  return {
    endpoint: call[0] as string,
    input: (call[1] as { input: Record<string, unknown> }).input,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  submitMock.mockResolvedValue({ request_id: "req-1" });
});

describe("FalVideoAdapter — Kling-o3 multi-shot", () => {
  test("t2v: builds multi_prompt (string durations) + shot_type, no top-level prompt, duration = sum", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");

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

    const { endpoint, input } = lastSubmit();
    expect(endpoint).toBe("fal-ai/kling-video/o3/standard/text-to-video");
    expect(input.prompt).toBeUndefined();
    expect(input.shot_type).toBe("customize");
    expect(input.multi_prompt).toEqual([
      { prompt: "a happy dog running", duration: "3" },
      { prompt: "the dog plays with a cat", duration: "4" },
    ]);
    // total = 3 + 4 = 7, строкой
    expect(input.duration).toBe("7");
  });

  test("i2v: keeps end_image_url alongside multi_prompt", async () => {
    const adapter = new FalVideoAdapter("kling-pro", "test-key");

    await adapter.submit(
      baseInput({
        modelSettings: {
          multishot: true,
          shots: [{ prompt: "scene one", duration: 5 }],
        },
        mediaInputs: {
          first_frame: ["https://start.png"],
          last_frame: ["https://end.png"],
        },
      }),
    );

    const { endpoint, input } = lastSubmit();
    expect(endpoint).toBe("fal-ai/kling-video/o3/pro/image-to-video");
    expect(input.image_url).toBe("https://start.png");
    expect(input.end_image_url).toBe("https://end.png");
    expect(input.shot_type).toBe("customize");
    expect((input.multi_prompt as unknown[]).length).toBe(1);
    expect(input.prompt).toBeUndefined();
    expect(input.duration).toBe("5");
  });

  test("single-shot regression: prompt set, no multi_prompt / shot_type", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");

    await adapter.submit(
      baseInput({
        prompt: "a single-shot clip",
        modelSettings: { duration: 6, aspect_ratio: "9:16" },
      }),
    );

    const { input } = lastSubmit();
    expect(input.prompt).toBe("a single-shot clip");
    expect(input.multi_prompt).toBeUndefined();
    expect(input.shot_type).toBeUndefined();
    expect(input.duration).toBe("6");
  });

  test("empty shots fall back to single-prompt behaviour (no multi_prompt)", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");

    await adapter.submit(
      baseInput({
        prompt: "fallback prompt",
        modelSettings: { multishot: true, shots: [] },
      }),
    );

    const { input } = lastSubmit();
    expect(input.multi_prompt).toBeUndefined();
    expect(input.shot_type).toBeUndefined();
    expect(input.prompt).toBe("fallback prompt");
  });
});

describe("FalVideoAdapter.validateRequest — multi-shot bounds", () => {
  const adapter = new FalVideoAdapter("kling", "test-key");
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
