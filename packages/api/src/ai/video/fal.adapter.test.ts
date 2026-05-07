import { describe, test, expect, vi, beforeEach } from "vitest";

// vi.hoisted: гарантирует что submitSpy создаётся ДО hoisted vi.mock factory.
// Без этого — ReferenceError "Cannot access 'submitSpy' before initialization".
const { submitSpy } = vi.hoisted(() => ({
  submitSpy: vi.fn(async () => ({ request_id: "req-mock-123" })),
}));
vi.mock("@fal-ai/client", () => ({
  fal: {
    config: vi.fn(),
    queue: {
      submit: submitSpy,
      status: vi.fn(),
      result: vi.fn(),
    },
  },
}));

import { FalVideoAdapter } from "./fal.adapter.js";
import type { VideoInput } from "./base.adapter.js";

const baseInput = (overrides: Partial<VideoInput> = {}): VideoInput => ({
  prompt: "test prompt",
  ...overrides,
});

/** Извлекает (endpoint, input) из последнего вызова fal.queue.submit. */
function lastSubmit(): { endpoint: string; input: Record<string, unknown> } {
  const calls = submitSpy.mock.calls as unknown as Array<
    [string, { input: Record<string, unknown> }]
  >;
  const lastCall = calls[calls.length - 1];
  if (!lastCall) throw new Error("submitSpy was not called");
  return { endpoint: lastCall[0], input: lastCall[1].input };
}

beforeEach(() => {
  submitSpy.mockClear();
});

describe("FalVideoAdapter — Kling-O3 endpoint dispatch", () => {
  test("kling: pure text → text-to-video endpoint", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");
    await adapter.submit(baseInput({ prompt: "a cat" }));
    const { endpoint, input } = lastSubmit();
    expect(endpoint).toBe("fal-ai/kling-video/o3/standard/text-to-video");
    expect(input.prompt).toBe("a cat");
    expect(input.image_url).toBeUndefined();
    expect(input.start_image_url).toBeUndefined();
  });

  test("kling-pro: pure text → pro/text-to-video", async () => {
    const adapter = new FalVideoAdapter("kling-pro", "test-key");
    await adapter.submit(baseInput());
    expect(lastSubmit().endpoint).toBe("fal-ai/kling-video/o3/pro/text-to-video");
  });

  test("kling: first_frame → image-to-video, image_url required", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");
    await adapter.submit(baseInput({ mediaInputs: { first_frame: ["https://start.png"] } }));
    const { endpoint, input } = lastSubmit();
    expect(endpoint).toBe("fal-ai/kling-video/o3/standard/image-to-video");
    expect(input.image_url).toBe("https://start.png");
    expect(input.end_image_url).toBeUndefined();
  });

  test("kling: first + last frame → i2v с end_image_url", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");
    await adapter.submit(
      baseInput({
        mediaInputs: {
          first_frame: ["https://start.png"],
          last_frame: ["https://end.png"],
        },
      }),
    );
    const { endpoint, input } = lastSubmit();
    expect(endpoint).toBe("fal-ai/kling-video/o3/standard/image-to-video");
    expect(input.image_url).toBe("https://start.png");
    expect(input.end_image_url).toBe("https://end.png");
  });

  test("kling: ref_element_* → reference-to-video с elements array", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");
    await adapter.submit(
      baseInput({
        mediaInputs: {
          ref_element_1: ["https://e1-frontal.png", "https://e1-side.png"],
          ref_element_2: ["https://e2-frontal.png"],
        },
      }),
    );
    const { endpoint, input } = lastSubmit();
    expect(endpoint).toBe("fal-ai/kling-video/o3/standard/reference-to-video");
    const elements = input.elements as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(2);
    expect(elements[0]).toMatchObject({
      frontal_image_url: "https://e1-frontal.png",
      reference_image_urls: ["https://e1-side.png"],
    });
    // Element с одним image — frontal duplicated в reference_image_urls (FAL требует ≥1)
    expect(elements[1]).toMatchObject({
      frontal_image_url: "https://e2-frontal.png",
      reference_image_urls: ["https://e2-frontal.png"],
    });
  });

  test("kling: ref_element_ + start frame → r2v с start_image_url (не image_url)", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");
    await adapter.submit(
      baseInput({
        mediaInputs: {
          first_frame: ["https://start.png"],
          ref_element_1: ["https://e1.png"],
        },
      }),
    );
    const { endpoint, input } = lastSubmit();
    expect(endpoint).toBe("fal-ai/kling-video/o3/standard/reference-to-video");
    expect(input.start_image_url).toBe("https://start.png");
    expect(input.image_url).toBeUndefined();
  });

  test("kling: только last_frame (без start) → r2v (i2v требует start)", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");
    await adapter.submit(baseInput({ mediaInputs: { last_frame: ["https://end.png"] } }));
    const { endpoint, input } = lastSubmit();
    expect(endpoint).toBe("fal-ai/kling-video/o3/standard/reference-to-video");
    expect(input.start_image_url).toBeUndefined();
    expect(input.end_image_url).toBe("https://end.png");
  });

  test("kling: prompt @element1 → @Element1 remap для FAL", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");
    await adapter.submit({
      prompt: "@element1 walks past @element2",
      mediaInputs: {
        ref_element_1: ["https://a.png"],
        ref_element_2: ["https://b.png"],
      },
    });
    expect(lastSubmit().input.prompt).toBe("@Element1 walks past @Element2");
  });

  test("kling: duration → STRING enum '3'-'15' (FAL kling-o3 требует string)", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");
    await adapter.submit(baseInput({ modelSettings: { duration: 8 } }));
    expect(lastSubmit().input.duration).toBe("8");
  });

  test("kling: duration clamp 3-15", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");
    await adapter.submit(baseInput({ modelSettings: { duration: 30 } }));
    expect(lastSubmit().input.duration).toBe("15");

    await adapter.submit(baseInput({ modelSettings: { duration: 1 } }));
    expect(lastSubmit().input.duration).toBe("3");
  });

  test("kling: generate_audio → boolean (передаётся только если задан)", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");
    await adapter.submit(baseInput({ modelSettings: { generate_audio: false } }));
    expect(lastSubmit().input.generate_audio).toBe(false);

    await adapter.submit(baseInput({ modelSettings: { generate_audio: true } }));
    expect(lastSubmit().input.generate_audio).toBe(true);

    await adapter.submit(baseInput({ modelSettings: {} }));
    expect(lastSubmit().input.generate_audio).toBeUndefined();
  });

  test("kling: aspect_ratio только для r2v (не i2v и не t2v)", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");

    // i2v: aspect_ratio НЕ передаётся (FAL i2v выводит из image)
    await adapter.submit(
      baseInput({
        mediaInputs: { first_frame: ["https://a.png"] },
        modelSettings: { aspect_ratio: "16:9" },
      }),
    );
    expect(lastSubmit().input.aspect_ratio).toBeUndefined();

    // r2v: aspect_ratio передаётся
    await adapter.submit(
      baseInput({
        mediaInputs: { ref_element_1: ["https://e.png"] },
        modelSettings: { aspect_ratio: "9:16" },
      }),
    );
    expect(lastSubmit().input.aspect_ratio).toBe("9:16");
  });

  test("kling: aspect_ratio 'auto' пропускается", async () => {
    const adapter = new FalVideoAdapter("kling", "test-key");
    await adapter.submit(
      baseInput({
        mediaInputs: { ref_element_1: ["https://e.png"] },
        modelSettings: { aspect_ratio: "auto" },
      }),
    );
    expect(lastSubmit().input.aspect_ratio).toBeUndefined();
  });
});

