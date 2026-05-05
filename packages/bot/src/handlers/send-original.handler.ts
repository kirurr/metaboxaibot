import type { BotContext } from "../types/context.js";
import { InputFile } from "grammy";
import { db } from "@metabox/api/db";
import { getFileUrl } from "@metabox/api/services/s3";
import {
  detectImageMimeType,
  detectAudioMimeType,
  detectVideoMimeType,
  mimeToExtension,
} from "@metabox/api/utils/mime-detect";
import { logger } from "../logger.js";
import { acquireLock, releaseLock } from "../utils/dedup.js";

/**
 * Callback handler for "📎 Send as file" buttons (callback_data: orig_<outputId>).
 * Looks up the GenerationJobOutput and resends the output as an uncompressed document.
 * Also supports legacy orig_<jobId> buttons from before the migration.
 *
 * Note: sendDocument by URL in Telegram only works for .PDF / .ZIP — for images
 * and videos we must download the file and send it as a multipart InputFile.
 */
export async function handleSendOriginal(ctx: BotContext): Promise<void> {
  const id = ctx.callbackQuery?.data?.replace("orig_", "") ?? "";

  if (!ctx.user || !id) {
    await ctx.answerCallbackQuery();
    return;
  }

  // Try as outputId first
  let output = await db.generationJobOutput.findUnique({
    where: { id },
    include: { job: { select: { userId: true, section: true } } },
  });

  // Fallback: treat as jobId (old buttons before migration)
  if (!output) {
    output = await db.generationJobOutput.findFirst({
      where: { jobId: id, index: 0 },
      include: { job: { select: { userId: true, section: true } } },
    });
  }

  if (!output || output.job.userId !== ctx.user.id) {
    await ctx.answerCallbackQuery();
    return;
  }

  const lockKey = `send-original:${ctx.user.id}:${output.id}`;
  const locked = await acquireLock(lockKey, 60).catch(() => true);
  if (!locked) {
    await ctx.answerCallbackQuery();
    return;
  }

  // Prefer a fresh S3 URL; fall back to provider URL
  const url = (output.s3Key ? await getFileUrl(output.s3Key) : null) ?? output.outputUrl;

  if (!url) {
    await releaseLock(lockKey);
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery();

  // Download the file so we can send it as multipart (sendDocument-by-URL only
  // supports .PDF/.ZIP on Telegram side).
  let buffer: Buffer;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.warn({ err, outputId: output.id }, "send-original: failed to download file");
    await releaseLock(lockKey);
    await ctx.reply(ctx.t.errors.sendOriginalFailed);
    return;
  }

  // Resolve extension: s3Key first (authoritative), then sniff magic bytes
  // per section (handles S3 keys without ext, provider URLs, etc.), then
  // section name as a last-resort fallback.
  const s3Ext = output.s3Key?.split(".").pop()?.toLowerCase();
  const section = output.job.section;
  let ext = s3Ext;
  if (!ext) {
    const detected =
      section === "image"
        ? detectImageMimeType(buffer)
        : section === "video"
          ? detectVideoMimeType(buffer)
          : section === "audio"
            ? detectAudioMimeType(buffer)
            : null;
    ext = (detected && mimeToExtension(detected)) ?? section;
  }
  const filename = `${output.id}.${ext}`;

  // disable_content_type_detection=true — иначе Telegram распознаёт mp4/etc.
  // и апгрейдит документ до inline-видеоплеера (play-кнопка, серверный
  // thumbnail), что неотличимо от sendVideo и противоречит идее «отправить
  // оригинал как файл без сжатия и превью».
  const message = await ctx
    .replyWithDocument(new InputFile(buffer, filename), {
      disable_content_type_detection: true,
    })
    .catch((err) => {
      logger.warn({ err, outputId: output.id }, "send-original: replyWithDocument failed");
      return undefined;
    });
  if (!message) {
    await releaseLock(lockKey);
    await ctx.reply(ctx.t.errors.sendOriginalFailed);
  }
}
