import type { VideoAdapter, VideoInput, VideoResult } from "./base.adapter.js";
import { config } from "@metabox/shared";
import { fetchWithLog, isTransientNetworkError } from "../../utils/fetch.js";
import { parseMinimaxBaseResp } from "../../utils/minimax-error.js";
import { logger } from "../../logger.js";
import { providerHttpError } from "../../utils/rate-limit-error.js";

const MINIMAX_API_BASE = "https://api.minimax.io/v1";

/** Maps our internal model IDs to MiniMax API model names. */
const MODEL_MAP: Record<string, string> = {
  minimax: "T2V-01",
  hailuo: "MiniMax-Hailuo-2.3",
  "hailuo-fast": "MiniMax-Hailuo-2.3-Fast",
};

/** Models that support image-to-video (first_frame_image). T2V-01 is text-only. */
const SUPPORTS_IMAGE = new Set(["hailuo", "hailuo-fast"]);

/** Valid resolutions per model. */
const SUPPORTED_RESOLUTIONS: Record<string, string[]> = {
  minimax: ["720P"],
  hailuo: ["768P", "1080P"],
  "hailuo-fast": ["768P", "1080P"],
};

interface MinimaxSubmitResponse {
  task_id?: string;
  base_resp: {
    status_code: number;
    status_msg: string;
  };
}

interface MinimaxPollResponse {
  /** Lowercase: "processing" | "success" | "failed" */
  status: string;
  file_id?: string;
  error_message?: string;
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
}

interface MinimaxFileResponse {
  file: {
    file_id: string;
    download_url: string;
  };
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
}

/**
 * MiniMax native video generation adapter.
 * Covers "minimax" (T2V-01), "hailuo" (MiniMax-Hailuo-2.3), and "hailuo-fast" (MiniMax-Hailuo-2.3-Fast).
 * Note: hailuo-fast is I2V only — first_frame_image is required.
 * Docs: https://platform.minimax.io/docs/guides/video-generation
 */
export class MinimaxVideoAdapter implements VideoAdapter {
  private readonly apiKeyOverride: string | undefined;
  private readonly fetchFn: typeof globalThis.fetch | undefined;

  constructor(
    readonly modelId: string,
    apiKeyOverride?: string,
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.apiKeyOverride = apiKeyOverride;
    this.fetchFn = fetchFn;
  }

  private get apiKey(): string {
    const key = this.apiKeyOverride ?? config.ai.minimax;
    if (!key) throw new Error("MINIMAX_API_KEY not configured");
    return key;
  }

  async submit(input: VideoInput): Promise<string> {
    const ms = input.modelSettings ?? {};
    const model = MODEL_MAP[this.modelId] ?? "T2V-01";

    // Pick resolution: prefer modelSettings, then fall back to best supported
    const supportedRes = SUPPORTED_RESOLUTIONS[this.modelId] ?? ["720P"];
    const defaultRes = supportedRes[supportedRes.length - 1]; // prefer highest
    const resolution = (ms.resolution as string | undefined) ?? defaultRes;

    const duration = (ms.duration as number | undefined) ?? input.duration ?? 6;

    const body: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      duration,
      resolution,
      prompt_optimizer: true,
    };

    const firstFrame = input.mediaInputs?.first_frame?.[0] ?? input.imageUrl;
    const lastFrame = input.mediaInputs?.last_frame?.[0];
    if (firstFrame && SUPPORTS_IMAGE.has(this.modelId)) body.first_frame_image = firstFrame;
    if (lastFrame && SUPPORTS_IMAGE.has(this.modelId)) body.last_frame_image = lastFrame;

    const resp = await fetchWithLog(
      `${MINIMAX_API_BASE}/video_generation`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      this.fetchFn,
    );

    if (!resp.ok) {
      const txt = await resp.text();
      throw providerHttpError(`MiniMax API error ${resp.status}: ${txt}`, resp.status);
    }

    const data = (await resp.json()) as MinimaxSubmitResponse;
    const submitErr = parseMinimaxBaseResp(data.base_resp);
    if (submitErr) throw submitErr;
    if (!data.task_id) throw new Error("MiniMax: no task_id in response");
    return data.task_id;
  }

  async poll(taskId: string): Promise<VideoResult | null> {
    try {
      const resp = await fetchWithLog(
        `${MINIMAX_API_BASE}/query/video_generation?task_id=${encodeURIComponent(taskId)}`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        },
        this.fetchFn,
      );

      if (!resp.ok) throw providerHttpError(`MiniMax poll error ${resp.status}`, resp.status);

      const data = (await resp.json()) as MinimaxPollResponse;
      const status = data.status?.toLowerCase();

      if (status === "failed" || status === "fail") {
        const pollErr = parseMinimaxBaseResp(data.base_resp);
        if (pollErr) throw pollErr;
        throw new Error(`MiniMax generation failed: ${data.error_message ?? "unknown error"}`);
      }
      if (status !== "success") return null;
      if (!data.file_id) throw new Error("MiniMax: no file_id in success response");

      // Retrieve actual download URL from file ID
      const fileResp = await fetchWithLog(
        `${MINIMAX_API_BASE}/files/retrieve?file_id=${encodeURIComponent(data.file_id)}`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        },
        this.fetchFn,
      );

      if (!fileResp.ok) {
        throw providerHttpError(`MiniMax file retrieve error ${fileResp.status}`, fileResp.status);
      }

      const fileData = (await fileResp.json()) as MinimaxFileResponse;
      const url = fileData.file?.download_url;
      if (!url) throw new Error("MiniMax: no download_url in file response");

      return { url, filename: `${this.modelId}.mp4` };
    } catch (err) {
      // Transient network errors (DNS hiccups, socket resets) — treat as
      // "not ready yet" so the processor schedules another poll instead of
      // failing the whole generation.
      if (isTransientNetworkError(err)) {
        logger.warn({ err, taskId }, "MiniMax poll: transient network error, will retry");
        return null;
      }
      throw err;
    }
  }
}
