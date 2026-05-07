import { AI_MODELS } from "@metabox/shared";
import { calculateCost, computeVideoTokens } from "./token.service.js";
import { userStateService } from "./user-state.service.js";
import { probeAudioDurationSec } from "../utils/audio-transcode.js";
import { logger } from "../logger.js";
import type { SubmitImageParams } from "./generation.service.js";
import type { SubmitVideoParams } from "./video-generation.service.js";
import type { SubmitAudioParams } from "./audio-generation.service.js";

/**
 * For HeyGen lip-sync the output video length equals the input audio length,
 * and HeyGen bills per second. We must measure audio up-front so the balance
 * check (and the user-facing confirmation message) reflects reality.
 */
export async function probeHeygenAudioDuration(
  _modelSettings: Record<string, unknown>,
  mediaInputs: Record<string, string[]> | undefined,
): Promise<number | null> {
  const url =
    mediaInputs?.voice_audio?.[0] ??
    mediaInputs?.driving_audio?.[0] ??
    mediaInputs?.reference_audios?.[0] ??
    null;
  if (!url) return null;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return await probeAudioDurationSec(buf);
  } catch (err) {
    logger.warn({ err }, "probeHeygenAudioDuration: failed to fetch/probe input audio");
    return null;
  }
}

export interface ImageCostPreview {
  cost: number;
  perImageCost: number;
  numImages: number;
  effectiveAspectRatio: string | undefined;
  effectiveModelSettings: Record<string, unknown>;
}

export interface VideoCostPreview {
  cost: number;
  effectiveDuration: number;
  effectiveAspectRatio: string | undefined;
  effectiveModelSettings: Record<string, unknown>;
  estimatedVideoTokens: number | undefined;
}

export interface AudioCostPreview {
  cost: number;
  effectiveModelSettings: Record<string, unknown>;
}

export const costPreviewService = {
  async previewImage(params: SubmitImageParams): Promise<ImageCostPreview> {
    const { userId, modelId, aspectRatio } = params;
    const model = AI_MODELS[modelId];
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const allModelSettings = await userStateService.getModelSettings(userId);
    const modelSettings = allModelSettings[modelId] ?? {};
    const effectiveAspectRatio = (modelSettings.aspect_ratio as string | undefined) ?? aspectRatio;

    const estimatedMegapixels = model.costUsdPerMPixel ? 1.0 : undefined;
    const perImageCost = calculateCost(model, 0, 0, estimatedMegapixels, undefined, modelSettings);

    const maxBatch = model.maxVirtualBatch ?? 1;
    const isVirtualBatchEligible = maxBatch > 1 && (model.nativeBatchMax ?? 1) === 1;
    const requestedN = Number(modelSettings.num_images ?? 1);
    const numImages = isVirtualBatchEligible
      ? Math.max(1, Math.min(maxBatch, Number.isFinite(requestedN) ? Math.floor(requestedN) : 1))
      : 1;

    return {
      cost: perImageCost * numImages,
      perImageCost,
      numImages,
      effectiveAspectRatio,
      effectiveModelSettings: modelSettings,
    };
  },

  async previewVideo(params: SubmitVideoParams): Promise<VideoCostPreview> {
    const { userId, modelId, prompt, aspectRatio, duration, extraModelSettings } = params;
    const model = AI_MODELS[modelId];
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const allModelSettings = await userStateService.getModelSettings(userId);
    const modelSettings = { ...(allModelSettings[modelId] ?? {}), ...extraModelSettings };
    const effectiveAspectRatio = (modelSettings.aspect_ratio as string | undefined) ?? aspectRatio;
    let effectiveDuration =
      (modelSettings.duration as number | undefined) ??
      duration ??
      model.durationRange?.min ??
      model.supportedDurations?.[0] ??
      5;

    if (modelId === "heygen") {
      const audioSec = await probeHeygenAudioDuration(modelSettings, params.mediaInputs);
      if (audioSec !== null) {
        effectiveDuration = Math.ceil(audioSec);
        logger.info(
          { modelId, audioSec, effectiveDuration },
          "HeyGen pre-flight: using probed audio duration for cost estimate",
        );
      } else if (prompt) {
        const TTS_CHARS_PER_SEC = 14;
        effectiveDuration = Math.max(5, Math.ceil(prompt.length / TTS_CHARS_PER_SEC));
        logger.info(
          { modelId, promptChars: prompt.length, effectiveDuration },
          "HeyGen pre-flight: using TTS-from-prompt duration estimate",
        );
      }
    }

    const estimatedVideoTokens = model.costUsdPerMVideoToken
      ? computeVideoTokens(
          model,
          effectiveAspectRatio,
          effectiveDuration,
          undefined,
          undefined,
          undefined,
          modelSettings.resolution as string | undefined,
        )
      : undefined;

    const cost = calculateCost(
      model,
      0,
      0,
      undefined,
      estimatedVideoTokens,
      modelSettings,
      effectiveDuration,
    );

    return {
      cost,
      effectiveDuration,
      effectiveAspectRatio,
      effectiveModelSettings: modelSettings,
      estimatedVideoTokens,
    };
  },

  async previewAudio(params: SubmitAudioParams): Promise<AudioCostPreview> {
    const { userId, modelId, prompt } = params;
    const model = AI_MODELS[modelId];
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const allModelSettings = await userStateService.getModelSettings(userId);
    const modelSettings = allModelSettings[modelId] ?? {};
    const cost = calculateCost(
      model,
      0,
      0,
      undefined,
      undefined,
      modelSettings,
      undefined,
      prompt.length,
    );

    return { cost, effectiveModelSettings: modelSettings };
  },
};
