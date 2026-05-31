import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { db } from "../db.js";
import { getFileUrl, compressForTelegramPhoto } from "../services/s3.service.js";
import { buildDownloadButton } from "../utils/download-token.js";
import { AI_MODELS, config, getT, buildResultCaption } from "@metabox/shared";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";
import {
  galleryService,
  GalleryBadRequestError,
  GalleryForbiddenError,
  GalleryNotFoundError,
} from "../services/gallery.service.js";

/**
 * Maps `galleryService` typed errors to HTTP responses. Returns the reply
 * so handlers can `return mapGalleryError(...)` directly; re-throws unknown
 * errors so Fastify's default handler logs them.
 */
function mapGalleryError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof GalleryNotFoundError) return reply.code(404).send({ error: err.message });
  if (err instanceof GalleryForbiddenError) return reply.code(403).send({ error: err.message });
  if (err instanceof GalleryBadRequestError) return reply.code(400).send({ error: err.message });
  throw err;
}

// `userId` — внутренний `User.id` (FK). `telegramId` — Telegram chat_id для
// прямых вызовов `https://api.telegram.org/.../sendXxx`. После decoupling-миграции
// они различаются для web-only юзеров; для tg-линкованных пока совпадают.
type AuthRequest = FastifyRequest & { userId: bigint; telegramId: bigint };

// Telegram multipart-upload limits (когда бот шлёт файл как multipart, а не URL):
//   sendPhoto       ≤ 10 MB
//   sendDocument/Video/Audio ≤ 50 MB
// Для image > 10 MB компрессируем через compressForTelegramPhoto до ≤ 9 MB,
// чтобы оставаться в sendPhoto. Для video/audio > 50 MB шлём download-ссылку.
const PHOTO_BUFFER_MAX_BYTES = 10 * 1024 * 1024;
const MEDIA_BUFFER_MAX_BYTES = 50 * 1024 * 1024;

type TelegramSendMethod = "sendPhoto" | "sendVideo" | "sendAudio" | "sendDocument";

function sectionToMethod(section: string): TelegramSendMethod {
  if (section === "image") return "sendPhoto";
  if (section === "video") return "sendVideo";
  if (section === "audio") return "sendAudio";
  return "sendDocument";
}

function methodParamKey(method: TelegramSendMethod): "photo" | "video" | "audio" | "document" {
  if (method === "sendPhoto") return "photo";
  if (method === "sendVideo") return "video";
  if (method === "sendAudio") return "audio";
  return "document";
}

/** Скачивает URL в Buffer. Бросает при не-2xx или сетевой ошибке. */
async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Дефолтное имя файла для multipart, если не удалось извлечь из s3Key/URL. */
function defaultFilename(section: string, index: number): string {
  if (section === "image") return `image-${index + 1}.png`;
  if (section === "video") return `video-${index + 1}.mp4`;
  if (section === "audio") return `audio-${index + 1}.mp3`;
  return `file-${index + 1}.bin`;
}

function filenameFromS3Key(s3Key: string | null, fallback: string): string {
  if (!s3Key) return fallback;
  const tail = s3Key.split("/").pop();
  return tail && tail.length > 0 ? tail : fallback;
}

/**
 * Multipart send to Telegram. Заменяет URL-based fetch — Telegram не качает файл сам,
 * мы заливаем буфер напрямую. Это убирает 5/20 MB лимиты на URL-fetch (теперь
 * действуют 10/50 MB лимиты на multipart, что обычно перекрывает all our outputs).
 */
async function sendBufferToUser(
  chatId: bigint,
  method: TelegramSendMethod,
  buffer: Buffer,
  filename: string,
  caption: string,
  replyMarkup?: object,
): Promise<void> {
  const paramKey = methodParamKey(method);
  const form = new FormData();
  form.append("chat_id", chatId.toString());
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }
  if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
  form.append(paramKey, new Blob([new Uint8Array(buffer)]), filename);

  const res = await fetch(`https://api.telegram.org/bot${config.bot.token}/${method}`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { description?: string };
    throw new Error(`Telegram API error: ${err.description ?? res.status}`);
  }
}

/**
 * Multipart media group для batch image-job'ов. Каждый Buffer attach'ится через
 * `attach://<name>`, JSON в `media` ссылается на эти имена.
 */
