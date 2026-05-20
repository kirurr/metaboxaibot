import type { BotContext } from "../types/context.js";
import {
  generationService,
  videoGenerationService,
  userStateService,
  s3Service,
  calculateCost,
} from "@metabox/api/services";
import { probeVideoMetadata } from "@metabox/api/utils/mp4-duration";
import {
  AI_MODELS,
  config,
  UserFacingError,
  resolveUserFacingErrorVariant,
  pickGenerationFailedMessage,
  PHOTO_UPSCALE_BUFFER_MODEL_ID,
  VIDEO_UPSCALE_BUFFER_MODEL_ID,
  PHOTO_UPSCALE_MODEL_ID,
  VIDEO_UPSCALE_MODEL_ID,
  PHOTO_UPSCALE_FACTORS,
  VIDEO_UPSCALE_FACTORS,
} from "@metabox/shared";
import { InlineKeyboard } from "grammy";
import { logger } from "../logger.js";
import { resolveMediaInputUrls } from "../utils/media-input-state.js";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";

/** Telegram Bot API hard cap on `getFile` downloads. */
const TG_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * KIE Topaz image upscaler rejects inputs over 10 MB. Telegram allows
 * image-documents up to 20 MB, so we cap photo upscale tighter than the
 * generic download limit — иначе 10–20 МБ файл уходит в KIE и падает там
 * с generic-ошибкой вместо понятного «фото слишком большое».
 */
const KIE_TOPAZ_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Buffer slot key holding the single uploaded source file (S3 key). */
const UPSCALE_SLOT = "src";

/**
 * Buffer slot key holding the source video duration (seconds, as string).
 * Хранится рядом с файлом, а не в callback_data: иначе тап по «устаревшей»
 * клавиатуре (юзер загрузил видео B поверх A) списал бы цену по длительности
 * A, апскейля при этом B. Длительность всегда читается из текущего буфера.
 */
const UPSCALE_DUR_SLOT = "dur";

/**
 * In-memory dedup of Telegram media groups (albums) — only the first item of
 * any group is consumed, the rest are silently dropped.
 */
const processedMediaGroups = new Set<string>();

function rememberMediaGroup(key: string): void {
  processedMediaGroups.add(key);
  if (processedMediaGroups.size > 1000) {
    const iter = processedMediaGroups.values();
    for (let i = 0; i < 100; i++) {
      const v = iter.next().value;
      if (v) processedMediaGroups.delete(v);
    }
  }
}

/** Builds the factor-selection inline keyboard with per-factor token cost. */
function buildFactorKeyboard(
  kind: "photo" | "video",
  factors: readonly string[],
  modelId: string,
  durationSec: number | undefined,
): InlineKeyboard {
  const model = AI_MODELS[modelId];
  const kb = new InlineKeyboard();
  for (const f of factors) {
    let label = `×${f}`;
    if (model) {
      const cost = calculateCost(
        model,
        0,
        0,
        undefined,
        undefined,
        { upscale_factor: f },
        durationSec,
      );
      label = `×${f} · ${cost.toFixed(2)} ✦`;
    }
    kb.text(label, `upscale:${kind}:${f}`).row();
  }
  return kb;
}

// ── Photo upscale ────────────────────────────────────────────────────────────

/** Entry — user tapped «🔼 Апскейл фото» in the Scenarios submenu. */
export async function handlePhotoUpscaleEnter(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.clearMediaInputs(ctx.user.id, PHOTO_UPSCALE_BUFFER_MODEL_ID);
  await userStateService.setState(ctx.user.id, "PHOTO_UPSCALE_AWAIT_PHOTO", null);

  const welcome = [`<b>${ctx.t.scenarios.photoUpscale}</b>`, ctx.t.scenarios.photoUpscaleWelcome]
    .filter(Boolean)
    .join("\n\n");
  await ctx.reply(welcome, { parse_mode: "HTML" });
  await ctx.reply(ctx.t.scenarios.photoUpscaleStep, { parse_mode: "HTML" });
}

