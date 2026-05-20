import Replicate from "replicate";
import type { VideoAdapter, VideoInput, VideoResult } from "./base.adapter.js";
import { config } from "@metabox/shared";
import { logCall } from "../../utils/fetch.js";
import { parseReplicatePredictionFailure } from "../../utils/replicate-error.js";
import { resolveImageMimeType } from "../../utils/mime-detect.js";

/**
 * Replicate-backed video adapter.
 * Used for: sora (OpenAI via Replicate).
 */
const REPLICATE_MODELS: Record<string, `${string}/${string}:${string}` | `${string}/${string}`> = {
  sora: "openai/sora-2",
  // Topaz video upscaler — fallback для KIE primary `video-upscale`.
  "video-upscale": "topazlabs/video-upscale",
};

export class ReplicateVideoAdapter implements VideoAdapter {
  private client: Replicate;

  constructor(
    readonly modelId: string,
    apiToken = config.ai.replicate,
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.client = new Replicate({
      auth: apiToken,
      ...(fetchFn ? { fetch: fetchFn } : {}),
    });
  }

  private get model(): `${string}/${string}` | `${string}/${string}:${string}` {
    return REPLICATE_MODELS[this.modelId] ?? (`replicate/${this.modelId}` as `${string}/${string}`);
  }

  async submit(input: VideoInput): Promise<string> {
    const ms = input.modelSettings ?? {};

    // ── Topaz video upscale — fallback для KIE primary `video-upscale` ────────
    // Replicate-версия принимает абсолютное `target_resolution` + `target_fps`.
    // Сцена кладёт их в modelSettings (тиры вычислены из исходника), цена
    // учитывает оба — биллинг и стоимость Replicate согласованы.
    if (this.modelId === "video-upscale") {
      const videoUrl = input.mediaInputs?.motion_video?.[0] ?? input.imageUrl;
      if (!videoUrl) throw new Error("Replicate video-upscale: source video is required");
      // Replicate не умеет фетчить S3/Telegram presigned URL напрямую — качаем
      // видео сами и отдаём File (SDK v1.x грузит его в Replicate files API).
      // Именно File, а не Blob: Topaz определяет контейнер по расширению имени,
      // голый Blob без имени → ошибка "`source.container` is required".
      let videoParam: File | string = videoUrl;
      const vidRes = await fetch(videoUrl);
      if (vidRes.ok) {
        const vidBuf = Buffer.from(await vidRes.arrayBuffer());
        const contentType = vidRes.headers.get("content-type") ?? "video/mp4";
        const ext = contentType.includes("matroska")
          ? "mkv"
          : contentType.includes("quicktime")
            ? "mov"
            : "mp4";
        videoParam = new File([vidBuf], `source.${ext}`, { type: contentType });
      }
      const targetResolution = ["720p", "1080p", "4k"].includes(String(ms.target_resolution))
        ? String(ms.target_resolution)
        : "1080p";
      const targetFps = String(ms.fps) === "60" ? 60 : 30;
      const predInput = {
        video: videoParam,
        target_resolution: targetResolution,
        target_fps: targetFps,
      };
      logCall(String(this.model), "submit", {
        video: "<blob>",
        target_resolution: targetResolution,
        target_fps: targetFps,
      });
      const prediction = await this.client.predictions.create({
        model: this.model as `${string}/${string}`,
        input: predInput,
      });
      return prediction.id;
    }

    const referenceUrl = input.mediaInputs?.reference?.[0] ?? input.imageUrl;

    // Sora uses "seconds" (not "duration"), "input_reference" (not "image"),
    // and native aspect_ratio values "portrait"/"landscape" from model settings.
    const isSora = this.modelId === "sora";
    const predInput: Record<string, unknown> = { prompt: input.prompt };

    // Download image and pass as Blob — Replicate cannot fetch Telegram/S3 presigned URLs directly.
    let imageBlob: Blob | undefined;
    if (referenceUrl) {
      const imgRes = await fetch(referenceUrl);
      if (imgRes.ok) {
        const imgBuf = await imgRes.arrayBuffer();
        const mimeType = resolveImageMimeType(imgBuf, imgRes.headers.get("content-type"));
        imageBlob = new Blob([imgBuf], { type: mimeType });
      }
    }

    if (isSora) {
      if (imageBlob) predInput.input_reference = imageBlob;
      else if (referenceUrl) predInput.input_reference = referenceUrl;
      if (input.duration) predInput.seconds = input.duration;
      // aspect_ratio stored in modelSettings for Sora (portrait/landscape)
      const ar = ms.aspect_ratio as string | undefined;
      if (ar) predInput.aspect_ratio = ar;
    } else {
      if (ms.negative_prompt) predInput.negative_prompt = ms.negative_prompt;
      if (ms.seed != null) predInput.seed = ms.seed;
      if (imageBlob) predInput.image = imageBlob;
      else if (referenceUrl) predInput.image = referenceUrl;
      if (input.duration) predInput.duration = input.duration;
      if (input.aspectRatio) predInput.aspect_ratio = input.aspectRatio;
    }

    logCall(String(this.model), "submit", predInput);
    const prediction = await this.client.predictions.create({
      model: this.model as `${string}/${string}`,
      input: predInput,
    });
    return prediction.id;
  }

  async poll(predictionId: string): Promise<VideoResult | null> {
    const prediction = await this.client.predictions.get(predictionId);

    if (prediction.status === "failed") {
      throw parseReplicatePredictionFailure(prediction.error, prediction.status);
    }
    if (prediction.status !== "succeeded") return null;

    const output = prediction.output;
    const url =
      typeof output === "string"
        ? output
        : Array.isArray(output)
          ? (output[0] as string)
          : undefined;

    if (!url) throw new Error(`Replicate ${this.modelId}: no output URL`);
    return { url, filename: `${this.modelId}.mp4` };
  }
}
