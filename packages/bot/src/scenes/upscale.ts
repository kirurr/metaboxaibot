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
  UPSCALE_MAX_OUTPUT_MP,
  videoResolutionTier,
  videoFpsTier,
  photoEffectiveMpTier,
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

/** Default source dimensions when a probe fails to read them. */
const DEFAULT_VIDEO_HEIGHT = 1080;
const DEFAULT_VIDEO_FPS = 30;
const DEFAULT_PHOTO_MP = 2;

/**
 * Buffer slot keys. Файл и метаданные исходника хранятся в `UserState`
 * между загрузкой и тапом по кнопке выбора фактора. Метаданные нужны и
 * для подписи цены на кнопке, и при сабмите — поэтому читаются из буфера
 * (текущего файла), а не из callback_data: тап по устаревшей клавиатуре
 * после повторной загрузки не должен тарифицировать по прошлому файлу.
 */
const UPSCALE_SLOT = "src";
const UPSCALE_DUR_SLOT = "dur";
const UPSCALE_HEIGHT_SLOT = "h";
const UPSCALE_FPS_SLOT = "fps";
const UPSCALE_MP_SLOT = "mp";

/** Probed source metadata used for dynamic, output-based pricing. */
interface UpscaleMeta {
  /** Video duration in seconds. */
  durationSec?: number;
  /** Source video height in px. */
  heightPx?: number;
  /** Source video fps. */
  fps?: number;
  /** Source image megapixels. */
  inputMp?: number;
}

/**
 * Видео-расширения, по которым принимаем документ, даже если Telegram прислал
 * generic mime (`application/octet-stream` / пусто) — так делают некоторые
 * клиенты. Только ISO-BMFF (mp4/mov) — их умеет читать `probeVideoMetadata`.
 */
const VIDEO_DOC_EXT_RE = /\.(mp4|mov|m4v)$/i;

/** True если Telegram-документ — это видео (по mime ИЛИ по расширению имени). */
export function isVideoDocument(doc: { mime_type?: string; file_name?: string }): boolean {
  return !!doc.mime_type?.startsWith("video/") || VIDEO_DOC_EXT_RE.test(doc.file_name ?? "");
}

/**
 * Расширения изображений, по которым принимаем документ при generic mime —
 * симметрично `isVideoDocument`. Формат всё равно нормализуется через sharp.
 */
const IMAGE_DOC_EXT_RE = /\.(jpe?g|png|webp|heic|heif)$/i;

/** True если Telegram-документ — это изображение (по mime ИЛИ по расширению). */
export function isImageDocument(doc: { mime_type?: string; file_name?: string }): boolean {
  return !!doc.mime_type?.startsWith("image/") || IMAGE_DOC_EXT_RE.test(doc.file_name ?? "");
}

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

/**
 * modelSettings для конкретного фактора — используются и для расчёта цены
 * на кнопке, и при сабмите (`extraModelSettings`). Цена считается по
 * результату: фото — тир мегапикселей, видео — фактор × разрешение × fps.
 */
function upscaleSettings(
  kind: "photo" | "video",
  factor: string,
  meta: UpscaleMeta,
): Record<string, string> {
  if (kind === "photo") {
    return {
      upscale_factor: factor,
      mp_tier: photoEffectiveMpTier(meta.inputMp ?? DEFAULT_PHOTO_MP, factor),
    };
  }
  return {
    upscale_factor: factor,
    target_resolution: videoResolutionTier(meta.heightPx ?? DEFAULT_VIDEO_HEIGHT, Number(factor)),
    fps: videoFpsTier(meta.fps ?? DEFAULT_VIDEO_FPS),
  };
}

/** Builds the factor-selection inline keyboard with per-factor token cost. */
function buildFactorKeyboard(
  kind: "photo" | "video",
  factors: readonly string[],
  modelId: string,
  meta: UpscaleMeta,
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
        upscaleSettings(kind, f, meta),
        kind === "video" ? meta.durationSec : undefined,
      );
      label = `×${f} · ${cost.toFixed(2)} ✦`;
    }
    kb.text(label, `upscale:${kind}:${f}`).row();
  }
  return kb;
}

// ── Photo upscale ────────────────────────────────────────────────────────────

/** Entry — user tapped «📷 Апскейл фото» in the Scenarios submenu. */
export async function handlePhotoUpscaleEnter(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.clearMediaInputs(ctx.user.id, PHOTO_UPSCALE_BUFFER_MODEL_ID);
  await userStateService.setState(ctx.user.id, "PHOTO_UPSCALE_AWAIT_PHOTO", null);

  const text = [
    `<b>${ctx.t.scenarios.photoUpscale}</b>`,
    ctx.t.scenarios.photoUpscaleWelcome,
    ctx.t.scenarios.photoUpscaleStep,
  ].join("\n\n");
  await ctx.reply(text, { parse_mode: "HTML" });
}

