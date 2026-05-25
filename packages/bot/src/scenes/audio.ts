import { InlineKeyboard } from "grammy";
import type { BotContext } from "../types/context.js";
import { audioGenerationService, userStateService } from "@metabox/api/services";
import { acquireKey, recordSuccess, recordError } from "@metabox/api/services/key-pool";
import { CartesiaAdapter } from "@metabox/api/ai/audio";
import { db } from "@metabox/api/db";
import { getRedis } from "@metabox/api/redis";
import { evictOneCartesiaVoice } from "@metabox/api/services/user-voice";
import {
  AI_MODELS,
  config,
  generateWebToken,
  resolveModelDisplay,
  UserFacingError,
  resolveUserFacingErrorVariant,
  voiceCloneReturnRedisKey,
} from "@metabox/shared";
import { logger } from "../logger.js";
import { notifyTechError } from "../utils/notify-tech.js";
import { gateLowIqMode } from "../utils/confirm-generation.js";
import { buildCostLine } from "../utils/cost-line.js";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";
import { transcribeAndReply } from "../utils/voice-transcribe.js";
import { uploadBuffer, buildS3Key } from "@metabox/api/services/s3";
import { acquireLock, releaseLock } from "../utils/dedup.js";
import { activateVideoModel } from "./video.js";

// ── Sub-section entry points ──────────────────────────────────────────────────

/**
 * Called when user presses one of the audio sub-section reply buttons.
 * Sets AUDIO_ACTIVE state with the correct modelId and sends instructions.
 */
export async function handleAudioSubSection(ctx: BotContext, modelId: string): Promise<void> {
  if (!ctx.user) return;

  await userStateService.setState(ctx.user.id, "AUDIO_ACTIVE", "audio");
  await userStateService.setModelForSection(ctx.user.id, "audio", modelId);

  // Voice-clone activated outside the dedicated webapp button → drop any
  // pending HeyGen-return marker, otherwise the user's next clone here would
  // unexpectedly bounce them back to HeyGen.
  if (modelId === "voice-clone") {
    await getRedis()
      .del(voiceCloneReturnRedisKey(ctx.user.id))
      .catch(() => void 0);
  }

  const instructions: Record<string, string> = {
    "tts-openai": ctx.t.audio.ttsActivated,
    "tts-el": ctx.t.audio.ttsElActivated,
    "tts-cartesia": ctx.t.audio.ttsCartesiaActivated,
    "voice-clone": ctx.t.audio.voiceCloneActivated,
    suno: ctx.t.audio.musicActivated,
    "music-el": ctx.t.audio.musicElActivated,
    "sounds-el": ctx.t.audio.soundsActivated,
  };

  const hint = instructions[modelId] ?? ctx.t.audio.activated;

  // For generative models (not voice-clone), show full structured message + management button
  if (modelId !== "voice-clone") {
    const model = AI_MODELS[modelId];
    if (model) {
      const allSettings = await userStateService.getModelSettings(ctx.user.id);
      const modelSettings = allSettings[modelId] ?? {};
      const costLine = buildCostLine(model, modelSettings, ctx.t);
      const webappUrl = config.bot.webappUrl;
      const token =
        webappUrl && ctx.user.telegramId
          ? generateWebToken(ctx.user.telegramId, config.bot.token)
          : "";
      const kb = webappUrl
        ? new InlineKeyboard().webApp(
            ctx.t.audio.management,
            `${webappUrl}?page=management&section=audio&wtoken=${token}`,
          )
        : undefined;
      const { name: modelName, description: modelDesc } = resolveModelDisplay(
        modelId,
        ctx.user.language,
        model,
      );
      // tts-el / tts-cartesia: голосовой ввод как «текст для синтеза» неприменим
      // (это TTS), и оба hint'а содержат HTML-разметку <blockquote>/<b>.
      const ttsTextOnly = modelId === "tts-el" || modelId === "tts-cartesia";
      const voiceInputHint = ttsTextOnly ? "" : `\n\n${ctx.t.voice.inputHint}`;
      await ctx.reply(`${modelName}\n\n${modelDesc}\n\n${hint}${voiceInputHint}\n\n${costLine}`, {
        reply_markup: kb,
        parse_mode: ttsTextOnly ? "HTML" : undefined,
      });
      return;
    }
  }

  // voice-clone: no voice transcription hint (audio is used for cloning, not prompts).
  // parse_mode HTML — у voiceCloneActivated есть <blockquote>/<b> тэги с советами Cartesia.
  await ctx.reply(`${ctx.t.audio.voiceClone}\n\n${hint}`, { parse_mode: "HTML" });
}

