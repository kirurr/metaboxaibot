import type { VideoAdapter, VideoInput, VideoResult } from "./base.adapter.js";
import { config } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { parseLumaSubmitError, parseLumaPollFailure } from "../../utils/luma-error.js";
import { providerHttpError } from "../../utils/rate-limit-error.js";

const LUMA_API = "https://api.lumalabs.ai/dream-machine/v1";

interface LumaGeneration {
  id: string;
  state: string;
  assets?: { video?: string };
  failure_reason?: string;
}

/** Maps internal modelId → Luma API model name. */
const LUMA_MODELS: Record<string, string> = {
  "luma-ray2": "ray-2",
};

/**
 * Luma Dream Machine adapter (REST API). Supports luma-ray2 (ray-2).
 */
export class LumaAdapter implements VideoAdapter {
  readonly modelId: string;

  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch | undefined;

  constructor(
    modelId = "luma-ray2",
    apiKey = config.ai.luma ?? "",
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.modelId = modelId;
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  async submit(input: VideoInput): Promise<string> {
    const ms = input.modelSettings ?? {};
    const body: Record<string, unknown> = {
      model: LUMA_MODELS[this.modelId] ?? "ray-2",
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio ?? "16:9",
      loop: ms.loop !== undefined ? Boolean(ms.loop) : false,
    };

    if (ms.resolution) body.resolution = ms.resolution;
    if (input.duration) body.duration = `${input.duration}s`;

    const firstFrame = input.mediaInputs?.first_frame?.[0] ?? input.imageUrl;
    const lastFrame = input.mediaInputs?.last_frame?.[0];
    const keyframes: Record<string, unknown> = {};
    if (firstFrame) keyframes.frame0 = { type: "image", url: firstFrame };
    if (lastFrame) keyframes.frame1 = { type: "image", url: lastFrame };
    if (Object.keys(keyframes).length > 0) body.keyframes = keyframes;

    const res = await fetchWithLog(
      `${LUMA_API}/generations`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      },
      this.fetchFn,
    );

    if (!res.ok) {
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      const structured = parseLumaSubmitError(json);
      if (structured) throw structured;
      throw providerHttpError(`Luma submit failed: ${res.status} ${text}`, res.status);
    }

    const data = (await res.json()) as LumaGeneration;
    return data.id;
  }

  async poll(generationId: string): Promise<VideoResult | null> {
    const res = await fetchWithLog(
      `${LUMA_API}/generations/${generationId}`,
      {
        headers: this.headers(),
      },
      this.fetchFn,
    );

    if (!res.ok) {
      const text = await res.text();
      throw providerHttpError(`Luma poll failed: ${res.status} ${text}`, res.status);
    }

    const gen = (await res.json()) as LumaGeneration;

    if (gen.state === "failed") {
      throw parseLumaPollFailure(gen.failure_reason);
    }
    if (gen.state !== "completed") return null;

    const url = gen.assets?.video;
    if (!url) throw new Error("Luma: no video URL in completed generation");
    return { url, filename: "luma.mp4" };
  }
}
