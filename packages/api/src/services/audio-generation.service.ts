import { db } from "../db.js";
import { getAudioQueue } from "../queues/audio.queue.js";
import { AI_MODELS, ONE_SHOT_SETTING_KEYS } from "@metabox/shared";
import { checkBalance } from "./token.service.js";
import { costPreviewService } from "./cost-preview.service.js";

/** Drop one-shot upload fields (voice_*, talking_photo_id) from the history
 * snapshot so `inputData.modelSettings` stays clean of per-generation noise. */
function stripOneShotKeys(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (ONE_SHOT_SETTING_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface SubmitAudioParams {
  userId: bigint;
  modelId: string;
  prompt: string;
  voiceId?: string;
  sourceAudioUrl?: string;
  telegramChatId: number;
  /** Telegram message_id of the user's prompt — worker replies to it when sending the result. */
  promptMessageId?: number;
}

export interface SubmitAudioResult {
  dbJobId: string;
}

export const audioGenerationService = {
  async submitAudio(params: SubmitAudioParams): Promise<SubmitAudioResult> {
    const { userId, modelId, prompt, voiceId, sourceAudioUrl, telegramChatId } = params;

    const model = AI_MODELS[modelId];
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const preview = await costPreviewService.previewAudio(params);
    const modelSettings = preview.effectiveModelSettings;
    await checkBalance(userId, preview.cost);

    const job = await db.generationJob.create({
      data: {
        userId,
        dialogId: "",
        section: "audio",
        modelId,
        prompt,
        inputData: (() => {
          const historySettings = stripOneShotKeys(
            modelSettings as unknown as Record<string, unknown>,
          );
          return Object.keys(historySettings).length > 0
            ? { modelSettings: JSON.parse(JSON.stringify(historySettings)) }
            : undefined;
        })(),
        status: "pending",
      },
    });

    // Voice slot resolution для tts-el на cloned-voice выполняется в воркере
    // через resolveVoiceForTTS — там же sticky-ключ + re-clone из audioS3Key.
    const queue = getAudioQueue();
    await queue.add(
      "generate",
      {
        dbJobId: job.id,
        userId: userId.toString(),
        modelId,
        prompt,
        voiceId,
        sourceAudioUrl,
        telegramChatId,
        modelSettings,
        ...(params.promptMessageId ? { promptMessageId: params.promptMessageId } : {}),
      },
      {
        jobId: job.id,
        removeOnComplete: true,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    );

    return { dbJobId: job.id };
  },
};
