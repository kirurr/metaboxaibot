import type { BotContext } from "../types/context.js";
import {
  generationService,
  videoGenerationService,
  userStateService,
  s3Service,
  calculateCost,
  ImageDecodeError,
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
  VIDEO_UPSCALE_FACTORS,
  videoResolutionTier,
  videoFpsTier,
} from "@metabox/shared";
import { InlineKeyboard } from "grammy";
import { logger } from "../logger.js";
import { buildCostLine } from "../utils/cost-line.js";
import { resolveMediaInputUrls } from "../utils/media-input-state.js";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";

/** Telegram Bot API hard cap on `getFile` downloads. */
const TG_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * Nano Banana (через KIE / evolink) отбивает входные изображения больше 10 МБ.
 * Telegram отдаёт image-документы до 20 МБ, поэтому фото-апскейл режем строже
 * generic download-лимита — иначе 10–20 МБ файл уходит провайдеру и падает там
 * с generic-ошибкой вместо понятного «фото слишком большое».
 */
const UPSCALE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Default source dimensions when a probe fails to read them. */
const DEFAULT_VIDEO_HEIGHT = 1080;
const DEFAULT_VIDEO_FPS = 30;

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

/** Probed source video metadata used for dynamic, output-based pricing. */
interface UpscaleMeta {
  /** Video duration in seconds. */
  durationSec?: number;
  /** Source video height in px. */
  heightPx?: number;
  /** Source video fps. */
  fps?: number;
}

/**
 * Фото-апскейл = модель `image-upscale` (nano-banana-pro под капотом). Юзер
 * ничего не настраивает: разрешение 4K, формат повторяет вход (`auto`), промт
 * и output_format зашиты тут. nano-banana как модель нигде не светится.
 */
const PHOTO_UPSCALE_PROMPT =
  "High-resolution 4K enhancement, photorealistic, hyper-detailed, crystal clear texture, sharp focus, professionally restored, maintaining exact original features and composition, no distortion, cinematic lighting.";
const PHOTO_UPSCALE_SETTINGS: Record<string, string> = {
  resolution: "4K",
  aspect_ratio: "auto",
  output_format: "png",
};

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
 * симметрично `isVideoDocument`. Список лояльный: всё, что разумно похоже на
 * фото-формат. Что sharp сможет — нормализуется (jpeg/png/webp/tiff/gif/avif),
 * что не сможет (heic/heif/bmp/прочее) — отдаст decode-error, scene покажет
 * понятное сообщение «не удалось обработать формат».
 */
const IMAGE_DOC_EXT_RE = /\.(jpe?g|jfif|png|webp|tiff?|gif|avif|heic|heif|bmp)$/i;

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
 * modelSettings видео-апскейла на конкретном факторе — и для цены на кнопке,
 * и для сабмита (`extraModelSettings`). Цена считается по результату:
 * фактор × разрешение × fps.
 */
function videoUpscaleSettings(factor: string, meta: UpscaleMeta): Record<string, string> {
  return {
    upscale_factor: factor,
    target_resolution: videoResolutionTier(meta.heightPx ?? DEFAULT_VIDEO_HEIGHT, Number(factor)),
    fps: videoFpsTier(meta.fps ?? DEFAULT_VIDEO_FPS),
  };
}

/** Builds the video-upscale factor-selection inline keyboard with per-factor token cost. */
function buildVideoFactorKeyboard(
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
        videoUpscaleSettings(f, meta),
        meta.durationSec,
      );
      label = `×${f} · ${cost.toFixed(2)} ✦`;
    }
    kb.text(label, `upscale:video:${f}`).row();
  }
  return kb;
}

// ── Photo upscale ────────────────────────────────────────────────────────────

/** Entry — user tapped «📷 Апскейл фото» in the Scenarios submenu. */
export async function handlePhotoUpscaleEnter(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.clearMediaInputs(ctx.user.id, PHOTO_UPSCALE_BUFFER_MODEL_ID);
  await userStateService.setState(ctx.user.id, "PHOTO_UPSCALE_AWAIT_PHOTO", null);

  // Цена показывается в welcome, т.к. апскейл идёт сразу после загрузки фото
  // (без кнопки-подтверждения) — юзер должен увидеть стоимость ДО отправки.
  const model = AI_MODELS[PHOTO_UPSCALE_MODEL_ID];
  const costLine = model ? buildCostLine(model, PHOTO_UPSCALE_SETTINGS, ctx.t) : "";
  const text = [
    `<b>${ctx.t.scenarios.photoUpscale}</b>`,
    ctx.t.scenarios.photoUpscaleWelcome,
    ctx.t.scenarios.photoUpscaleStep,
    costLine,
  ]
    .filter(Boolean)
    .join("\n\n");
  await ctx.reply(text, { parse_mode: "HTML" });
}

