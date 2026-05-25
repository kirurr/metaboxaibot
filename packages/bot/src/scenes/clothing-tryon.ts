import type { BotContext } from "../types/context.js";
import {
  generationService,
  userStateService,
  s3Service,
  ImageDecodeError,
} from "@metabox/api/services";
import { AI_MODELS, config } from "@metabox/shared";
import { logger } from "../logger.js";
import { buildCostLine } from "../utils/cost-line.js";
import { resolveMediaInputUrls } from "../utils/media-input-state.js";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";
import { isImageDocument } from "./upscale.js";
import {
  UserFacingError,
  resolveUserFacingErrorVariant,
  pickGenerationFailedMessage,
  CLOTHING_TRYON_BUFFER_MODEL_ID,
} from "@metabox/shared";

// Сценарий «Примерка одежды»: primary — Hy-Wu Edit (fal-ai/hy-wu-edit),
// fallback — fal virtual-try-on. Обе модели — fal, различаются по
// providerModelId (см. design.models.ts / fal.adapter.ts).
const CLOTHING_TRYON_MODEL_ID = "clothing-tryon";
const CLOTHING_TRYON_SLOT_PERSON = "person";
const CLOTHING_TRYON_SLOT_CLOTHING = "clothing";

/**
 * Instruction-промпт для Hy-Wu Edit (primary). image 1 = фото человека (база:
 * тело, поза, свет, лицо), image 2 = фото одежды. fal virtual-try-on (fallback)
 * промпт игнорирует — submitVirtualTryOn не передаёт его провайдеру.
 */
const CLOTHING_TRYON_PROMPT =
  "Take image 1 as a reference and transfer the clothing from image 2 to image 1, " +
  "maintaining the body, pose, and light in image 1. Keep the person's face and " +
  "don't change anything else.";

/** Telegram Bot API hard cap on `getFile` downloads. */
const TG_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * In-memory dedup of Telegram media groups (albums). Each photo in an album
 * arrives as a separate update sharing `media_group_id`. We only consume the
 * first photo per group; siblings are silently ignored so the user doesn't
 * burn through person/clothing slots from a single album upload.
 */
const processedMediaGroups = new Set<string>();

/** Entry — user tapped «👗 Примерка одежды» in the Scenarios submenu. */
export async function handleClothingTryonEnter(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.clearMediaInputs(ctx.user.id, CLOTHING_TRYON_BUFFER_MODEL_ID);
  await userStateService.setState(ctx.user.id, "CLOTHING_TRYON_AWAIT_PERSON", null);

  const model = AI_MODELS[CLOTHING_TRYON_MODEL_ID];
  const costLine = model ? buildCostLine(model, {}, ctx.t) : "";
  const welcome = [
    `<b>${ctx.t.scenarios.clothingTryon}</b>`,
    ctx.t.scenarios.clothingTryonWelcome,
    costLine,
  ]
    .filter(Boolean)
    .join("\n\n");
  await ctx.reply(welcome, { parse_mode: "HTML" });
  await ctx.reply(ctx.t.scenarios.clothingTryonStep1, { parse_mode: "HTML" });
}

/**
 * Handles a photo (compressed or image-document) while the user is in
 * CLOTHING_TRYON_AWAIT_PERSON or CLOTHING_TRYON_AWAIT_CLOTHING state.
 */