/** Handles a photo (compressed or image-document) in PHOTO_UPSCALE_AWAIT_PHOTO. */
export async function handlePhotoUpscalePhoto(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  const mediaGroupId = ctx.message?.media_group_id;
  const mediaGroupKey = mediaGroupId ? `${ctx.user.id}:${mediaGroupId}` : null;
  if (mediaGroupKey && processedMediaGroups.has(mediaGroupKey)) return;

  let fileId: string | undefined;
  let fileSize: number | undefined;
  if (ctx.message?.photo) {
    const largest = ctx.message.photo.at(-1);
    fileId = largest?.file_id;
    fileSize = largest?.file_size;
  } else if (ctx.message?.document && isImageDocument(ctx.message.document)) {
    fileId = ctx.message.document.file_id;
    fileSize = ctx.message.document.file_size;
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
  // Перекодируем вход в JPEG: Topaz отбивает HEIC / CMYK / 16-bit /
  // прогрессивный JPEG и т.п. («Image format error»). uploadNormalizedImage
  // заодно отдаёт мегапиксели результата — отдельное измерение не нужно.
  const s3Key = `photo_upscale/${userId.toString()}/${Date.now()}.jpg`;
  const normalized = await s3Service.uploadNormalizedImage(s3Key, tgUrl).catch(() => null);
  if (!normalized) {
    await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.photoUpscale, "design"));
    return;
  }
  const uploadedKey = normalized.key;
  const meta: UpscaleMeta = { inputMp: normalized.megapixels };

  // Факторы, чей результат укладывается в потолок Topaz. Если даже минимальный
  // фактor не влезает — фото слишком крупное; не показываем обречённую
  // клавиатуру (юзер бы зациклился на единственной кнопке), сразу — понятная
  // ошибка. Состояние не меняем — следующее (меньшее) фото обработается.
  const allowedFactors = PHOTO_UPSCALE_FACTORS.filter(
    (f) => normalized.megapixels * Number(f) ** 2 <= UPSCALE_MAX_OUTPUT_MP,
  );
  if (allowedFactors.length === 0) {
    await ctx.reply(ctx.t.errors.upscaleResultTooLarge);
    return;
  }

  await userStateService.addMediaInput(
    userId,
    PHOTO_UPSCALE_BUFFER_MODEL_ID,
    UPSCALE_SLOT,
    uploadedKey,
    true,
  );
  await userStateService.addMediaInput(
    userId,
    PHOTO_UPSCALE_BUFFER_MODEL_ID,
    UPSCALE_MP_SLOT,
    String(normalized.megapixels),
    true,
  );
  if (mediaGroupKey) rememberMediaGroup(mediaGroupKey);

  await ctx.reply(ctx.t.scenarios.upscaleChooseFactor, {
    reply_markup: buildFactorKeyboard("photo", allowedFactors, PHOTO_UPSCALE_MODEL_ID, meta),
  });
}

// ── Video upscale ────────────────────────────────────────────────────────────

