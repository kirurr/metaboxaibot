import {
  userStateService,
  s3Service,
  calculateCost,
  checkBalance,
  deductTokens,
  type SubmitVideoParams,
} from "@metabox/api/services";
import { ElevenLabsAdapter, CartesiaAdapter } from "@metabox/api/ai/audio";
import { resolveVoiceForTTS } from "@metabox/api/services/user-voice";
import { db } from "@metabox/api/db";
import { AI_MODELS } from "@metabox/shared";
import { logger } from "../logger.js";
import { resolveMediaInputUrls } from "./media-input-state.js";

export const AVATAR_MODELS = new Set(["heygen", "d-id"]);

/**
 * Если модель — avatar (heygen/d-id) и юзер выбрал клонированный голос (Cartesia
 * или legacy ElevenLabs), синтезируем промпт через TTS соответствующего провайдера,
 * аплоадим в S3, списываем TTS-токены и возвращаем S3 key. Адаптер видеомодели
 * подхватит файл из mediaInputs.voice_audio и пойдёт через audio_asset_id flow.
 *
 * Returns null когда pre-TTS не нужен (raw audio override / non-cloned voice /
 * провайдер `voice_id` не совпадает с UserVoice).
 *
 * Ранее назывался `preGenerateELTts` (только EL). Сохраняем имя для callers'ов
 * — теперь dispatch'имся по UserVoice.provider (Cartesia новые, EL legacy).
 */
export async function preGenerateELTts(
  userId: bigint,
  modelId: string,
  prompt: string,
  videoModelSettings: Record<string, unknown>,
  rawVoiceOverride: string | undefined,
): Promise<string | null> {
  if (!AVATAR_MODELS.has(modelId)) return null;
  if (rawVoiceOverride) return null; // raw audio takes priority

  const requestedVoice = videoModelSettings.voice_id as string | undefined;
  const voiceProvider = videoModelSettings.voice_provider as string | undefined;
  if (!requestedVoice) return null;
  // Явно non-EL/Cartesia provider (например "heygen" — native HeyGen voice) →
  // не TTS'им, адаптер передаст voice_id напрямую в HeyGen.
  if (voiceProvider && voiceProvider !== "elevenlabs" && voiceProvider !== "cartesia") {
    return null;
  }

  // UserVoice lookup: пробуем найти по local id (modern picker) или по externalId
  // (legacy paths). Допускаем оба провайдера — provider определяется по самой
  // UserVoice-записи.
  const userVoice =
    (await db.userVoice.findFirst({
      where: { id: requestedVoice },
      select: { id: true, provider: true },
    })) ??
    (await db.userVoice.findFirst({
      where: { externalId: requestedVoice },
      select: { id: true, provider: true },
    }));

  // Если UserVoice не найден И voice_provider не указан → не наш голос, skip.
  if (!userVoice && !voiceProvider) return null;

  // resolveVoiceForTTS делает re-clone при необходимости и возвращает фактический
  // provider (cartesia или elevenlabs). Это критично для выбора TTS-адаптера.
  let resolvedVoiceId = requestedVoice;
  let stickyApiKey: string | undefined;
  let actualProvider: "cartesia" | "elevenlabs" = "cartesia";
  if (userVoice) {
    const resolved = await resolveVoiceForTTS(userVoice.id);
    resolvedVoiceId = resolved.voiceId;
    stickyApiKey = resolved.acquired.apiKey;
    actualProvider = resolved.provider;
  } else {
    // Нет UserVoice → voiceProvider обязан быть задан (см. early return выше).
    actualProvider = voiceProvider === "elevenlabs" ? "elevenlabs" : "cartesia";
  }

  // Подбираем TTS-модель + адаптер по фактическому провайдеру голоса.
  const ttsModelId = actualProvider === "cartesia" ? "tts-cartesia" : "tts-el";
  const ttsModel = AI_MODELS[ttsModelId];
  if (!ttsModel) {
    // Cartesia модель может быть не зарегистрирована — fallback на EL pricing для
    // подсчёта стоимости. Без модели в каталоге не считаем balance.
    logger.warn({ ttsModelId }, "preGenerateTts: TTS model not in AI_MODELS catalog");
  }

  const allSettings = await userStateService.getModelSettings(userId);
  const ttsSettings: Record<string, unknown> = {
    ...(allSettings[ttsModelId] ?? allSettings["tts-el"] ?? {}),
    voice_id: resolvedVoiceId,
  };

  if (ttsModel) {
    const ttsCost = calculateCost(
      ttsModel,
      0,
      0,
      undefined,
      undefined,
      ttsSettings,
      undefined,
      prompt.length,
    );
    await checkBalance(userId, ttsCost);

    const result = await runTts(actualProvider, ttsSettings, prompt, stickyApiKey);
    if (!result?.buffer) return null;

    const s3Key = `voice/${actualProvider === "cartesia" ? "cartesia" : "el"}/${userId.toString()}/${Date.now()}.mp3`;
    const uploadedKey = await s3Service
      .uploadBuffer(s3Key, result.buffer, "audio/mpeg")
      .catch(() => null);
    if (!uploadedKey) {
      logger.warn(
        { userId, modelId, actualProvider },
        "TTS generated but S3 upload failed — falling back to no TTS audio",
      );
      return null;
    }

    await deductTokens(userId, ttsCost, ttsModelId);
    return uploadedKey;
  }

  // Без модели в каталоге всё равно выполняем TTS, но без точного биллинга
  // (использовали бы EL расчёт как proxy — но безопаснее skip нежели бесплатно).
  return null;
}

async function runTts(
  provider: "cartesia" | "elevenlabs",
  settings: Record<string, unknown>,
  prompt: string,
  stickyApiKey: string | undefined,
): Promise<{ buffer?: Buffer } | null> {
  if (provider === "cartesia") {
    const adapter = new CartesiaAdapter("tts-cartesia", stickyApiKey);
    return adapter.generate({ prompt, modelSettings: settings });
  }
  const adapter = new ElevenLabsAdapter("tts-el", stickyApiKey);
  return adapter.generate({ prompt, modelSettings: settings });
}

/**
 * Wraps `preGenerateELTts` for the video submit pipeline. If the model is an
 * avatar model with an EL voice and no audio override yet, generates EL TTS
 * and returns a new SubmitVideoParams with the synthesized audio injected into
 * `mediaInputs.voice_audio`. Otherwise returns the params unchanged.
 *
 * Used both by the confirm-off path (bot scenes) and the confirm-on path
 * (`handleLowIqStart` → `runReplaySubmit`) so EL TTS only runs after the
 * generation is committed (not at gate-time).
 */
export async function ensureELTtsForVideo(
  submitParams: SubmitVideoParams,
): Promise<SubmitVideoParams> {
  const { userId, modelId, prompt, mediaInputs } = submitParams;
  if (!AVATAR_MODELS.has(modelId)) return submitParams;
  if (mediaInputs?.voice_audio?.[0]) return submitParams;

  const allSettings = await userStateService.getModelSettings(userId);
  const fullModelSettings = allSettings[modelId] ?? {};

  const elTtsS3Key = await preGenerateELTts(userId, modelId, prompt, fullModelSettings, undefined);
  if (!elTtsS3Key) return submitParams;

  return {
    ...submitParams,
    mediaInputs: await resolveMediaInputUrls({
      ...(mediaInputs ?? {}),
      voice_audio: [elTtsS3Key],
    }),
  };
}
