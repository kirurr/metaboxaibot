import type { BotContext } from "../types/context.js";
import { generationService, userStateService, s3Service } from "@metabox/api/services";
import { config } from "@metabox/shared";
import { logger } from "../logger.js";
import { handleScenarios } from "../commands/menu.js";
import { resolveMediaInputUrls } from "../utils/media-input-state.js";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";
import {
  UserFacingError,
  resolveUserFacingErrorVariant,
  pickGenerationFailedMessage,
  FACE_SWAP_BUFFER_MODEL_ID,
} from "@metabox/shared";

const FACE_SWAP_MODEL_ID = "nano-banana-pro";
const FACE_SWAP_SLOT_REFERENCE = "reference";
const FACE_SWAP_SLOT_FACE = "face";

/** Telegram Bot API hard cap on `getFile` downloads. */
const TG_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * In-memory dedup of Telegram media groups (albums). Each photo in an album
 * arrives as a separate update sharing `media_group_id`. We only consume the
 * first photo per group; siblings are silently ignored so the user doesn't
 * burn through reference/face slots from a single album upload.
 */
const processedMediaGroups = new Set<string>();

/**
 * Hardcoded prompt for face swap. First image = reference (pose / composition /
 * background), second = user's face. Kept in English to match other hardcoded
 * provider prompts in the codebase.
 */
const FACE_SWAP_PROMPT =
  "Replace the face of the person in the first image with the face from the second image. " +
  "Keep the first image's pose, body, clothing, lighting and background unchanged. " +
  "Match skin tone and lighting naturally. " +
  "Output the same aspect ratio and composition as the first image.";

/** Entry — user tapped «🔄 Замена лица» in the Scenarios submenu. */
export async function handleFaceSwapEnter(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.clearMediaInputs(ctx.user.id, FACE_SWAP_BUFFER_MODEL_ID);
  await userStateService.setState(ctx.user.id, "FACE_SWAP_AWAIT_REFERENCE", null);
  await ctx.reply(ctx.t.scenarios.faceSwapStep1, { parse_mode: "HTML" });
}

/**
 * Handles a photo (compressed or image-document) while the user is in
 * FACE_SWAP_AWAIT_REFERENCE or FACE_SWAP_AWAIT_FACE state.
 */
export async function handleFaceSwapPhoto(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  // Drop album siblings — only the first photo of any media group is consumed.
  // The first photo also triggers a one-time notice so the user knows the
  // siblings were skipped (otherwise the album upload feels broken). Note:
  // dedup is committed only AFTER a successful S3 upload (see below) so a
  // failed first photo doesn't blackhole the rest of the album.
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
    await ctx.reply(ctx.t.scenarios.faceSwapNotPhoto);
    return;
  }
  if (fileSize !== undefined && fileSize > TG_DOWNLOAD_LIMIT_BYTES) {
    await ctx.reply(ctx.t.scenarios.faceSwapPhotoTooLarge);
    return;
  }

  const state = await userStateService.get(ctx.user.id);
  const isReference = state?.state === "FACE_SWAP_AWAIT_REFERENCE";
  const isFace = state?.state === "FACE_SWAP_AWAIT_FACE";
  if (!isReference && !isFace) return;

  // Download from Telegram + upload to S3.
  const userId = ctx.user.id;
  const file = await ctx.api.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
  const contentType = mimeHint?.startsWith("image/") ? mimeHint : "image/jpeg";
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const slot = isReference ? FACE_SWAP_SLOT_REFERENCE : FACE_SWAP_SLOT_FACE;
  const s3Key = `face_swap/${userId.toString()}/${Date.now()}_${slot}.${ext}`;
  const uploadedKey = await s3Service.uploadFromUrl(s3Key, tgUrl, contentType).catch(() => null);
  if (!uploadedKey) {
    await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.faceSwap, "design"));
    return;
  }

  // Persist the S3 key under the pseudo-model buffer so the second photo can
  // read it back. Use addMediaInput with overflow=true so retries on the same
  // slot replace the previous value rather than appending.
  await userStateService.addMediaInput(userId, FACE_SWAP_BUFFER_MODEL_ID, slot, uploadedKey, true);

  // Commit album dedup AFTER successful upload + notify the user once per
  // album. If upload had failed we'd have early-returned above without
  // marking the group — the next sibling can retry.
  if (mediaGroupKey) {
    processedMediaGroups.add(mediaGroupKey);
    // Cap the set so it can't grow unbounded across the bot's lifetime.
    if (processedMediaGroups.size > 1000) {
      const iter = processedMediaGroups.values();
      for (let i = 0; i < 100; i++) {
        const v = iter.next().value;
        if (v) processedMediaGroups.delete(v);
      }
    }
    await ctx.reply(ctx.t.scenarios.faceSwapAlbumNotice);
  }

  if (isReference) {
    await userStateService.setState(userId, "FACE_SWAP_AWAIT_FACE", null);
    await ctx.reply(ctx.t.scenarios.faceSwapStep2, { parse_mode: "HTML" });
    return;
  }

  // Second photo received — read both slots and submit.
  const slots = await userStateService.getMediaInputs(userId, FACE_SWAP_BUFFER_MODEL_ID);
  const referenceKey = slots[FACE_SWAP_SLOT_REFERENCE]?.[0];
  const faceKey = slots[FACE_SWAP_SLOT_FACE]?.[0];
  if (!referenceKey || !faceKey) {
    // Buffer was cleared mid-flow; restart from step 1.
    await userStateService.setState(userId, "FACE_SWAP_AWAIT_REFERENCE", null);
    await ctx.reply(ctx.t.scenarios.faceSwapStep1, { parse_mode: "HTML" });
    return;
  }

  const telegramId = ctx.user.telegramId;
  const chatId = ctx.chat?.id ?? (telegramId ? Number(telegramId) : undefined);
  if (chatId === undefined) return;

  // Resolve S3 keys → presigned URLs that the worker / Kie can fetch.
  let resolved: Record<string, string[]>;
  try {
    resolved = await resolveMediaInputUrls({
      edit: [referenceKey, faceKey],
    });
  } catch (err) {
    if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Face swap: failed to resolve media URLs");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.faceSwap, "design"));
    }
    // S3 keys are gone — нет смысла держать буфер.
    await userStateService.clearMediaInputs(userId, FACE_SWAP_BUFFER_MODEL_ID);
    await handleScenarios(ctx);
    return;
  }

  await ctx.reply(ctx.t.scenarios.faceSwapGenerating);

  let submitOk = false;
  try {
    await generationService.submitImage({
      userId,
      modelId: FACE_SWAP_MODEL_ID,
      prompt: FACE_SWAP_PROMPT,
      mediaInputs: resolved,
      telegramChatId: chatId,
      sendOriginalLabel: ctx.t.common.sendOriginal,
      aspectRatio: "auto",
      promptMessageId: ctx.message?.message_id,
      extraModelSettings: {
        resolution: "2K",
        aspect_ratio: "auto",
        output_format: "jpeg",
        num_images: 1,
      },
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
      logger.error(err, "Face swap submit failed");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.faceSwap, "design"));
    }
  }

  // Чистим буфер только на успехе. На провале оставляем S3-ключи в БД —
  // следующий handleFaceSwapEnter их всё равно перезатрёт, а так юзер не
  // теряет последнюю загрузку до явного нового захода.
  if (submitOk) {
    await userStateService.clearMediaInputs(userId, FACE_SWAP_BUFFER_MODEL_ID);
  }
  await handleScenarios(ctx);
}
