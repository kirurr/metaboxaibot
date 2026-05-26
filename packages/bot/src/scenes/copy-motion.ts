import type { BotContext } from "../types/context.js";
import {
  videoGenerationService,
  userStateService,
  s3Service,
  ImageDecodeError,
} from "@metabox/api/services";
import { probeVideoMetadata } from "@metabox/api/utils/mp4-duration";
import {
  AI_MODELS,
  config,
  UserFacingError,
  resolveUserFacingErrorVariant,
  pickGenerationFailedMessage,
  COPY_MOTION_MODEL_ID,
  COPY_MOTION_BUFFER_MODEL_ID,
  COPY_MOTION_SLOT_IMAGE,
  COPY_MOTION_SLOT_VIDEO,
  COPY_MOTION_IMAGE_MAX_BYTES,
  COPY_MOTION_VIDEO_MAX_BYTES,
  COPY_MOTION_VIDEO_MIN_SEC,
  COPY_MOTION_VIDEO_MAX_SEC,
} from "@metabox/shared";
import { logger } from "../logger.js";
import { buildCostLine } from "../utils/cost-line.js";
import { resolveMediaInputUrls } from "../utils/media-input-state.js";
import { isImageDocument, isVideoDocument } from "./upscale.js";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";

/**
 * Сценарий «🎬 Копировать движение». Под капотом — виртуальная модель
 * `copy-motion` (= kling-3.0/motion-control @ 1080p Pro в KIE primary, с FAL
 * и Evolink fallback'ами). Юзер ничего не настраивает: грузит фото + референс-
 * видео, адаптер форсит character_orientation="video" + background_source=
 * "input_image". Длительность результата = длительность референс-видео.
 *
 * FSM:
 *   COPY_MOTION_AWAIT_PHOTO  → принимает фото → state COPY_MOTION_AWAIT_VIDEO
 *   COPY_MOTION_AWAIT_VIDEO  → принимает видео → submit → restart в AWAIT_PHOTO
 *
 * S3-ключи между шагами хранятся в `UserState.mediaInputs` под pseudo-model
 * `copy_motion` (COPY_MOTION_BUFFER_MODEL_ID), очищается на возврат в меню.
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

/** Entry — user tapped «🎬 Копировать движение» в Сценариях. */
export async function handleCopyMotionEnter(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.clearMediaInputs(ctx.user.id, COPY_MOTION_BUFFER_MODEL_ID);
  await userStateService.setState(ctx.user.id, "COPY_MOTION_AWAIT_PHOTO", null);

  const model = AI_MODELS[COPY_MOTION_MODEL_ID];
  const costLine = model ? buildCostLine(model, {}, ctx.t) : "";
  const welcome = [
    `<b>${ctx.t.scenarios.copyMotion}</b>`,
    ctx.t.scenarios.copyMotionWelcome,
    ctx.t.scenarios.copyMotionStepPhoto,
    costLine,
  ]
    .filter(Boolean)
    .join("\n\n");
  await ctx.reply(welcome, { parse_mode: "HTML" });
}

/** Step 1 — photo upload in COPY_MOTION_AWAIT_PHOTO. */
export async function handleCopyMotionPhoto(ctx: BotContext): Promise<void> {
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
    await ctx.reply(ctx.t.scenarios.copyMotionNotPhoto);
    return;
  }
  if (fileSize !== undefined && fileSize > COPY_MOTION_IMAGE_MAX_BYTES) {
    await ctx.reply(ctx.t.scenarios.copyMotionPhotoTooLarge);
    return;
  }

  const userId = ctx.user.id;
  if (mediaGroupKey) rememberMediaGroup(mediaGroupKey);
  const file = await ctx.api.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
  const s3Key = `copy_motion/${userId.toString()}/${Date.now()}.jpg`;
  let normalized;
  try {
    normalized = await s3Service.uploadNormalizedImage(s3Key, tgUrl);
  } catch (err) {
    if (err instanceof ImageDecodeError) {
      await ctx.reply(ctx.t.scenarios.imageDecodeFailed);
    } else {
      logger.error(err, "Copy motion: upload normalize failed");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.copyMotion, "video"));
    }
    return;
  }

  await userStateService.addMediaInput(
    userId,
    COPY_MOTION_BUFFER_MODEL_ID,
    COPY_MOTION_SLOT_IMAGE,
    normalized.key,
    true,
  );

  if (mediaGroupKey) {
    await ctx.reply(ctx.t.scenarios.copyMotionAlbumNotice);
  }

  await userStateService.setState(userId, "COPY_MOTION_AWAIT_VIDEO", null);
  await ctx.reply(ctx.t.scenarios.copyMotionStepVideo, { parse_mode: "HTML" });
}