/** Handles a photo (compressed or image-document) in PHOTO_UPSCALE_AWAIT_PHOTO. */
export async function handlePhotoUpscalePhoto(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  const mediaGroupId = ctx.message?.media_group_id;
  const mediaGroupKey = mediaGroupId ? `${ctx.user.id}:${mediaGroupId}` : null;
  if (mediaGroupKey && processedMediaGroups.has(mediaGroupKey)) return;

  let fileId: string | undefined;
  let fileSize: number | undefined;
  let mimeHint: string | undefined;
  if (ctx.message?.photo) {
    const largest = ctx.message.photo.at(-1);
    fileId = largest?.file_id;
    fileSize = largest?.file_size;
  } else if (ctx.message?.document?.mime_type?.startsWith("image/")) {
    fileId = ctx.message.document.file_id;
    fileSize = ctx.message.document.file_size;
    mimeHint = ctx.message.document.mime_type;
  }
  if (!fileId) {
    await ctx.reply(ctx.t.scenarios.upscaleNotPhoto);
    return;
  }
  if (fileSize !== undefined && fileSize > KIE_TOPAZ_IMAGE_MAX_BYTES) {
    await ctx.reply(ctx.t.scenarios.upscalePhotoTooLarge);
    return;
  }

  const userId = ctx.user.id;
  const file = await ctx.api.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
  const contentType = mimeHint?.startsWith("image/") ? mimeHint : "image/jpeg";
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const s3Key = `photo_upscale/${userId.toString()}/${Date.now()}.${ext}`;
  const uploadedKey = await s3Service.uploadFromUrl(s3Key, tgUrl, contentType).catch(() => null);
  if (!uploadedKey) {
    await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.photoUpscale, "design"));
    return;
  }

  await userStateService.addMediaInput(
    userId,
    PHOTO_UPSCALE_BUFFER_MODEL_ID,
    UPSCALE_SLOT,
    uploadedKey,
    true,
  );
  if (mediaGroupKey) rememberMediaGroup(mediaGroupKey);

  await ctx.reply(ctx.t.scenarios.upscaleChooseFactor, {
    reply_markup: buildFactorKeyboard(
      "photo",
      PHOTO_UPSCALE_FACTORS,
      PHOTO_UPSCALE_MODEL_ID,
      undefined,
    ),
  });
}

// ── Video upscale ────────────────────────────────────────────────────────────

/** Entry — user tapped «🎬 Апскейл видео» in the Scenarios submenu. */
export async function handleVideoUpscaleEnter(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.clearMediaInputs(ctx.user.id, VIDEO_UPSCALE_BUFFER_MODEL_ID);
  await userStateService.setState(ctx.user.id, "VIDEO_UPSCALE_AWAIT_VIDEO", null);

  const welcome = [`<b>${ctx.t.scenarios.videoUpscale}</b>`, ctx.t.scenarios.videoUpscaleWelcome]
    .filter(Boolean)
    .join("\n\n");
  await ctx.reply(welcome, { parse_mode: "HTML" });
  await ctx.reply(ctx.t.scenarios.videoUpscaleStep, { parse_mode: "HTML" });
}