async function sendMediaGroupBuffers(
  chatId: bigint,
  items: Array<{ buffer: Buffer; filename: string; caption?: string }>,
): Promise<boolean> {
  const form = new FormData();
  form.append("chat_id", chatId.toString());
  const media = items.map((item, i) => {
    const attachName = `file${i}`;
    form.append(attachName, new Blob([new Uint8Array(item.buffer)]), item.filename);
    return {
      type: "photo" as const,
      media: `attach://${attachName}`,
      ...(item.caption ? { caption: item.caption, parse_mode: "HTML" as const } : {}),
    };
  });
  form.append("media", JSON.stringify(media));

  const res = await fetch(`https://api.telegram.org/bot${config.bot.token}/sendMediaGroup`, {
    method: "POST",
    body: form,
  });
  return res.ok;
}

/**
 * Готовит buffer для sendPhoto: если > 10 MB — компрессирует через
 * compressForTelegramPhoto (target 9 MB) и переименовывает на .jpg.
 * Иначе возвращает as-is.
 */
async function prepareImageBuffer(
  buffer: Buffer,
  baseFilename: string,
): Promise<{ buffer: Buffer; filename: string }> {
  if (buffer.byteLength <= PHOTO_BUFFER_MAX_BYTES) {
    return { buffer, filename: baseFilename };
  }
  const compressed = await compressForTelegramPhoto(buffer);
  const jpegName = baseFilename.replace(/\.[^.]+$/, "") + ".jpg";
  return { buffer: compressed, filename: jpegName };
}