describe("FalVideoAdapter — Grok Imagine endpoint dispatch", () => {
  test("grok-imagine: pure text → text-to-video endpoint", async () => {
    const adapter = new FalVideoAdapter("grok-imagine", "test-key");
    await adapter.submit(baseInput({ prompt: "a cat" }));
    const { endpoint, input } = lastSubmit();
    expect(endpoint).toBe("xai/grok-imagine-video/text-to-video");
    expect(input.prompt).toBe("a cat");
    expect(input.reference_image_urls).toBeUndefined();
  });

  test("grok-imagine-r2v: ref_images → reference-to-video с reference_image_urls", async () => {
    const adapter = new FalVideoAdapter("grok-imagine-r2v", "test-key");
    await adapter.submit(
      baseInput({ mediaInputs: { ref_images: ["https://a.png", "https://b.png"] } }),
    );
    const { endpoint, input } = lastSubmit();
    expect(endpoint).toBe("xai/grok-imagine-video/reference-to-video");
    expect(input.reference_image_urls).toEqual(["https://a.png", "https://b.png"]);
  });

  test("grok-imagine-r2v: cap reference_image_urls = 7", async () => {
    const adapter = new FalVideoAdapter("grok-imagine-r2v", "test-key");
    const tenImgs = Array.from({ length: 10 }, (_, i) => `https://i${i}.png`);
    await adapter.submit(baseInput({ mediaInputs: { ref_images: tenImgs } }));
    expect((lastSubmit().input.reference_image_urls as string[]).length).toBe(7);
  });

  test("grok-imagine-r2v: prompt @image1 → @Image1 remap", async () => {
    const adapter = new FalVideoAdapter("grok-imagine-r2v", "test-key");
    await adapter.submit({
      prompt: "@image1 in a meadow with @image2",
      mediaInputs: { ref_images: ["https://a.png", "https://b.png"] },
    });
    expect(lastSubmit().input.prompt).toBe("@Image1 in a meadow with @Image2");
  });

  test("grok-imagine: duration t2v cap 1-15", async () => {
    const adapter = new FalVideoAdapter("grok-imagine", "test-key");
    await adapter.submit(baseInput({ modelSettings: { duration: 12 } }));
    expect(lastSubmit().input.duration).toBe(12);

    await adapter.submit(baseInput({ modelSettings: { duration: 30 } }));
    expect(lastSubmit().input.duration).toBe(15);
  });

  test("grok-imagine-r2v: duration cap 1-10", async () => {
    const adapter = new FalVideoAdapter("grok-imagine-r2v", "test-key");
    await adapter.submit({
      prompt: "test",
      mediaInputs: { ref_images: ["https://a.png"] },
      modelSettings: { duration: 30 },
    });
    expect(lastSubmit().input.duration).toBe(10);
  });

  test("grok-imagine: ref_images игнорируются (modelId-based dispatch, not runtime media)", async () => {
    const adapter = new FalVideoAdapter("grok-imagine", "test-key");
    await adapter.submit(baseInput({ mediaInputs: { ref_images: ["https://a.png"] } }));
    const { endpoint, input } = lastSubmit();
    // Должен пойти на t2v endpoint, не на r2v — несмотря на наличие ref_images.
    expect(endpoint).toBe("xai/grok-imagine-video/text-to-video");
    expect(input.reference_image_urls).toBeUndefined();
  });

  test("grok-imagine: resolution передаётся как есть", async () => {
    const adapter = new FalVideoAdapter("grok-imagine", "test-key");
    await adapter.submit(baseInput({ modelSettings: { resolution: "720p" } }));
    expect(lastSubmit().input.resolution).toBe("720p");
  });

  test("grok-imagine: aspect_ratio передаётся (без 'auto')", async () => {
    const adapter = new FalVideoAdapter("grok-imagine", "test-key");
    await adapter.submit(baseInput({ modelSettings: { aspect_ratio: "9:16" } }));
    expect(lastSubmit().input.aspect_ratio).toBe("9:16");

    await adapter.submit(baseInput({ modelSettings: { aspect_ratio: "auto" } }));
    expect(lastSubmit().input.aspect_ratio).toBeUndefined();
  });

  test("grok-imagine: returns endpoint||request_id encoded", async () => {
    const adapter = new FalVideoAdapter("grok-imagine", "test-key");
    const result = await adapter.submit(baseInput());
    expect(result).toBe("xai/grok-imagine-video/text-to-video||req-mock-123");
  });
});