/** Entry — user tapped «🎬 Апскейл видео» in the Scenarios submenu. */
export async function handleVideoUpscaleEnter(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.clearMediaInputs(ctx.user.id, VIDEO_UPSCALE_BUFFER_MODEL_ID);
  await userStateService.setState(ctx.user.id, "VIDEO_UPSCALE_AWAIT_VIDEO", null);

  const text = [
    `<b>${ctx.t.scenarios.videoUpscale}</b>`,
    ctx.t.scenarios.videoUpscaleWelcome,
    ctx.t.scenarios.videoUpscaleStep,
  ].join("\n\n");
  await ctx.reply(text, { parse_mode: "HTML" });
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
  let heightPx: number | undefined;
  // KIE Topaz принимает video/mp4, video/quicktime, video/x-matroska — для
  // video-документа сохраняем исходный mime/расширение, чтобы KIE-upload
  // и Topaz не отбраковали .mov/.mkv как невалидный mp4.
  let contentType = "video/mp4";
  let ext = "mp4";
  if (ctx.message?.video) {
    fileId = ctx.message.video.file_id;
    fileSize = ctx.message.video.file_size;
    durationSec = ctx.message.video.duration;
    heightPx = ctx.message.video.height;
  } else if (ctx.message?.document && isVideoDocument(ctx.message.document)) {
    const doc = ctx.message.document;
    fileId = doc.file_id;
    fileSize = doc.file_size;
    // mime может быть generic (octet-stream) — тогда контейнер определяем по
    // расширению имени файла.
    const mime = doc.mime_type ?? "";
    const name = (doc.file_name ?? "").toLowerCase();
    if (mime.startsWith("video/")) {
      contentType = mime;
    } else if (name.endsWith(".mov") || name.endsWith(".m4v")) {
      contentType = "video/quicktime";
    } else {
      contentType = "video/mp4";
    }
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

  // Цена видео-апскейла зависит от длительности, разрешения и fps результата —
  // парсим moov-атом исходника. `video` Telegram отдаёт duration/height в
  // сообщении, но не fps; mp4-документ — всё из парсера.
  const probe = await probeVideoMetadata(tgUrl).catch(() => null);
  durationSec = durationSec ?? probe?.durationSec ?? undefined;
  heightPx = heightPx ?? probe?.height ?? undefined;
  const fps = probe?.fps ?? undefined;
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

  // Округляем длительность ВВЕРХ: воркер списывает по фактической длительности
  // результата (≈ длительность исходника, дробная), а на кнопке показываем
  // целые секунды — ceil гарантирует «показанное ≥ списанного».
  const billingDuration = Math.ceil(durationSec);
  const meta: UpscaleMeta = { durationSec: billingDuration, heightPx, fps };
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
    String(billingDuration),
    true,
  );
  await userStateService.addMediaInput(
    userId,
    VIDEO_UPSCALE_BUFFER_MODEL_ID,
    UPSCALE_HEIGHT_SLOT,
    String(heightPx ?? DEFAULT_VIDEO_HEIGHT),
    true,
  );
  await userStateService.addMediaInput(
    userId,
    VIDEO_UPSCALE_BUFFER_MODEL_ID,
    UPSCALE_FPS_SLOT,
    String(fps ?? DEFAULT_VIDEO_FPS),
    true,
  );
  if (mediaGroupKey) rememberMediaGroup(mediaGroupKey);

  await ctx.reply(ctx.t.scenarios.upscaleChooseFactor, {
    reply_markup: buildFactorKeyboard("video", VIDEO_UPSCALE_FACTORS, VIDEO_UPSCALE_MODEL_ID, meta),
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

  // Метаданные исходника берём из буфера (рядом с файлом) — тап по устаревшей
  // клавиатуре тарифицирует ровно по текущему файлу, не по прошлому.
  const meta: UpscaleMeta = isPhoto
    ? { inputMp: Number(slots[UPSCALE_MP_SLOT]?.[0]) || DEFAULT_PHOTO_MP }
    : {
        durationSec: Number(slots[UPSCALE_DUR_SLOT]?.[0]),
        heightPx: Number(slots[UPSCALE_HEIGHT_SLOT]?.[0]) || DEFAULT_VIDEO_HEIGHT,
        fps: Number(slots[UPSCALE_FPS_SLOT]?.[0]) || DEFAULT_VIDEO_FPS,
      };

  if (
    !isPhoto &&
    (!meta.durationSec || !Number.isFinite(meta.durationSec) || meta.durationSec <= 0)
  ) {
    // Длительность не прочиталась (повреждённый буфер) — без неё посекундную
    // цену не посчитать.
    await userStateService.clearMediaInputs(userId, bufferId);
    await userStateService.setState(userId, awaitState, null);
    await ctx.reply(ctx.t.scenarios.upscaleVideoUnreadable);
    return;
  }

  // Тап по устаревшей клавиатуре (юзер загрузил фото поверх) мог принести
  // фактор, который для текущего файла превышает потолок Topaz. Перепроверяем
  // зажим и, если не проходит, показываем свежую клавиатуру с валидными
  // факторами вместо обречённого сабмита.
  if (isPhoto) {
    const inputMp = meta.inputMp ?? DEFAULT_PHOTO_MP;
    if (inputMp * Number(factor) ** 2 > UPSCALE_MAX_OUTPUT_MP) {
      const allowed = PHOTO_UPSCALE_FACTORS.filter(
        (f) => inputMp * Number(f) ** 2 <= UPSCALE_MAX_OUTPUT_MP,
      );
      if (allowed.length === 0) {
        // Даже минимальный фактор не влезает — фото слишком крупное. НЕ
        // перерисовываем клавиатуру (зациклили бы юзера на ×2), сразу ошибка.
        await userStateService.clearMediaInputs(userId, bufferId);
        await userStateService.setState(userId, awaitState, null);
        await ctx.reply(ctx.t.errors.upscaleResultTooLarge);
        return;
      }
      await ctx.reply(ctx.t.scenarios.upscaleChooseFactor, {
        reply_markup: buildFactorKeyboard("photo", allowed, PHOTO_UPSCALE_MODEL_ID, meta),
      });
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

  // Настройки цены/адаптеров — одни и те же, что показаны на кнопке.
  const settings = upscaleSettings(kind, factor, meta);

  let submitOk = false;
  try {
    if (isPhoto) {
      await generationService.submitImage({
        userId,
        modelId: PHOTO_UPSCALE_MODEL_ID,
        prompt: "",
        mediaInputs: { edit: [srcUrl] },
        extraModelSettings: settings,
        telegramChatId: chatId,
        sendOriginalLabel: ctx.t.common.sendOriginal,
        displayNameOverride: scenarioLabel,
        hidePromptInCaption: true,
        hideRefineButton: true,
      });
    } else {
      await videoGenerationService.submitVideo({
        userId,
        modelId: VIDEO_UPSCALE_MODEL_ID,
        prompt: "",
        mediaInputs: { motion_video: [srcUrl] },
        extraModelSettings: settings,
        duration: meta.durationSec,
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