export const galleryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["gallery"]));

  /**
   * GET /gallery?section=image|audio|video&page=1&limit=20
   * Returns the current user's completed generation jobs, newest first.
   * Outputs of a single job are grouped under one entry so the UI can render
   * a multi-image card per request.
   */
  fastify.get<{
    Querystring: {
      section?: string;
      page?: string;
      limit?: string;
      modelId?: string;
      modelIds?: string;
      folderId?: string;
    };
  }>("/gallery", async (request) => {
    const userId = (request as AuthRequest).userId;
    const { section, page = "1", limit = "20", modelId, modelIds, folderId } = request.query;
    return galleryService.listJobs(userId, {
      section,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
      modelId,
      modelIds,
      folderId,
    });
  });

  /**
   * POST /gallery/jobs/:id/send
   * Re-delivers all outputs of a generation job to the user's Telegram chat,
   * mirroring the worker's "job completed" payload:
   *   • Image batches (>1 output): one sendMediaGroup with caption on the first
   *     item, followed by a single sendMessage with per-output inline buttons.
   *   • Single output (any section) and non-image batches: per-output flow with
   *     section-appropriate send method + per-output button.
   *
   * Per-output button selection (matches worker `image.processor.ts`):
   *   • size ≤ 50 MB or unknown → callback `orig_<outputId>` ("📎 Отправить оригинал")
   *   • size > 50 MB           → URL `/download/<token>` ("⬇️ Скачать")
   * Files > 20 MB without an S3 key are unreachable and skipped silently.
   */
  fastify.post<{ Params: { id: string } }>("/gallery/jobs/:id/send", async (request, reply) => {
    const userId = (request as AuthRequest).userId;
    const telegramId = (request as AuthRequest).telegramId;
    const { id } = request.params;

    const job = await db.generationJob.findUnique({
      where: { id },
      select: {
        userId: true,
        section: true,
        modelId: true,
        prompt: true,
        outputs: {
          orderBy: { index: "asc" },
          select: { id: true, s3Key: true, outputUrl: true },
        },
      },
    });

    if (!job) return reply.code(404).send({ error: "Not found" });
    if (job.userId !== userId) return reply.code(403).send({ error: "Forbidden" });
    if (job.outputs.length === 0) return reply.code(422).send({ error: "No outputs" });

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { language: true },
    });
    const t = getT((user?.language ?? "ru") as Parameters<typeof getT>[0]);

    // Telegram bot multipart-upload ceiling — что бот может re-deliver как document
    // через `orig_` callback. Выше — только browser download link.
    const TELEGRAM_DOC_MAX_BYTES = 50 * 1024 * 1024;

    type ResolvedOutput = {
      id: string;
      s3Key: string | null;
      buffer: Buffer;
      size: number;
      filename: string;
    };

    // Скачиваем КАЖДЫЙ output в буфер. S3 first, при failure — fallback на
    // provider URL (короткоживущий, может уже не работать). Если оба не
    // отдали — output skip'ается. Это как в воркере: Telegram'у мы файл
    // ВСЕГДА заливаем multipart'ом, а не передаём URL — иначе на больших
    // файлах ловим "failed to get HTTP URL content".
    const resolved: ResolvedOutput[] = [];
    for (let i = 0; i < job.outputs.length; i++) {
      const out = job.outputs[i];
      let buffer: Buffer | null = null;
      if (out.s3Key) {
        const s3Url = await getFileUrl(out.s3Key);
        if (s3Url) buffer = await downloadBuffer(s3Url).catch(() => null);
      }
      if (!buffer && out.outputUrl) {
        buffer = await downloadBuffer(out.outputUrl).catch(() => null);
      }
      if (!buffer) continue;
      const filename = filenameFromS3Key(out.s3Key, defaultFilename(job.section, i));
      resolved.push({
        id: out.id,
        s3Key: out.s3Key,
        buffer,
        size: buffer.byteLength,
        filename,
      });
    }
    if (resolved.length === 0) return reply.code(422).send({ error: "No deliverable outputs" });

    // Caption формат идентичен worker'овскому — `<blockquote expandable>`
    // c полным промптом + parse_mode: HTML на всех sendXxx-вызовах ниже.
    const caption = buildResultCaption(t, AI_MODELS[job.modelId]?.name ?? job.modelId, job.prompt);
    const botUrl = `https://api.telegram.org/bot${config.bot.token}`;
    const isImageJob = job.section === "image";

    type InlineButton = {
      text: string;
      callback_data?: string;
      url?: string;
      web_app?: { url: string };
    };

    /**
     * Refine ("🔄 Доработать") — image-only, identical to worker payload.
     * Multi-output cards prefix the label with the index so the user can
     * tell which photo a button belongs to in a batch.
     */
    const buildRefineButton = (out: ResolvedOutput, n: number, multi: boolean): InlineButton => ({
      text: multi ? `${n}. 🔄` : t.design.refine,
      callback_data: `design_ref_${out.id}`,
    });

    /**
     * Action button — orig (callback) когда бот может перезалить как document
     * (≤ 50 MB), иначе direct download URL если файл в S3, иначе null.
     */
    const buildActionButton = (
      out: ResolvedOutput,
      n: number,
      multi: boolean,
    ): InlineButton | null => {
      if (out.size <= TELEGRAM_DOC_MAX_BYTES) {
        return {
          text: multi ? `${n}. 📎` : t.common.sendOriginal,
          callback_data: `orig_${out.id}`,
        };
      }
      if (out.s3Key) {
        return buildDownloadButton(multi ? `${n}. ⬇️` : t.common.downloadFile, out.s3Key, userId);
      }
      return null;
    };

    // ── Image batch: media group + refine+action pairs follow-up ───────────
    if (isImageJob && resolved.length > 1) {
      // Каждое фото готовим под лимит sendPhoto multipart (10 MB) — компрессим
      // если больше. Telegram не принимает media group из mixed types, поэтому
      // выгоднее сжать чем переключаться на sendDocument для всей группы.
      const items: Array<{ buffer: Buffer; filename: string; caption?: string }> = [];
      for (let i = 0; i < resolved.length; i++) {
        const out = resolved[i];
        const prepared = await prepareImageBuffer(out.buffer, out.filename);
        items.push({
          buffer: prepared.buffer,
          filename: prepared.filename,
          ...(i === 0 ? { caption } : {}),
        });
      }

      const groupOk = await sendMediaGroupBuffers(telegramId, items).catch(() => false);

      if (!groupOk) {
        // Group rejected (rare после compression) — шлём каждый файл отдельно
        // как document. Per-output failures swallowed чтобы один bad file не
        // блокировал остальные.
        for (let i = 0; i < resolved.length; i++) {
          const out = resolved[i];
          await sendBufferToUser(
            telegramId,
            "sendDocument",
            out.buffer,
            out.filename,
            i === 0 ? caption : "",
          ).catch(() => void 0);
        }
      }

      // Per-output: pair of {refine, action}. Mirrors the worker's batch
      // payload (image.processor.ts) exactly so the user sees identical
      // controls when re-sending an old generation.
      const buttons: InlineButton[] = [];
      for (let i = 0; i < resolved.length; i++) {
        const out = resolved[i];
        const n = i + 1;
        buttons.push(buildRefineButton(out, n, true));
        const action = buildActionButton(out, n, true);
        if (action) buttons.push(action);
      }

      if (buttons.length > 0) {
        // Worker layout: ≤3 outputs → 1 pair/row, even → 2 pairs/row, odd → 3
        // pairs/row. Each pair is 2 buttons (refine + action), so chunkSize
        // doubles the pairs-per-row count.
        const totalPairs = resolved.length;
        const pairsPerRow = totalPairs <= 3 ? 1 : totalPairs % 2 === 0 ? 2 : 3;
        const chunkSize = 2 * pairsPerRow;
        const rows: InlineButton[][] = [];
        for (let i = 0; i < buttons.length; i += chunkSize) {
          rows.push(buttons.slice(i, i + chunkSize));
        }
        // Drop the "⬇️ Скачать" line from the legend when no output produced
        // a download button — happens whenever every photo fits under 50 MB
        // (the common case), so we don't tease a button the user can't see.
        const hasDownloadButton = buttons.some((b) => b.url || b.web_app);
        const hintText = hasDownloadButton
          ? t.design.batchActions
          : t.design.batchActionsNoDownload;
        await fetch(`${botUrl}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: telegramId.toString(),
            text: hintText,
            reply_markup: { inline_keyboard: rows },
          }),
        });
      }

      return { success: true };
    }

    // ── Single output OR non-image batch (rare) ─────────────────────────────
    // Per-output flow with refine + action stacked on the file message itself
    // (refine is image-only; video/audio just get the action row).
    for (let i = 0; i < resolved.length; i++) {
      const out = resolved[i];
      const isFirst = i === 0;
      const sectionMethod = sectionToMethod(job.section);

      const refineRow: InlineButton[] | null = isImageJob
        ? [buildRefineButton(out, i + 1, false)]
        : null;
      const actionBtn = buildActionButton(out, i + 1, false);
      const actionRow: InlineButton[] | null = actionBtn ? [actionBtn] : null;
      const inlineRows = [refineRow, actionRow].filter((r): r is InlineButton[] => r !== null);
      const replyMarkup = inlineRows.length ? { inline_keyboard: inlineRows } : undefined;

      const downloadMarkup = out.s3Key
        ? {
            inline_keyboard: [[buildDownloadButton(t.common.downloadFile, out.s3Key, userId)]],
          }
        : undefined;

      // Multipart лимит для не-image — 50 MB. Выше — единственный путь
      // download-link сообщением.
      const tooLargeForMultipart =
        sectionMethod !== "sendPhoto" && out.size > MEDIA_BUFFER_MAX_BYTES;

      if (tooLargeForMultipart) {
        await fetch(`${botUrl}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: telegramId.toString(),
            text: `${isFirst ? caption : ""}\n\n${t.errors.fileTooLargeForTelegram}`,
            parse_mode: "HTML",
            ...(downloadMarkup ? { reply_markup: downloadMarkup } : {}),
          }),
        });
        continue;
      }

      // Image: компрессим если > 10 MB чтобы остаться в sendPhoto. Остальные
      // секции — буфер as-is (мы уже знаем что он ≤ 50 MB по проверке выше).
      let sendBuffer = out.buffer;
      let sendFilename = out.filename;
      if (sectionMethod === "sendPhoto") {
        const prepared = await prepareImageBuffer(out.buffer, out.filename);
        sendBuffer = prepared.buffer;
        sendFilename = prepared.filename;
      }

      try {
        await sendBufferToUser(
          telegramId,
          sectionMethod,
          sendBuffer,
          sendFilename,
          isFirst ? caption : "",
          replyMarkup,
        );
      } catch (err) {
        const isTooLarge =
          err instanceof Error &&
          (err.message.includes("Request Entity Too Large") ||
            err.message.includes("file is too big") ||
            err.message.includes("wrong file identifier"));

        if (isTooLarge) {
          await fetch(`${botUrl}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: telegramId.toString(),
              text: `${isFirst ? caption : ""}\n\n${t.errors.fileTooLargeForTelegram}`,
              parse_mode: "HTML",
              ...(downloadMarkup ? { reply_markup: downloadMarkup } : {}),
            }),
          });
        } else {
          throw err;
        }
      }
    }

    return { success: true };
  });

  /**
   * POST /gallery/outputs/:id/send
   * Re-delivers ONE output to the user's Telegram chat. Mirrors the single-
   * output branch of `/gallery/jobs/:id/send` (refine+action row, ≤10 MB
   * sendPhoto / ≤50 MB sendDocument / download link otherwise).
   *
   * Используется новой gallery UI (1 карточка = 1 output). Старый `jobs/:id/send`
   * остаётся для resend всей пачки media group'ом — поведение бота сохраняется.
   */
  fastify.post<{ Params: { id: string } }>("/gallery/outputs/:id/send", async (request, reply) => {
    const userId = (request as AuthRequest).userId;
    const telegramId = (request as AuthRequest).telegramId;
    const { id } = request.params;

    const output = await db.generationJobOutput.findUnique({
      where: { id },
      select: {
        id: true,
        index: true,
        s3Key: true,
        outputUrl: true,
        job: {
          select: {
            userId: true,
            section: true,
            modelId: true,
            prompt: true,
          },
        },
      },
    });

    if (!output) return reply.code(404).send({ error: "Not found" });
    if (output.job.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { language: true },
    });
    const t = getT((user?.language ?? "ru") as Parameters<typeof getT>[0]);

    const TELEGRAM_DOC_MAX_BYTES = 50 * 1024 * 1024;

    let buffer: Buffer | null = null;
    if (output.s3Key) {
      const s3Url = await getFileUrl(output.s3Key);
      if (s3Url) buffer = await downloadBuffer(s3Url).catch(() => null);
    }
    if (!buffer && output.outputUrl) {
      buffer = await downloadBuffer(output.outputUrl).catch(() => null);
    }
    if (!buffer) return reply.code(422).send({ error: "Output not deliverable" });

    const size = buffer.byteLength;
    const filename = filenameFromS3Key(
      output.s3Key,
      defaultFilename(output.job.section, output.index),
    );

    const caption = buildResultCaption(
      t,
      AI_MODELS[output.job.modelId]?.name ?? output.job.modelId,
      output.job.prompt,
    );
    const botUrl = `https://api.telegram.org/bot${config.bot.token}`;
    const isImage = output.job.section === "image";
    const sectionMethod = sectionToMethod(output.job.section);

    type InlineButton = {
      text: string;
      callback_data?: string;
      url?: string;
      web_app?: { url: string };
    };

    const refineBtn: InlineButton | null = isImage
      ? { text: t.design.refine, callback_data: `design_ref_${output.id}` }
      : null;

    let actionBtn: InlineButton | null = null;
    if (size <= TELEGRAM_DOC_MAX_BYTES) {
      actionBtn = { text: t.common.sendOriginal, callback_data: `orig_${output.id}` };
    } else if (output.s3Key) {
      actionBtn = buildDownloadButton(t.common.downloadFile, output.s3Key, userId);
    }

    const inlineRows = [refineBtn, actionBtn]
      .filter((b): b is InlineButton => b !== null)
      .map((b) => [b]);
    const replyMarkup = inlineRows.length ? { inline_keyboard: inlineRows } : undefined;

    const downloadMarkup = output.s3Key
      ? {
          inline_keyboard: [[buildDownloadButton(t.common.downloadFile, output.s3Key, userId)]],
        }
      : undefined;

    const tooLargeForMultipart = sectionMethod !== "sendPhoto" && size > MEDIA_BUFFER_MAX_BYTES;

    if (tooLargeForMultipart) {
      await fetch(`${botUrl}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramId.toString(),
          text: `${caption}\n\n${t.errors.fileTooLargeForTelegram}`,
          parse_mode: "HTML",
          ...(downloadMarkup ? { reply_markup: downloadMarkup } : {}),
        }),
      });
      return { success: true };
    }

    let sendBuffer = buffer;
    let sendFilename = filename;
    if (sectionMethod === "sendPhoto") {
      const prepared = await prepareImageBuffer(buffer, filename);
      sendBuffer = prepared.buffer;
      sendFilename = prepared.filename;
    }

    try {
      await sendBufferToUser(
        telegramId,
        sectionMethod,
        sendBuffer,
        sendFilename,
        caption,
        replyMarkup,
      );
    } catch (err) {
      const isTooLarge =
        err instanceof Error &&
        (err.message.includes("Request Entity Too Large") ||
          err.message.includes("file is too big") ||
          err.message.includes("wrong file identifier"));

      if (isTooLarge) {
        await fetch(`${botUrl}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: telegramId.toString(),
            text: `${caption}\n\n${t.errors.fileTooLargeForTelegram}`,
            parse_mode: "HTML",
            ...(downloadMarkup ? { reply_markup: downloadMarkup } : {}),
          }),
        });
      } else {
        throw err;
      }
    }

    return { success: true };
  });

  /**
   * GET /gallery/model-counts?section=image|audio|video
   * Returns per-model generation counts for the current user in a section,
   * ordered by count descending. Only models with at least one job are included.
   */
  fastify.get<{
    Querystring: { section?: string };
  }>("/gallery/model-counts", async (request) => {
    const userId = (request as AuthRequest).userId;
    const { section } = request.query;
    return galleryService.getModelCounts(userId, section);
  });

  /**
   * GET /gallery/:id/preview-url
   * Returns a playable URL for the gallery item on demand.
   * :id is a GenerationJobOutput ID.
   */
  fastify.get<{ Params: { id: string } }>(
    "/gallery/:id/preview-url",
    {
      schema: {
        description: "Get playable preview URL for gallery item",
        params: {
          type: "object",
          properties: { id: { type: "string", description: "Output ID" } },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { url: { type: "string" } },
          },
          403: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
          404: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
          422: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = (request as AuthRequest).userId;
      const { id } = request.params;
      try {
        const url = await galleryService.getOutputPreviewUrl(userId, id);
        return { url };
      } catch (err) {
        if (err instanceof GalleryBadRequestError)
          return reply.code(422).send({ error: err.message });
        return mapGalleryError(err, reply);
      }
    },
  );

  /**
   * GET /gallery/outputs/:id/original-url
   * Returns a presigned S3 URL with attachment-disposition so the browser
   * downloads the original file instead of opening it inline. Falls back
   * to the provider URL when the file is not in S3.
   */
  fastify.get<{ Params: { id: string } }>(
    "/gallery/outputs/:id/original-url",
    {
      schema: {
        description: "Get original file download URL",
        params: {
          type: "object",
          properties: { id: { type: "string", description: "Output ID" } },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { url: { type: "string" } },
          },
          403: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
          404: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
          422: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = (request as AuthRequest).userId;
      const { id } = request.params;
      try {
        const url = await galleryService.getOutputOriginalUrl(userId, id);
        return { url };
      } catch (err) {
        if (err instanceof GalleryBadRequestError)
          return reply.code(422).send({ error: err.message });
        return mapGalleryError(err, reply);
      }
    },
  );

  /**
   * DELETE /gallery/jobs/:id
   * Removes the entire generation job — all its outputs and S3 artifacts.
   */
  fastify.delete<{ Params: { id: string } }>("/gallery/jobs/:id", async (request, reply) => {
    const userId = (request as AuthRequest).userId;
    const { id } = request.params;
    try {
      await galleryService.deleteJob(userId, id);
      return { success: true };
    } catch (err) {
      return mapGalleryError(err, reply);
    }
  });

  /**
   * DELETE /gallery/outputs/:id
   * Удаляет один output (один кадр пачки). Если это был последний — удаляется
   * вся джоба (`jobDeleted: true`).
   */
  fastify.delete<{ Params: { id: string } }>("/gallery/outputs/:id", async (request, reply) => {
    const userId = (request as AuthRequest).userId;
    const { id } = request.params;
    try {
      return await galleryService.deleteOutput(userId, id);
    } catch (err) {
      return mapGalleryError(err, reply);
    }
  });

  // ── Gallery Folders ──────────────────────────────────────────────────────────

  /**
   * GET /gallery/folders
   * Returns all folders for the current user sorted: pinned first, then by name.
   * Includes item count per folder.
   */
  fastify.get(
    "/gallery/folders",
    {
      schema: {
        description: "Get user's gallery folders",
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                isDefault: { type: "boolean" },
                isPinned: { type: "boolean" },
                pinnedAt: { type: "string", nullable: true },
                itemCount: { type: "number" },
                createdAt: { type: "string" },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const userId = (request as AuthRequest).userId;
      return galleryService.listFolders(userId);
    },
  );

  /**
   * POST /gallery/folders
   * Creates a new user folder.
   */
  fastify.post<{ Body: { name: string } }>(
    "/gallery/folders",
    {
      schema: {
        description: "Create a new gallery folder",
        body: {
          type: "object",
          properties: { name: { type: "string", description: "Folder name" } },
          required: ["name"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              isDefault: { type: "boolean" },
              isPinned: { type: "boolean" },
              pinnedAt: { type: "string", nullable: true },
              itemCount: { type: "number" },
              createdAt: { type: "string" },
            },
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const userId = (request as AuthRequest).userId;
      const { name } = request.body;
      try {
        return await galleryService.createFolder(userId, name);
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );

  /**
   * PATCH /gallery/folders/:folderId
   * Rename or pin/unpin a folder. Default folders cannot be renamed.
   */
  fastify.patch<{
    Params: { folderId: string };
    Body: { name?: string; isPinned?: boolean };
  }>("/gallery/folders/:folderId", async (request, reply) => {
    const userId = (request as AuthRequest).userId;
    const { folderId } = request.params;
    const { name, isPinned } = request.body;
    try {
      return await galleryService.updateFolder(userId, folderId, { name, isPinned });
    } catch (err) {
      return mapGalleryError(err, reply);
    }
  });

  /**
   * DELETE /gallery/folders/:folderId
   * Deletes a user folder. Default (Favorites) folders cannot be deleted.
   */
  fastify.delete<{ Params: { folderId: string } }>(
    "/gallery/folders/:folderId",
    {
      schema: {
        description: "Delete a gallery folder",
        params: {
          type: "object",
          properties: { folderId: { type: "string", description: "Folder ID" } },
          required: ["folderId"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { success: { type: "boolean" } },
          },
          400: badRequestResponse,
          403: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
          404: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = (request as AuthRequest).userId;
      const { folderId } = request.params;
      try {
        await galleryService.deleteFolder(userId, folderId);
        return { success: true };
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );

  /**
   * POST /gallery/folders/:folderId/items
   * Добавляет один output (картинку из пачки) в папку. После refactor'а
   * 2026-05-31 фавориты и папки стали output-level — джоба больше не может
   * быть «в папке» как единое целое.
   */
  fastify.post<{
    Params: { folderId: string };
    Body: { outputId: string };
  }>(
    "/gallery/folders/:folderId/items",
    {
      schema: {
        description: "Add output to folder",
        params: {
          type: "object",
          properties: { folderId: { type: "string", description: "Folder ID" } },
          required: ["folderId"],
        },
        body: {
          type: "object",
          properties: { outputId: { type: "string", description: "Output ID" } },
          required: ["outputId"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { success: { type: "boolean" } },
          },
          403: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
          404: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = (request as AuthRequest).userId;
      const { folderId } = request.params;
      const { outputId } = request.body;
      try {
        await galleryService.addOutputToFolder(userId, folderId, outputId);
        return { success: true };
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );

  /**
   * DELETE /gallery/folders/:folderId/items/:outputId
   * Removes a single output from a folder.
   */
  fastify.delete<{ Params: { folderId: string; outputId: string } }>(
    "/gallery/folders/:folderId/items/:outputId",
    {
      schema: {
        description: "Remove output from folder",
        params: {
          type: "object",
          properties: {
            folderId: { type: "string", description: "Folder ID" },
            outputId: { type: "string", description: "Output ID" },
          },
          required: ["folderId", "outputId"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { success: { type: "boolean" } },
          },
          403: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
          404: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = (request as AuthRequest).userId;
      const { folderId, outputId } = request.params;
      try {
        await galleryService.removeOutputFromFolder(userId, folderId, outputId);
        return { success: true };
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );

  /**
   * POST /gallery/favorites
   * Ensures the Favorites folder exists for the user, then adds the output.
   * Returns the Favorites folder id.
   */
  fastify.post<{ Body: { outputId: string } }>(
    "/gallery/favorites",
    {
      schema: {
        description: "Add output to Favorites folder",
        body: {
          type: "object",
          properties: { outputId: { type: "string", description: "Output ID" } },
          required: ["outputId"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { folderId: { type: "string" } },
          },
          403: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
          404: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = (request as AuthRequest).userId;
      const { outputId } = request.body;
      try {
        return await galleryService.addToFavorites(userId, outputId);
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );

  /**
   * DELETE /gallery/favorites/:outputId
   * Removes an output from the Favorites folder (if it exists).
   */
  fastify.delete<{ Params: { outputId: string } }>(
    "/gallery/favorites/:outputId",
    {
      schema: {
        description: "Remove output from Favorites folder",
        params: {
          type: "object",
          properties: { outputId: { type: "string", description: "Output ID" } },
          required: ["outputId"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { success: { type: "boolean" } },
          },
          404: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = (request as AuthRequest).userId;
      const { outputId } = request.params;
      try {
        await galleryService.removeFromFavorites(userId, outputId);
        return { success: true };
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );
};