describe("FalVideoAdapter — Kling Motion Control (legacy v3 endpoints)", () => {
  test("kling-motion: использует kling-video/v3/standard/motion-control", async () => {
    const adapter = new FalVideoAdapter("kling-motion", "test-key");
    await adapter.submit(
      baseInput({
        mediaInputs: {
          first_frame: ["https://img.png"],
          motion_video: ["https://vid.mp4"],
        },
      }),
    );
    const { endpoint, input } = lastSubmit();
    expect(endpoint).toBe("fal-ai/kling-video/v3/standard/motion-control");
    expect(input.image_url).toBe("https://img.png");
    expect(input.video_url).toBe("https://vid.mp4");
    expect(input.character_orientation).toBe("video");
    expect(input.keep_original_sound).toBe(true);
  });

  test("kling-motion-pro: использует pro endpoint", async () => {
    const adapter = new FalVideoAdapter("kling-motion-pro", "test-key");
    await adapter.submit(
      baseInput({
        mediaInputs: {
          first_frame: ["https://img.png"],
          motion_video: ["https://vid.mp4"],
        },
      }),
    );
    expect(lastSubmit().endpoint).toBe("fal-ai/kling-video/v3/pro/motion-control");
  });
});

describe("FalVideoAdapter — Seedance / Pika / Sora (existing primary endpoints)", () => {
  test("seedance: pika endpoints — t2v без media", async () => {
    const adapter = new FalVideoAdapter("pika", "test-key");
    await adapter.submit(baseInput());
    expect(lastSubmit().endpoint).toBe("fal-ai/pika/v2.2/text-to-video");
  });

  test("seedance: i2v с image_url когда есть first_frame", async () => {
    const adapter = new FalVideoAdapter("seedance", "test-key");
    await adapter.submit(baseInput({ mediaInputs: { first_frame: ["https://a.png"] } }));
    const { endpoint, input } = lastSubmit();
    expect(endpoint).toBe("fal-ai/bytedance/seedance/v1.5/pro/image-to-video");
    expect(input.image_url).toBe("https://a.png");
  });
});
