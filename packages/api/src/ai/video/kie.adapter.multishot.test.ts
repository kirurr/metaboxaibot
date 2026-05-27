import { describe, test, expect, vi, beforeEach } from "vitest";

import { KieVideoAdapter } from "./kie.adapter.js";
import type { VideoInput } from "./base.adapter.js";

/**
 * Замокать globalThis.fetch для createTask. Мультишот без кадров/элементов не
 * грузит файлы — единственный сетевой вызов это POST createTask, его и ловим.
 */
function mockCreateTaskFetch() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchFn = vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 200, msg: "success", data: { taskId: "task-1" } }),
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

describe("KieVideoAdapter — Kling multi-shot", () => {
  test("builds multi_prompt, multi_shots:true, duration = sum, no top-level prompt", async () => {
    const { calls, fetchFn } = mockCreateTaskFetch();
    const adapter = new KieVideoAdapter("kling", "test-key", fetchFn);

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
          generate_audio: true,
        },
      }),
    );

    const input = calls[0]!.body.input as Record<string, unknown>;
    expect(calls[0]!.body.model).toBe("kling-3.0/video");
    expect(input.multi_shots).toBe(true);
    expect(input.prompt).toBeUndefined();
    expect(input.multi_prompt).toEqual([
      { prompt: "a happy dog running", duration: 3 },
      { prompt: "the dog plays with a cat", duration: 4 },
    ]);
    // total = 3 + 4 = 7
    expect(input.duration).toBe("7");
    expect(input.mode).toBe("std");
  });

  test("multishot ignores last_frame (only first frame supported)", async () => {
    const { calls, fetchFn } = mockCreateTaskFetch();
    const adapter = new KieVideoAdapter("kling-pro", "test-key", fetchFn);

    await adapter.submit(
      baseInput({
        modelSettings: {
          multishot: true,
          shots: [{ prompt: "scene one", duration: 5 }],
        },
        mediaInputs: { last_frame: ["https://only-last.png"] },
      }),
    );

    const input = calls[0]!.body.input as Record<string, unknown>;
    // last_frame без first_frame в single-shot бросает ошибку, а в multishot
    // просто игнорируется — submit доходит до createTask.
    expect(input.multi_shots).toBe(true);
    expect(input.mode).toBe("pro");
  });

  test("single-shot regression: multi_shots:false, prompt set, no multi_prompt", async () => {
    const { calls, fetchFn } = mockCreateTaskFetch();
    const adapter = new KieVideoAdapter("kling", "test-key", fetchFn);

    await adapter.submit(
      baseInput({
        prompt: "a single-shot clip",
        modelSettings: { duration: 6, aspect_ratio: "9:16" },
      }),
    );

    const input = calls[0]!.body.input as Record<string, unknown>;
    expect(input.multi_shots).toBe(false);
    expect(input.multi_prompt).toBeUndefined();
    expect(input.prompt).toBe("a single-shot clip");
    expect(input.duration).toBe("6");
  });
});

describe("KieVideoAdapter.validateRequest — multi-shot bounds", () => {
  const adapter = new KieVideoAdapter("kling", "test-key");
  const ms = (shots: unknown) => ({ modelSettings: { multishot: true, shots } });

  test("rejects empty shot list", () => {
    expect(adapter.validateRequest(baseInput(ms([]))!)?.key).toBe("multishotEmpty");
  });

  test("rejects more than 5 shots", () => {
    const shots = Array.from({ length: 6 }, () => ({ prompt: "x", duration: 2 }));
    expect(adapter.validateRequest(baseInput(ms(shots))!)?.key).toBe("multishotTooManyShots");
  });

  test("rejects empty shot prompt", () => {
    expect(adapter.validateRequest(baseInput(ms([{ prompt: "  ", duration: 3 }]))!)?.key).toBe(
      "multishotEmptyShotPrompt",
    );
  });

  test("rejects shot duration out of 1..12", () => {
    expect(adapter.validateRequest(baseInput(ms([{ prompt: "x", duration: 13 }]))!)?.key).toBe(
      "multishotShotDurationOutOfRange",
    );
  });

  test("rejects total duration out of 3..15", () => {
    const shots = [
      { prompt: "a", duration: 8 },
      { prompt: "b", duration: 9 },
    ];
    expect(adapter.validateRequest(baseInput(ms(shots))!)?.key).toBe(
      "multishotTotalDurationOutOfRange",
    );
  });

  test("accepts a valid shot list", () => {
    const shots = [
      { prompt: "a", duration: 3 },
      { prompt: "b", duration: 4 },
    ];
    expect(adapter.validateRequest(baseInput(ms(shots))!)).toBeNull();
  });
});