// ── Voice cloning: accepts audio/voice file, creates EL voice ────────────────

export async function handleVoiceCloneUpload(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const file =
    ctx.message?.voice ??
    ctx.message?.audio ??
    (ctx.message?.document?.mime_type?.startsWith("audio/") ? ctx.message.document : undefined);
  if (!file) return;

  const lockKey = `dedup:voice:${ctx.user.id}:${file.file_id}`;
  try {
    if (!(await acquireLock(lockKey, 120))) return;
  } catch {
    // Redis unavailable — proceed without dedup rather than blocking the user
  }

  const pendingMsg = await ctx.reply(ctx.t.audio.voiceCloneProcessing);

  try {
    // 1. Download audio file from Telegram
    const fileInfo = await ctx.api.getFile(file.file_id);
    const filePath = fileInfo.file_path;
    if (!filePath) throw new Error("No file_path in Telegram response");

    const fileUrl = `https://api.telegram.org/file/bot${config.bot.token}/${filePath}`;
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
    const audioBuffer = Buffer.from(await res.arrayBuffer());
    const filename = filePath.split("/").pop() ?? "voice.ogg";

    // 2. Generate sequential name. Считаем все голоса юзера (любой провайдер) —
    // для последовательной нумерации в UI неважно где голос хранится.
    const count = await db.userVoice.count({ where: { userId: ctx.user.id } });
    const name = `Голос ${ctx.user.id} #${count + 1}`;

    // 3. Clone voice на Cartesia (заменили ElevenLabs из-за более жёстких
    //    лимитов на slot'ы). Voice_id живёт в org конкретного API-ключа →
    //    сохраняем providerKeyId, при TTS дёргаем тот же ключ. Если ключ
    //    удалят — voice пересоздастся через resolveVoiceForTTS из audioS3Key.
    //    Legacy EL-голоса юзеров продолжают работать через тот же resolveVoiceForTTS.
    const acquired = await acquireKey("cartesia");
    let voiceId: string;
    try {
      try {
        voiceId = await CartesiaAdapter.cloneVoice(
          audioBuffer,
          filename,
          name,
          "ru",
          acquired.apiKey,
        );
      } catch (err) {
        // Cartesia не документирует точный код slot-limit'а. По heuristic'у
        // вылавливаем "limit"/"quota"/"exceeded" в message → eviction → retry.
        const msg = err instanceof Error ? err.message.toLowerCase() : "";
        if (/limit|quota|exceeded|maximum/i.test(msg)) {
          const freed = await evictOneCartesiaVoice(acquired.apiKey, acquired.keyId);
          if (!freed) throw err;
          voiceId = await CartesiaAdapter.cloneVoice(
            audioBuffer,
            filename,
            name,
            "ru",
            acquired.apiKey,
          );
        } else {
          throw err;
        }
      }
      if (acquired.keyId) void recordSuccess(acquired.keyId);
    } catch (err) {
      if (acquired.keyId) {
        void recordError(acquired.keyId, err instanceof Error ? err.message : String(err));
      }
      throw err;
    }

    // 4. Upload original audio to S3 for future voice recreation
    const ext = filename.split(".").pop() ?? "ogg";
    const audioS3Key = buildS3Key("voices", ctx.user.id.toString(), voiceId, ext);
    await uploadBuffer(audioS3Key, audioBuffer, `audio/${ext}`).catch(() => null);

    // 5. Save to DB. previewUrl у Cartesia не сохраняем (preview генерируется
    //    on-demand через expand[]=preview_file_url в getVoice; URL короткоживущий).
    await db.userVoice.create({
      data: {
        userId: ctx.user.id,
        provider: "cartesia",
        name,
        externalId: voiceId,
        previewUrl: null,
        audioS3Key,
        status: "ready",
        providerKeyId: acquired.keyId,
      },
    });

    await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);
    await ctx.reply(ctx.t.audio.voiceCloneSuccess.replace("{name}", name));

    // If the clone was launched from the HeyGen voice picker (webapp button),
    // bring the user back to HeyGen as the active video model so they can
    // immediately use the voice they just cloned.
    const redis = getRedis();
    const returnKey = voiceCloneReturnRedisKey(ctx.user.id);
    const returnTarget = await redis.get(returnKey).catch(() => null);
    if (returnTarget) {
      await redis.del(returnKey).catch(() => void 0);
      if (returnTarget === "heygen") {
        await activateVideoModel(ctx, "heygen").catch((reactivateErr) =>
          logger.warn(reactivateErr, "Voice clone return: failed to re-activate HeyGen"),
        );
      }
    }
  } catch (err) {
    await releaseLock(lockKey);
    await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);
    // UserFacingError — user-fault (битый/короткий/неподдерживаемый клип).
    // Юзеру показываем actionable-текст, ops не алёртим: это не наш баг.
    if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Voice clone error");
      // Detect transient (5xx HTTP / network) — Cartesia инфра-сбой, не наш
      // баг и не юзера. Без ретраев (это интерактивный bot scene handler — нет
      // смысла блокировать юзера на 20-30с): сразу показываем честный мессадж
      // «провайдер временно недоступен, попробуйте через минуту», и алёртим ops
      // — для них это всё ещё ценная info про состояние Cartesia.
      const msg = err instanceof Error ? err.message.toLowerCase() : "";
      const isTransient =
        /\b5\d{2}\b/.test(msg) ||
        /fetch failed|network|econnreset|etimedout|socket hang up/i.test(msg);
      await ctx.reply(
        isTransient ? ctx.t.audio.voiceCloneProviderUnavailable : ctx.t.audio.voiceCloneFailed,
      );
      void notifyTechError(err, {
        section: "audio",
        modelId: "voice-clone",
        userId: ctx.user.id.toString(),
      });
    }
    // Drop any pending return marker — we don't want to silently re-activate
    // HeyGen on the next unrelated voice the user sends.
    await getRedis()
      .del(voiceCloneReturnRedisKey(ctx.user.id))
      .catch(() => void 0);
  }
}