/** Handles a video (or video-document) in VIDEO_UPSCALE_AWAIT_VIDEO. */
export async function handleVideoUpscaleVideo(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  const mediaGroupId = ctx.message?.media_group_id;
  const mediaGroupKey = mediaGroupId ? `${ctx.user.id}:${mediaGroupId}` : null;
  if (mediaGroupKey && processedMediaGroups.has(mediaGroupKey)) return;

  let fileId: string | undefined;
  let fileSize: number | undefined;
  let durationSec: number | undefined;
  // KIE Topaz принимает video/mp4, video/quicktime, video/x-matroska — для
  // video-документа сохраняем исходный mime/расширение, чтобы KIE-upload
  // и Topaz не отбраковали .mov/.mkv как невалидный mp4.
  let contentType = "video/mp4";
  let ext = "mp4";
  if (ctx.message?.video) {
    fileId = ctx.message.video.file_id;
    fileSize = ctx.message.video.file_size;
    durationSec = ctx.message.video.duration;
  } else if (ctx.message?.document?.mime_type?.startsWith("video/")) {
    fileId = ctx.message.document.file_id;
    fileSize = ctx.message.document.file_size;
    contentType = ctx.message.document.mime_type;
    ext = contentType.includes("matroska")
      ? "mkv"
      : contentType.includes("quicktime")
        ? "mov"
        : "mp4";
  }
  if (!fileId) {
    await ctx.reply(ctx.t.scenarios.upscaleNotVideo);
    return;
  }
  if (fileSize !== undefined && fileSize > TG_DOWNLOAD_LIMIT_BYTES) {
    await ctx.reply(ctx.t.scenarios.upscaleFileTooLarge);
    return;
  }

  const userId = ctx.user.id;
  const file = await ctx.api.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;

  // Топаз тарифицируется посекундно — длительность нужна для расчёта цены.
  // Для `video` Telegram отдаёт duration в сообщении; для video-документа
  // парсим moov-атом сами.
  if (durationSec === undefined) {
    durationSec = await probeVideoMetadata(tgUrl)
      .then((info) => info.durationSec ?? undefined)
      .catch(() => undefined);
  }
  if (!durationSec || durationSec <= 0) {
    await ctx.reply(ctx.t.scenarios.upscaleVideoUnreadable);
    return;
  }

  const s3Key = `video_upscale/${userId.toString()}/${Date.now()}.${ext}`;
  const uploadedKey = await s3Service.uploadFromUrl(s3Key, tgUrl, contentType).catch(() => null);
  if (!uploadedKey) {
    await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.videoUpscale, "video"));
    return;
  }

  const roundedDuration = Math.round(durationSec);
  await userStateService.addMediaInput(
    userId,
    VIDEO_UPSCALE_BUFFER_MODEL_ID,
    UPSCALE_SLOT,
    uploadedKey,
    true,
  );
  await userStateService.addMediaInput(
    userId,
    VIDEO_UPSCALE_BUFFER_MODEL_ID,
    UPSCALE_DUR_SLOT,
    String(roundedDuration),
    true,
  );
  if (mediaGroupKey) rememberMediaGroup(mediaGroupKey);

  await ctx.reply(ctx.t.scenarios.upscaleChooseFactor, {
    reply_markup: buildFactorKeyboard(
      "video",
      VIDEO_UPSCALE_FACTORS,
      VIDEO_UPSCALE_MODEL_ID,
      roundedDuration,
    ),
  });
}

// ── Factor selection callback ────────────────────────────────────────────────