/**
 * Принимает фото (compressed или image-document) в PHOTO_UPSCALE_AWAIT_PHOTO
 * и сразу же запускает апскейл — одинаковый флоу с остальными scenario-
 * пресетами (object-removal / bg-removal / photo-animate): загрузка = намерение,
 * никакой промежуточной кнопки подтверждения.
 */
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
  if (fileSize !== undefined && fileSize > UPSCALE_IMAGE_MAX_BYTES) {
    await ctx.reply(ctx.t.scenarios.upscalePhotoTooLarge);
    return;
  }

  const userId = ctx.user.id;
  // Album dedup регистрируем ДО upload'а: на decode-failure первого фото из
  // альбома мы не хотим получить N одинаковых сообщений «формат не
  // поддерживается» по числу siblings. Failure первого = «альбом обработан».
  if (mediaGroupKey) rememberMediaGroup(mediaGroupKey);
  const file = await ctx.api.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
  // Перекодируем вход в JPEG: nano-banana отбивает CMYK / 16-bit /
  // прогрессивный JPEG и т.п. uploadNormalizedImage заодно грузит файл в S3.
  // HEIC файлом sharp не парсит — юзер получит сообщение «пришли из галереи».
  const s3Key = `photo_upscale/${userId.toString()}/${Date.now()}.jpg`;
  let normalized;
  try {
    normalized = await s3Service.uploadNormalizedImage(s3Key, tgUrl);
  } catch (err) {
    if (err instanceof ImageDecodeError) {
      await ctx.reply(ctx.t.scenarios.imageDecodeFailed);
    } else {
      logger.error(err, "Photo upscale: upload normalize failed");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.photoUpscale, "design"));
    }
    return;
  }
  if (mediaGroupKey) {
    await ctx.reply(ctx.t.scenarios.upscaleAlbumNotice);
  }

  await userStateService.addMediaInput(
    userId,
    PHOTO_UPSCALE_BUFFER_MODEL_ID,
    UPSCALE_SLOT,
    normalized.key,
    true,
  );

  const chatId = ctx.chat?.id ?? (ctx.user.telegramId ? Number(ctx.user.telegramId) : undefined);
  if (chatId === undefined) return;

  let resolved: Record<string, string[]>;
  try {
    resolved = await resolveMediaInputUrls({ [UPSCALE_SLOT]: [normalized.key] });
  } catch (err) {
    if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Photo upscale: failed to resolve media URL");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.photoUpscale, "design"));
    }
    await userStateService.clearMediaInputs(userId, PHOTO_UPSCALE_BUFFER_MODEL_ID);
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
    return;
  }
  const srcUrl = resolved[UPSCALE_SLOT]?.[0];
  if (!srcUrl) {
    await ctx.reply(ctx.t.scenarios.photoUpscaleStep, { parse_mode: "HTML" });
    return;
  }

  await ctx.reply(ctx.t.scenarios.upscaleGenerating);

  let submitOk = false;
  try {
    await generationService.submitImage({
      userId,
      modelId: PHOTO_UPSCALE_MODEL_ID,
      prompt: PHOTO_UPSCALE_PROMPT,
      mediaInputs: { edit: [srcUrl] },
      extraModelSettings: PHOTO_UPSCALE_SETTINGS,
      telegramChatId: chatId,
      sendOriginalLabel: ctx.t.common.sendOriginal,
      displayNameOverride: ctx.t.scenarios.photoUpscale,
      hidePromptInCaption: true,
      hideRefineButton: true,
    });
    submitOk = true;
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "NO_SUBSCRIPTION") {
      await replyNoSubscription(ctx);
    } else if (err instanceof Error && err.message === "INSUFFICIENT_TOKENS") {
      await replyInsufficientTokens(ctx);
    } else if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Photo upscale submit failed");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.photoUpscale, "design"));
    }
  }

  await userStateService.clearMediaInputs(userId, PHOTO_UPSCALE_BUFFER_MODEL_ID);
  await userStateService.setState(
    userId,
    submitOk ? "PHOTO_UPSCALE_AWAIT_PHOTO" : "SCENARIOS_SECTION",
    null,
  );
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

  const s3Key = `video_upscale/${userId.toString()}/${Date.now()}.${ext}`;
  const uploadedKey = await s3Service.uploadFromUrl(s3Key, tgUrl, contentType).catch(() => null);
  if (!uploadedKey) {
    await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.videoUpscale, "video"));
    return;
  }

  // Метаданные (duration/height/fps) пробим с НАШЕЙ S3-копии, а не с
  // Telegram-URL: Telegram-ссылки протухают и флапают → высота читалась
  // нестабильно и цена на кнопке плавала. `video`-сообщение даёт
  // duration/height сразу; mp4-документ — из парсера; fps Telegram не отдаёт.
  const s3Url = await s3Service.getFileUrl(uploadedKey).catch(() => null);
  const probe = s3Url ? await probeVideoMetadata(s3Url).catch(() => null) : null;
  durationSec = durationSec ?? probe?.durationSec ?? undefined;
  heightPx = heightPx ?? probe?.height ?? undefined;
  const fps = probe?.fps ?? undefined;
  if (!durationSec || durationSec <= 0) {
    await ctx.reply(ctx.t.scenarios.upscaleVideoUnreadable);
    return;
  }
  // Высота не прочиталась — без неё цена считается по DEFAULT-высоте и врёт.
  // Отклоняем, как и нечитаемую длительность, а не подставляем заглушку молча.
  if (!heightPx || heightPx <= 0) {
    await ctx.reply(ctx.t.scenarios.upscaleVideoUnreadable);
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
    reply_markup: buildVideoFactorKeyboard(VIDEO_UPSCALE_FACTORS, VIDEO_UPSCALE_MODEL_ID, meta),
  });
}

