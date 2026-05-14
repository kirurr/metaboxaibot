import { db } from "../db.js";
import { getAudioQueue } from "../queues/audio.queue.js";
import {
  AI_MODELS,
  KIE_ELEVENLABS_VOICE_IDS,
  ONE_SHOT_SETTING_KEYS,
  UserFacingError,
} from "@metabox/shared";
import { checkBalance } from "./token.service.js";
import { costPreviewService } from "./cost-preview.service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cartesia принимает только UUID. В userState.modelSettings.voice_id может
 * лежать либо живой Cartesia UUID, либо UserVoice.id (cuid, резолвится в
 * воркере). Если ни то, ни другое — голос мёртвый (например, UserVoice удалили),
 * адаптер на сабмите получит 400. Лучше упасть здесь, до списания токенов,
 * с понятным сообщением, чем тратить ретраи воркера и токены.
 */
async function ensureCartesiaVoiceResolvable(voiceId: string): Promise<void> {
  if (UUID_RE.test(voiceId)) return;
  const userVoice =
    (await db.userVoice.findFirst({ where: { id: voiceId }, select: { id: true } })) ??
    (await db.userVoice.findFirst({ where: { externalId: voiceId }, select: { id: true } }));
  if (userVoice) return;
  throw new UserFacingError("Selected voice is unavailable", {
    key: "ttsVoiceUnavailable",
    section: "audio",
  });
}

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

    if (modelId === "tts-cartesia") {
      const raw = modelSettings.voice_id ?? voiceId;
      // null/undefined/"" — «голос не выбран», адаптер использует DEFAULT_VOICE_ID.
      // Сохраняем поведение старого `(ms.voice_id) || input.voiceId || DEFAULT`.
      if (raw !== undefined && raw !== null && raw !== "") {
        if (typeof raw !== "string") {
          throw new UserFacingError("Selected voice is unavailable", {
            key: "ttsVoiceUnavailable",
            section: "audio",
          });
        }
        await ensureCartesiaVoiceResolvable(raw);
      }
    } else if (modelId === "tts-el") {
      // tts-el через kie.ai принимает только фиксированный enum голосов. Старые
      // ElevenLabs voice_id, осевшие в настройках юзеров, там невалидны (kie
      // ответит 422). Гейтим до создания джобы и списания — юзер должен
      // перевыбрать голос в настройках. Пустой voice_id ок: адаптер возьмёт дефолт.
      const raw = modelSettings.voice_id ?? voiceId;
      if (raw !== undefined && raw !== null && raw !== "") {
        if (typeof raw !== "string" || !KIE_ELEVENLABS_VOICE_IDS.has(raw)) {
          throw new UserFacingError("Selected voice is unavailable", {
            key: "ttsVoiceUnavailable",
            section: "audio",
          });
        }
      }
    }

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