/** Step 2 — reference video upload in COPY_MOTION_AWAIT_VIDEO. */
export async function handleCopyMotionVideo(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  let fileId: string | undefined;
  let fileSize: number | undefined;
  let durationSec: number | undefined;
  let contentType = "video/mp4";
  let ext = "mp4";
  if (ctx.message?.video) {
    fileId = ctx.message.video.file_id;
    fileSize = ctx.message.video.file_size;
    durationSec = ctx.message.video.duration;
  } else if (ctx.message?.document && isVideoDocument(ctx.message.document)) {
    const doc = ctx.message.document;
    fileId = doc.file_id;
    fileSize = doc.file_size;
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
    await ctx.reply(ctx.t.scenarios.copyMotionNotVideo);
    return;
  }
  if (fileSize !== undefined && fileSize > COPY_MOTION_VIDEO_MAX_BYTES) {
    await ctx.reply(ctx.t.scenarios.copyMotionVideoTooLarge);
    return;
  }

  const userId = ctx.user.id;
  const file = await ctx.api.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
  const s3Key = `copy_motion/${userId.toString()}/${Date.now()}.${ext}`;
  const uploadedKey = await s3Service.uploadFromUrl(s3Key, tgUrl, contentType).catch(() => null);
  if (!uploadedKey) {
    await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.copyMotion, "video"));
    return;
  }

  // Если Telegram не отдал duration (видео-документ) — пробим metadata с S3.
  if (!durationSec) {
    const s3Url = await s3Service.getFileUrl(uploadedKey).catch(() => null);
    const probe = s3Url ? await probeVideoMetadata(s3Url).catch(() => null) : null;
    durationSec = probe?.durationSec ?? undefined;
  }
  if (durationSec !== undefined && durationSec < COPY_MOTION_VIDEO_MIN_SEC) {
    await ctx.reply(ctx.t.scenarios.copyMotionVideoTooShort);
    return;
  }
  if (durationSec !== undefined && durationSec > COPY_MOTION_VIDEO_MAX_SEC) {
    await ctx.reply(ctx.t.scenarios.copyMotionVideoTooLong);
    return;
  }

  await userStateService.addMediaInput(
    userId,
    COPY_MOTION_BUFFER_MODEL_ID,
    COPY_MOTION_SLOT_VIDEO,
    uploadedKey,
    true,
  );

  // Читаем оба слота буфера. Фото могли потерять (clear на /menu между шагами):
  // в этом случае возвращаем юзера в шаг 1, не теряя только что загруженное видео
  // (оно лежит в буфере и подтянется следующей итерацией).
  const slots = await userStateService.getMediaInputs(userId, COPY_MOTION_BUFFER_MODEL_ID);
  const imageKey = slots[COPY_MOTION_SLOT_IMAGE]?.[0];
  const videoKey = slots[COPY_MOTION_SLOT_VIDEO]?.[0];
  if (!imageKey || !videoKey) {
    await userStateService.setState(userId, "COPY_MOTION_AWAIT_PHOTO", null);
    await ctx.reply(ctx.t.scenarios.copyMotionBufferLost);
    await ctx.reply(ctx.t.scenarios.copyMotionStepPhoto, { parse_mode: "HTML" });
    return;
  }

  const telegramId = ctx.user.telegramId;
  const chatId = ctx.chat?.id ?? (telegramId ? Number(telegramId) : undefined);
  if (chatId === undefined) return;

  let resolved: Record<string, string[]>;
  try {
    resolved = await resolveMediaInputUrls({
      [COPY_MOTION_SLOT_IMAGE]: [imageKey],
      [COPY_MOTION_SLOT_VIDEO]: [videoKey],
    });
  } catch (err) {
    if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Copy motion: failed to resolve media URLs");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.copyMotion, "video"));
    }
    await userStateService.clearMediaInputs(userId, COPY_MOTION_BUFFER_MODEL_ID);
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
    return;
  }

  await ctx.reply(ctx.t.scenarios.copyMotionGenerating);

  let submitOk = false;
  try {
    await videoGenerationService.submitVideo({
      userId,
      modelId: COPY_MOTION_MODEL_ID,
      // Промпт пустой — адаптер не использует его для kling-motion. Флаг
      // hidePromptInCaption ниже гарантирует чистую подпись результата.
      prompt: "",
      mediaInputs: resolved,
      telegramChatId: chatId,
      sendOriginalLabel: ctx.t.common.sendOriginal,
      hidePromptInCaption: true,
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
      logger.error(err, "Copy motion submit failed");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.copyMotion, "video"));
    }
  }

  // Чистим буфер всегда (на успехе — освобождаем S3-ключи, на ошибке — чтобы
  // следующий заход стартовал с чистого листа). На успехе авто-рестарт в
  // AWAIT_PHOTO: следующее фото = новый flow. На ошибке возврат в Сценарии.
  await userStateService.clearMediaInputs(userId, COPY_MOTION_BUFFER_MODEL_ID);
  await userStateService.setState(
    userId,
    submitOk ? "COPY_MOTION_AWAIT_PHOTO" : "SCENARIOS_SECTION",
    null,
  );
}