/** Handles `upscale:photo:<factor>` / `upscale:video:<factor>`. */
export async function handleUpscaleFactorSelect(ctx: BotContext): Promise<void> {
  if (!ctx.user || !ctx.callbackQuery?.data) return;
  const parts = ctx.callbackQuery.data.split(":");
  const kind = parts[1];
  const factor = parts[2];
  if ((kind !== "photo" && kind !== "video") || !factor) {
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.answerCallbackQuery();
  // Гасим клавиатуру выбора, чтобы юзер не запустил апскейл повторно.
  await ctx.editMessageReplyMarkup().catch(() => void 0);

  const userId = ctx.user.id;
  const isPhoto = kind === "photo";
  const bufferId = isPhoto ? PHOTO_UPSCALE_BUFFER_MODEL_ID : VIDEO_UPSCALE_BUFFER_MODEL_ID;
  const scenarioLabel = isPhoto ? ctx.t.scenarios.photoUpscale : ctx.t.scenarios.videoUpscale;
  const awaitState = isPhoto ? "PHOTO_UPSCALE_AWAIT_PHOTO" : "VIDEO_UPSCALE_AWAIT_VIDEO";
  const section = isPhoto ? "design" : "video";

  const slots = await userStateService.getMediaInputs(userId, bufferId);
  const srcKey = slots[UPSCALE_SLOT]?.[0];
  if (!srcKey) {
    // Буфер очищен (выход в меню и т.п.) — просим прислать файл заново.
    await userStateService.setState(userId, awaitState, null);
    await ctx.reply(isPhoto ? ctx.t.scenarios.photoUpscaleStep : ctx.t.scenarios.videoUpscaleStep, {
      parse_mode: "HTML",
    });
    return;
  }

  // Видео тарифицируется посекундно — без валидной длительности из буфера
  // (повреждённый буфер / клавиатура от старой версии бота) цену не посчитать.
  let videoDurationSec = 0;
  if (!isPhoto) {
    videoDurationSec = Number(slots[UPSCALE_DUR_SLOT]?.[0]);
    if (!Number.isFinite(videoDurationSec) || videoDurationSec <= 0) {
      await userStateService.clearMediaInputs(userId, bufferId);
      await userStateService.setState(userId, awaitState, null);
      await ctx.reply(ctx.t.scenarios.upscaleVideoUnreadable);
      return;
    }
  }

  const chatId = ctx.chat?.id ?? (ctx.user.telegramId ? Number(ctx.user.telegramId) : undefined);
  if (chatId === undefined) return;

  let resolved: Record<string, string[]>;
  try {
    resolved = await resolveMediaInputUrls({ [UPSCALE_SLOT]: [srcKey] });
  } catch (err) {
    if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Upscale: failed to resolve media URL");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, scenarioLabel, section));
    }
    await userStateService.clearMediaInputs(userId, bufferId);
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
    return;
  }
  const srcUrl = resolved[UPSCALE_SLOT]?.[0];
  if (!srcUrl) {
    await userStateService.setState(userId, awaitState, null);
    await ctx.reply(isPhoto ? ctx.t.scenarios.photoUpscaleStep : ctx.t.scenarios.videoUpscaleStep, {
      parse_mode: "HTML",
    });
    return;
  }

  await ctx.reply(ctx.t.scenarios.upscaleGenerating);

  let submitOk = false;
  try {
    if (isPhoto) {
      await generationService.submitImage({
        userId,
        modelId: PHOTO_UPSCALE_MODEL_ID,
        prompt: "",
        mediaInputs: { edit: [srcUrl] },
        extraModelSettings: { upscale_factor: factor },
        telegramChatId: chatId,
        sendOriginalLabel: ctx.t.common.sendOriginal,
        displayNameOverride: scenarioLabel,
        hidePromptInCaption: true,
        hideRefineButton: true,
      });
    } else {
      // `videoDurationSec` взята из буфера (рядом с файлом) и уже провалидирована
      // выше — тап по устаревшей клавиатуре не тарифицирует по чужой длительности.
      await videoGenerationService.submitVideo({
        userId,
        modelId: VIDEO_UPSCALE_MODEL_ID,
        prompt: "",
        mediaInputs: { motion_video: [srcUrl] },
        extraModelSettings: { upscale_factor: factor },
        duration: videoDurationSec,
        telegramChatId: chatId,
        sendOriginalLabel: ctx.t.common.sendOriginal,
      });
    }
    submitOk = true;
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "NO_SUBSCRIPTION") {
      await replyNoSubscription(ctx);
    } else if (err instanceof Error && err.message === "INSUFFICIENT_TOKENS") {
      await replyInsufficientTokens(ctx);
    } else if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Upscale submit failed");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, scenarioLabel, section));
    }
  }

  if (submitOk) {
    await userStateService.clearMediaInputs(userId, bufferId);
    // Авто-рестарт: следующий присланный файл стартует новый апскейл.
    await userStateService.setState(userId, awaitState, null);
  } else {
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
  }
}