// ── Video factor selection callback ─────────────────────────────────────────

/**
 * Handles `upscale:video:<factor>`. Фото-апскейл больше не использует callback
 * (сабмит идёт сразу из `handlePhotoUpscalePhoto`), но видео-апскейл всё ещё
 * требует выбор фактора (×2/×4 с разной ценой).
 */
export async function handleUpscaleFactorSelect(ctx: BotContext): Promise<void> {
  if (!ctx.user || !ctx.callbackQuery?.data) return;
  const parts = ctx.callbackQuery.data.split(":");
  const kind = parts[1];
  const factor = parts[2];
  if (kind !== "video" || !factor) {
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.answerCallbackQuery();
  // Гасим клавиатуру выбора, чтобы юзер не запустил апскейл повторно.
  await ctx.editMessageReplyMarkup().catch(() => void 0);

  const userId = ctx.user.id;
  const scenarioLabel = ctx.t.scenarios.videoUpscale;

  const slots = await userStateService.getMediaInputs(userId, VIDEO_UPSCALE_BUFFER_MODEL_ID);
  const srcKey = slots[UPSCALE_SLOT]?.[0];
  if (!srcKey) {
    // Буфер очищен (выход в меню и т.п.) — просим прислать файл заново.
    await userStateService.setState(userId, "VIDEO_UPSCALE_AWAIT_VIDEO", null);
    await ctx.reply(ctx.t.scenarios.videoUpscaleStep, { parse_mode: "HTML" });
    return;
  }

  const meta: UpscaleMeta = {
    durationSec: Number(slots[UPSCALE_DUR_SLOT]?.[0]),
    heightPx: Number(slots[UPSCALE_HEIGHT_SLOT]?.[0]) || DEFAULT_VIDEO_HEIGHT,
    fps: Number(slots[UPSCALE_FPS_SLOT]?.[0]) || DEFAULT_VIDEO_FPS,
  };

  if (!meta.durationSec || !Number.isFinite(meta.durationSec) || meta.durationSec <= 0) {
    // Длительность не прочиталась (повреждённый буфер) — без неё посекундную
    // цену не посчитать.
    await userStateService.clearMediaInputs(userId, VIDEO_UPSCALE_BUFFER_MODEL_ID);
    await userStateService.setState(userId, "VIDEO_UPSCALE_AWAIT_VIDEO", null);
    await ctx.reply(ctx.t.scenarios.upscaleVideoUnreadable);
    return;
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
      logger.error(err, "Video upscale: failed to resolve media URL");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, scenarioLabel, "video"));
    }
    await userStateService.clearMediaInputs(userId, VIDEO_UPSCALE_BUFFER_MODEL_ID);
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
    return;
  }
  const resolvedUrl = resolved[UPSCALE_SLOT]?.[0];
  if (!resolvedUrl) {
    await userStateService.setState(userId, "VIDEO_UPSCALE_AWAIT_VIDEO", null);
    await ctx.reply(ctx.t.scenarios.videoUpscaleStep, { parse_mode: "HTML" });
    return;
  }
  // Провайдеру отдаём presigned-S3 URL напрямую. НЕ через `/download/<token>` —
  // тот роут отвечает 302-редиректом на S3, а серверные downloader'ы провайдеров
  // по редиректу не идут (Fal явно: "Failed to download the assets: Redirect
  // response '302 Found'"). Presigned URL ведёт прямо на объект (200).
  const srcUrl = resolvedUrl;

  await ctx.reply(ctx.t.scenarios.upscaleGenerating);

  let submitOk = false;
  try {
    await videoGenerationService.submitVideo({
      userId,
      modelId: VIDEO_UPSCALE_MODEL_ID,
      prompt: "",
      mediaInputs: { motion_video: [srcUrl] },
      extraModelSettings: videoUpscaleSettings(factor, meta),
      duration: meta.durationSec,
      telegramChatId: chatId,
      sendOriginalLabel: ctx.t.common.sendOriginal,
    });
    submitOk = true;
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "NO_SUBSCRIPTION") {
      await replyNoSubscription(ctx);
    } else if (err instanceof Error && err.message === "INSUFFICIENT_TOKENS") {
      await replyInsufficientTokens(ctx);
    } else if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Video upscale submit failed");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, scenarioLabel, "video"));
    }
  }

  if (submitOk) {
    await userStateService.clearMediaInputs(userId, VIDEO_UPSCALE_BUFFER_MODEL_ID);
    // Авто-рестарт: следующий присланный файл стартует новый апскейл.
    await userStateService.setState(userId, "VIDEO_UPSCALE_AWAIT_VIDEO", null);
  } else {
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
  }
}
