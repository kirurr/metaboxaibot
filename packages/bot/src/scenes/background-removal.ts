import type { BotContext } from "../types/context.js";
import {
  generationService,
  userStateService,
  s3Service,
  ImageDecodeError,
} from "@metabox/api/services";
import {
  AI_MODELS,
  config,
  UserFacingError,
  resolveUserFacingErrorVariant,
  pickGenerationFailedMessage,
} from "@metabox/shared";
import { logger } from "../logger.js";
import { buildCostLine } from "../utils/cost-line.js";
import { resolveMediaInputUrls } from "../utils/media-input-state.js";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";
import { isImageDocument } from "./upscale.js";

// Сценарий «Удаление фона»: primary — fal Ideogram remove-background,
// fallback — Replicate bria/remove-background. Один входной кадр, без промпта.
const BG_REMOVAL_MODEL_ID = "bg-removal";

/**
 * Ideogram remove-background отбивает вход больше 10 МБ — режем строже
 * generic Telegram-лимита (20 МБ на getFile), чтобы дать понятную ошибку.
 */
const BG_REMOVAL_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * In-memory dedup of Telegram media groups (albums) — берём только первое
 * фото альбома, остальные siblings игнорируем (ключ `${userId}:${groupId}`).
 */
const processedMediaGroups = new Set<string>();

/** Entry — user tapped «✂️ Удаление фона» in the Scenarios submenu. */
export async function handleBackgroundRemovalEnter(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.setState(ctx.user.id, "BG_REMOVAL_AWAIT_PHOTO", null);

  const model = AI_MODELS[BG_REMOVAL_MODEL_ID];
  const costLine = model ? buildCostLine(model, {}, ctx.t) : "";
  const welcome = [
    `<b>${ctx.t.scenarios.backgroundRemoval}</b>`,
    ctx.t.scenarios.backgroundRemovalWelcome,
    ctx.t.scenarios.backgroundRemovalStep,
    costLine,
  ]
    .filter(Boolean)
    .join("\n\n");
  await ctx.reply(welcome, { parse_mode: "HTML" });
}

/** Handles a photo (compressed or image-document) in BG_REMOVAL_AWAIT_PHOTO. */
export async function handleBackgroundRemovalPhoto(ctx: BotContext): Promise<void> {
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
    await ctx.reply(ctx.t.scenarios.backgroundRemovalNotPhoto);
    return;
  }
  if (fileSize !== undefined && fileSize > BG_REMOVAL_IMAGE_MAX_BYTES) {
    await ctx.reply(ctx.t.scenarios.backgroundRemovalPhotoTooLarge);
    return;
  }

  const userId = ctx.user.id;
  // Album dedup регистрируем ДО upload'а: если первое фото альбома
  // декод-failed (например HEIC и heic-convert не справился), мы не хотим
  // получить N одинаковых сообщений «формат не поддерживается» на каждый
  // sibling. По спецификации «берётся только первое фото альбома» — failure
  // первого тоже считается «обработали».
  if (mediaGroupKey) {
    processedMediaGroups.add(mediaGroupKey);
    if (processedMediaGroups.size > 1000) {
      const iter = processedMediaGroups.values();
      for (let i = 0; i < 100; i++) {
        const v = iter.next().value;
        if (v) processedMediaGroups.delete(v);
      }
    }
  }
  const file = await ctx.api.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
  // Перекодируем вход в JPEG (uploadNormalizedImage заодно грузит в S3) —
  // провайдеры отбивают HEIC / CMYK / 16-bit и т.п. HEIC от iPhone декодится
  // через heic-convert. На decode-failure показываем юзеру понятное «формат
  // не поддерживается», а не generic «модель отдыхает».
  const s3Key = `bg_removal/${userId.toString()}/${Date.now()}.jpg`;
  let normalized;
  try {
    normalized = await s3Service.uploadNormalizedImage(s3Key, tgUrl);
  } catch (err) {
    if (err instanceof ImageDecodeError) {
      await ctx.reply(ctx.t.scenarios.imageDecodeFailed);
    } else {
      logger.error(err, "BG removal: upload normalize failed");
      await ctx.reply(
        pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.backgroundRemoval, "design"),
      );
    }
    return;
  }
  if (mediaGroupKey) {
    await ctx.reply(ctx.t.scenarios.backgroundRemovalAlbumNotice);
  }

  const telegramId = ctx.user.telegramId;
  const chatId = ctx.chat?.id ?? (telegramId ? Number(telegramId) : undefined);
  if (chatId === undefined) return;

  // Resolve S3 key → presigned URL that the worker / provider can fetch.
  let resolved: Record<string, string[]>;
  try {
    resolved = await resolveMediaInputUrls({ edit: [normalized.key] });
  } catch (err) {
    if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Background removal: failed to resolve media URL");
      await ctx.reply(
        pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.backgroundRemoval, "design"),
      );
    }
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
    return;
  }

  await ctx.reply(ctx.t.scenarios.backgroundRemovalGenerating);

  let submitOk = false;
  try {
    await generationService.submitImage({
      userId,
      modelId: BG_REMOVAL_MODEL_ID,
      // Промпт не нужен — оба адаптера (fal ideogram / Replicate bria) идут
      // выделенной веткой submit'а и промпт не передают.
      prompt: "",
      mediaInputs: resolved,
      telegramChatId: chatId,
      // Кнопка под результатом — «Файл без фона» (сцена-специфичная подпись;
      // процессор читает её из job.data.sendOriginalLabel).
      sendOriginalLabel: ctx.t.scenarios.backgroundRemovalFileButton,
      promptMessageId: ctx.message?.message_id,
      // Сценарий маскирует реальную модель: в подписи «Удаление фона»,
      // без кнопки «Доработать» (юзер не выбирал модель).
      displayNameOverride: ctx.t.scenarios.backgroundRemoval,
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
      logger.error(err, "Background removal submit failed");
      await ctx.reply(
        pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.backgroundRemoval, "design"),
      );
    }
  }

  // На успехе оставляем юзера в ожидании нового фото (авто-рестарт flow);
  // на ошибке — возврат в Сценарии.
  await userStateService.setState(
    userId,
    submitOk ? "BG_REMOVAL_AWAIT_PHOTO" : "SCENARIOS_SECTION",
    null,
  );
}