export async function handleClothingTryonPhoto(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  // Drop album siblings — only the first photo of any media group is consumed.
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
    await ctx.reply(ctx.t.scenarios.clothingTryonNotPhoto);
    return;
  }
  if (fileSize !== undefined && fileSize > TG_DOWNLOAD_LIMIT_BYTES) {
    await ctx.reply(ctx.t.scenarios.clothingTryonPhotoTooLarge);
    return;
  }

  const state = await userStateService.get(ctx.user.id);
  const isPerson = state?.state === "CLOTHING_TRYON_AWAIT_PERSON";
  const isClothing = state?.state === "CLOTHING_TRYON_AWAIT_CLOTHING";
  if (!isPerson && !isClothing) return;

  // Download from Telegram + upload to S3. Перекодируем вход в JPEG: провайдер
  // (fal Hy-Wu Edit) отбивает HEIC / CMYK / 16-bit / progressive JPEG и т.п.
  // `uploadNormalizedImage` читает реальные magic bytes через sharp — mime
  // юзерского файла не имеет значения, любой image-формат превратится в JPEG.
  // HEIC от iPhone декодится через heic-convert.
  const userId = ctx.user.id;
  // Album dedup регистрируем ДО upload'а: на decode-failure первого фото из
  // альбома мы не хотим получить N одинаковых сообщений «формат не
  // поддерживается» по числу siblings. Failure первого = «альбом обработан».
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
  const slot = isPerson ? CLOTHING_TRYON_SLOT_PERSON : CLOTHING_TRYON_SLOT_CLOTHING;
  const s3Key = `clothing_tryon/${userId.toString()}/${Date.now()}_${slot}.jpg`;
  let normalized;
  try {
    normalized = await s3Service.uploadNormalizedImage(s3Key, tgUrl);
  } catch (err) {
    if (err instanceof ImageDecodeError) {
      await ctx.reply(ctx.t.scenarios.imageDecodeFailed);
    } else {
      logger.error(err, "Clothing tryon: upload normalize failed");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.clothingTryon, "design"));
    }
    return;
  }
  const uploadedKey = normalized.key;

  // Persist the S3 key under the pseudo-model buffer so the second photo can
  // read it back. overflow=true → retries on the same slot replace the value.
  await userStateService.addMediaInput(
    userId,
    CLOTHING_TRYON_BUFFER_MODEL_ID,
    slot,
    uploadedKey,
    true,
  );

  if (mediaGroupKey) {
    await ctx.reply(ctx.t.scenarios.clothingTryonAlbumNotice);
  }

  if (isPerson) {
    await userStateService.setState(userId, "CLOTHING_TRYON_AWAIT_CLOTHING", null);
    await ctx.reply(ctx.t.scenarios.clothingTryonStep2, { parse_mode: "HTML" });
    return;
  }

  // Second photo received — read both slots and submit.
  const slots = await userStateService.getMediaInputs(userId, CLOTHING_TRYON_BUFFER_MODEL_ID);
  const personKey = slots[CLOTHING_TRYON_SLOT_PERSON]?.[0];
  const clothingKey = slots[CLOTHING_TRYON_SLOT_CLOTHING]?.[0];
  if (!personKey || !clothingKey) {
    // Buffer was cleared mid-flow; restart from step 1.
    await userStateService.setState(userId, "CLOTHING_TRYON_AWAIT_PERSON", null);
    await ctx.reply(ctx.t.scenarios.clothingTryonStep1, { parse_mode: "HTML" });
    return;
  }

  const telegramId = ctx.user.telegramId;
  const chatId = ctx.chat?.id ?? (telegramId ? Number(telegramId) : undefined);
  if (chatId === undefined) return;

  // Resolve S3 keys → presigned URLs that the worker / fal can fetch.
  let resolved: Record<string, string[]>;
  try {
    resolved = await resolveMediaInputUrls({
      edit: [personKey, clothingKey],
    });
  } catch (err) {
    if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Clothing try-on: failed to resolve media URLs");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.clothingTryon, "design"));
    }
    await userStateService.clearMediaInputs(userId, CLOTHING_TRYON_BUFFER_MODEL_ID);
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
    return;
  }

  await ctx.reply(ctx.t.scenarios.clothingTryonGenerating);

  let submitOk = false;
  try {
    await generationService.submitImage({
      userId,
      modelId: CLOTHING_TRYON_MODEL_ID,
      // Hy-Wu Edit (primary) требует instruction-промпт; fal virtual-try-on
      // (fallback) его игнорирует. mediaInputs.edit: [0] = человек, [1] = одежда.
      prompt: CLOTHING_TRYON_PROMPT,
      mediaInputs: resolved,
      telegramChatId: chatId,
      sendOriginalLabel: ctx.t.common.sendOriginal,
      promptMessageId: ctx.message?.message_id,
      // Сценарий маскирует реальную модель: в подписи «Примерка одежды»,
      // без кнопки «Доработать» (юзер не выбирал модель).
      displayNameOverride: ctx.t.scenarios.clothingTryon,
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
      logger.error(err, "Clothing try-on submit failed");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.clothingTryon, "design"));
    }
  }

  // Чистим буфер только на успехе. На провале S3-ключи остаются — следующий
  // handleClothingTryonEnter их перезатрёт, юзер не теряет последнюю загрузку.
  if (submitOk) {
    await userStateService.clearMediaInputs(userId, CLOTHING_TRYON_BUFFER_MODEL_ID);
    // Авто-рестарт flow: после успешного submit ждём новое фото человека.
    await userStateService.setState(userId, "CLOTHING_TRYON_AWAIT_PERSON", null);
  } else {
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
  }
}