// ── Incoming prompt in AUDIO_ACTIVE state ─────────────────────────────────────

/**
 * Executes a text prompt in the active audio session.
 * Used by handleAudioMessage (text) and the voice-prompt callback.
 */
export async function executeAudioPrompt(
  ctx: BotContext,
  prompt: string,
  promptMessageId?: number,
): Promise<void> {
  if (!ctx.user) return;
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.audioModelId ?? "tts-openai";

  const submitParams = {
    userId: ctx.user.id,
    modelId,
    prompt,
    telegramChatId: chatId,
    promptMessageId,
  };
  if (
    await gateLowIqMode({
      ctx,
      kind: "audio",
      modelId,
      prompt,
      submitParams,
    })
  ) {
    return;
  }

  const pendingMsg = await ctx.reply(ctx.t.audio.processing);

  try {
    await audioGenerationService.submitAudio(submitParams);
  } catch (err: unknown) {
    await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);
    if (err instanceof Error && err.message === "NO_SUBSCRIPTION") {
      await replyNoSubscription(ctx);
    } else if (err instanceof Error && err.message === "INSUFFICIENT_TOKENS") {
      await replyInsufficientTokens(ctx);
    } else if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Audio message error");
      await ctx.reply(ctx.t.audio.generationFailed);
    }
  }
}

export async function handleAudioMessage(ctx: BotContext): Promise<void> {
  if (!ctx.user || !ctx.message?.text) return;
  await executeAudioPrompt(ctx, ctx.message.text, ctx.message.message_id);
}

export async function handleAudioVoice(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await transcribeAndReply(ctx, "audio");
}
