/**
 * /web/* endpoints для ai.metabox.global (packages/web).
 *
 * Все защищены `webTelegramLinkedPreHandler` — 401 если нет JWT, 403 TELEGRAM_NOT_LINKED
 * если юзер ещё не привязал Telegram (фронт по этому коду показывает модалку).
 *
 * Используют ту же бизнес-логику, что и бот (`dialogService`, `chatService`) —
 * БД одна, поэтому история чатов синхронизирована с мини-аппом и ботом.
 */

import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { webTelegramLinkedPreHandler } from "../middlewares/web-auth.js";
import { dialogService, type StoredAttachment } from "../services/dialog.service.js";
import { historyService } from "../services/history.service.js";
import {
  chatService,
  ContextOverflowError,
  DocumentNotSupportedError,
  DocumentExtractFailedError,
} from "../services/chat.service.js";
import { db } from "../db.js";
import { getFileUrl, uploadBuffer } from "../services/s3.service.js";
import { uploadedMediaService } from "../services/uploaded-media.service.js";
import { logger } from "../logger.js";
import { AI_MODELS, type Section } from "@metabox/shared";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";
import { CHAT_UPLOAD_MAX_BYTES, isAllowedUploadMime, extFromMime } from "../utils/upload-mime.js";
import type { OutgoingHttpHeaders } from "node:http";

// ── Загрузка вложений для чата ───────────────────────────────────────────────
// Принимаемые типы (см. utils/upload-mime.ts):
//  - images: показываются модели как картинки (через imageS3Keys в chat.service).
//  - documents: PDF — native через `supportsDocuments`, остальные (txt/csv/json/
//    docx/xlsx) — text-class через `documentTextExtractFallback` (inline extract).
//  - video / audio: исключительно для media-input слотов на странице генерации
//    (Kling Motion `motion_video`, Heygen `voice_audio`, Wan `driving_audio`
//    и т.п.). В обычный чат-композер они не попадают — он сам ограничивает
//    `accept` до image+document.

export const webChatRoutes: FastifyPluginAsync = async (fastify) => {
  // Все роуты здесь требуют и авторизации, и привязанного Telegram.
  // Каталог моделей вынесен в `web-models.ts` (только webAuth, без Telegram).
  fastify.addHook("preHandler", webTelegramLinkedPreHandler);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["web-chat"]));

  // ── POST /web/chat-uploads ──────────────────────────────────────────────
  /**
   * Принимает multipart с одним файлом, кладёт в S3 под
   * `chat-uploads/{userId}/{uuid}.{ext}`, возвращает s3Key + метаданные.
   * Фронт хранит результат локально до отправки сообщения, затем передаёт
   * s3Key'и через `/web/dialogs/:id/send`.
   */
  fastify.post(
    "/web/chat-uploads",
    {
      schema: {
        description: "Upload a file attachment for chat",
        consumes: ["multipart/form-data"],
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              s3Key: { type: "string" },
              name: { type: "string" },
              mimeType: { type: "string" },
              size: { type: "number" },
              kind: { type: "string", enum: ["image", "document", "video", "audio"] },
              url: { type: "string", nullable: true },
            },
          },
          400: badRequestResponse,
          413: badRequestResponse,
          415: badRequestResponse,
          500: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { aibUserId } = request.webUser!;

      // Per-request override 25MB поверх глобального 5MB из @fastify/multipart.
      let part;
      try {
        part = await request.file({ limits: { fileSize: CHAT_UPLOAD_MAX_BYTES } });
      } catch (err) {
        logger.warn({ err }, "chat-uploads: failed to read multipart");
        return reply.code(400).send({ error: "Файл не передан" });
      }
      if (!part) {
        return reply.code(400).send({ error: "Файл не передан" });
      }

      const kind = isAllowedUploadMime(part.mimetype);
      if (!kind) {
        return reply.code(415).send({
          error: `Тип файла не поддерживается: ${part.mimetype}`,
          code: "UNSUPPORTED_MEDIA_TYPE",
        });
      }

      let buffer: Buffer;
      try {
        buffer = await part.toBuffer();
      } catch (err) {
        // @fastify/multipart кидает ошибку с code 'FST_REQ_FILE_TOO_LARGE' при превышении.
        const code = (err as { code?: string })?.code;
        if (code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.code(413).send({
            error: `Файл больше ${Math.round(CHAT_UPLOAD_MAX_BYTES / 1024 / 1024)} МБ`,
            code: "FILE_TOO_LARGE",
          });
        }
        logger.warn({ err }, "chat-uploads: toBuffer failed");
        return reply.code(400).send({ error: "Не удалось прочитать файл" });
      }

      const ext = extFromMime(part.mimetype);
      const s3Key = `chat-uploads/${aibUserId}/${randomUUID()}.${ext}`;
      const uploaded = await uploadBuffer(s3Key, buffer, part.mimetype).catch((err) => {
        logger.error({ err, s3Key }, "chat-uploads: S3 upload failed");
        return null;
      });
      if (!uploaded) {
        return reply.code(500).send({ error: "S3 недоступен" });
      }

      const name = part.filename || `upload.${ext}`;

      // Персистим медиа (image/video/audio) для попапа «переиспользовать
      // загруженное». Документы не сохраняем. Best-effort: сбой записи не должен
      // ронять саму загрузку — файл уже лежит в S3.
      if (kind !== "document") {
        await uploadedMediaService
          .create({
            userId: aibUserId!,
            type: kind,
            s3Key,
            name,
            mimeType: part.mimetype,
            size: buffer.byteLength,
          })
          .catch((err) => {
            logger.error({ err, s3Key }, "chat-uploads: failed to persist uploaded media");
          });
      }

      const url = await getFileUrl(s3Key).catch(() => null);
      return {
        s3Key,
        name,
        mimeType: part.mimetype,
        size: buffer.byteLength,
        kind,
        url: url ?? null,
      };
    },
  );

  // ── POST /web/chat-uploads/sign ────────────────────────────────────────
  /**
   * Перевыпускает presigned URL'ы для уже загруженных файлов по их s3Key.
   * Используется страницами генерации (`GenerateScene`) при rehydrate
   * draft-state — presigned URL живёт час, draft хранится в localStorage
   * дольше, поэтому без рефреша превью бы ломалось.
   *
   * Разрешённые ключи: собственные `chat-uploads/{aibUserId}/...` (по префиксу)
   * и s3Key'и генераций этого юзера (по GenerationJobOutput) — последнее нужно,
   * чтобы переиспользованное в media-слоте сгенерированное медиа переживало
   * rehydrate. Чужой ключ → `null`, чтобы один битый ключ не ронял весь batch.
   */
  fastify.post<{ Body: { s3Keys: string[] } }>(
    "/web/chat-uploads/sign",
    {
      schema: {
        description: "Refresh presigned URLs for previously uploaded chat-uploads files",
        body: {
          type: "object",
          required: ["s3Keys"],
          properties: {
            s3Keys: {
              type: "array",
              items: { type: "string" },
              maxItems: 32,
            },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              urls: {
                type: "object",
                additionalProperties: { type: "string", nullable: true },
              },
            },
          },
          400: badRequestResponse,
        },
      },
    },
    async (request) => {
      const { aibUserId } = request.webUser!;
      const expectedPrefix = `chat-uploads/${aibUserId}/`;
      const unique = Array.from(new Set(request.body.s3Keys));

      // Помимо собственных chat-uploads ключей (по префиксу) разрешаем ресайнить
      // ключи генераций этого юзера — чтобы переиспользованное в media-слоте
      // сгенерированное медиа переживало восстановление черновика. Владение
      // проверяем по GenerationJobOutput (s3Key / thumbnailS3Key + job.userId).
      const foreignKeys = unique.filter((k) => !k.startsWith(expectedPrefix));
      const ownedOutputKeys = new Set<string>();
      if (foreignKeys.length > 0) {
        const rows = await db.generationJobOutput.findMany({
          where: {
            job: { userId: aibUserId! },
            OR: [{ s3Key: { in: foreignKeys } }, { thumbnailS3Key: { in: foreignKeys } }],
          },
          select: { s3Key: true, thumbnailS3Key: true },
        });
        for (const r of rows) {
          if (r.s3Key) ownedOutputKeys.add(r.s3Key);
          if (r.thumbnailS3Key) ownedOutputKeys.add(r.thumbnailS3Key);
        }
      }

      const urls: Record<string, string | null> = {};
      await Promise.all(
        unique.map(async (key) => {
          const allowed = key.startsWith(expectedPrefix) || ownedOutputKeys.has(key);
          urls[key] = allowed ? await getFileUrl(key).catch(() => null) : null;
        }),
      );
      return { urls };
    },
  );

  // ── GET /web/balance ────────────────────────────────────────────────────
  fastify.get("/web/balance", { schema: { hide: true } as any }, async (request) => {
    const { aibUserId } = request.webUser!;
    const user = await db.user.findUnique({
      where: { id: aibUserId! },
      select: {
        tokenBalance: true,
        subscriptionTokenBalance: true,
        localSubscription: {
          select: {
            planName: true,
            period: true,
            endDate: true,
            tokensGranted: true,
          },
        },
      },
    });
    return {
      tokenBalance: user?.tokenBalance.toString() ?? "0",
      subscriptionTokenBalance: user?.subscriptionTokenBalance.toString() ?? "0",
      subscription: user?.localSubscription
        ? {
            planName: user.localSubscription.planName,
            period: user.localSubscription.period,
            endDate: user.localSubscription.endDate.toISOString(),
            tokensGranted: user.localSubscription.tokensGranted,
          }
        : null,
    };
  });

  // ── GET /web/dialogs ────────────────────────────────────────────────────
  // `q` и `withStats` опциональны; без них поведение прежнее (используется
  // ChatSidebar / Chat.tsx, не платит за SUM(tokensUsed) и full-content поиск).
  // С `q` ищет в title + содержимом сообщений, возвращает `snippet`;
  // с `withStats=1` возвращает `totalTokens` per dialog.
  fastify.get<{ Querystring: { section?: string; q?: string; withStats?: string } }>(
    "/web/dialogs",
    {
      schema: {
        description: "List user dialogs (optional search + stats)",
        querystring: {
          type: "object",
          properties: {
            section: { type: "string" },
            q: { type: "string", description: "Search in title and message content" },
            withStats: {
              type: "string",
              description: "When '1'/'true', include totalTokens per dialog",
            },
          },
        },
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                id: { type: "string" },
                section: { type: "string" },
                modelId: { type: "string" },
                title: { type: "string", nullable: true },
                createdAt: { type: "string" },
                updatedAt: { type: "string" },
                totalTokens: { type: "number" },
                snippet: { type: "string", nullable: true },
                latestJobId: { type: "string", nullable: true },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { aibUserId } = request.webUser!;
      const section = request.query.section as Section | undefined;
      const q = request.query.q?.trim() || undefined;
      const withStats = request.query.withStats === "1" || request.query.withStats === "true";

      // Легаси-путь: без q/withStats не нагружаем БД лишним groupBy/ILIKE —
      // важно для ChatSidebar, который дёргает этот же endpoint.
      if (!q && !withStats) {
        const dialogs = await dialogService.listByUser(aibUserId!, section);
        return dialogs.map((d) => ({
          id: d.id,
          section: d.section,
          modelId: d.modelId,
          title: d.title ?? null,
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
        }));
      }

      const dialogs = await dialogService.listForHistory(aibUserId!, { section, q, withStats });
      return dialogs.map((d) => ({
        id: d.id,
        section: d.section,
        modelId: d.modelId,
        title: d.title ?? null,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
        ...(withStats ? { totalTokens: d.totalTokens ?? 0 } : {}),
        ...(q ? { snippet: d.snippet ?? null } : {}),
        latestJobId: d.latestJobId ?? null,
      }));
    },
  );

  // ── GET /web/history ────────────────────────────────────────────────────
  // Unified list для страницы /history:
  //  - kind="dialog": для gpt — Dialog с агрегированными tokensUsed по сообщениям.
  //  - kind="job": для image/video/audio — GenerationJob (по userId, dialogId
  //    игнорируется), потому что media-джобы часто создаются с пустым dialogId.
  //
  // Без q возвращает всю историю; с q фильтрует по title/контенту (gpt) и по
  // prompt (media). Без пагинации, sort: updatedAt desc.
  fastify.get<{ Querystring: { section?: string; q?: string } }>(
    "/web/history",
    {
      schema: {
        description: "Unified history (gpt dialogs + media generation jobs)",
        querystring: {
          type: "object",
          properties: {
            section: { type: "string", description: "gpt | image | design | video | audio" },
            q: { type: "string", description: "Search in title/content (gpt) and prompt (media)" },
          },
        },
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                kind: { type: "string" },
                id: { type: "string" },
                section: { type: "string" },
                modelId: { type: "string" },
                title: { type: "string", nullable: true },
                createdAt: { type: "string" },
                updatedAt: { type: "string" },
                totalTokens: { type: "number" },
                snippet: { type: "string", nullable: true },
                status: { type: "string" },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { aibUserId } = request.webUser!;
      const { section, q } = request.query;
      return historyService.list(aibUserId!, { section, q });
    },
  );

  // ── POST /web/dialogs ───────────────────────────────────────────────────
  fastify.post<{ Body: { section?: string; modelId?: string; title?: string } }>(
    "/web/dialogs",
    {
      schema: {
        description: "Create a new dialog",
        body: {
          type: "object",
          properties: {
            section: { type: "string" },
            modelId: { type: "string" },
            title: { type: "string" },
          },
          required: ["section", "modelId"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              id: { type: "string" },
              section: { type: "string" },
              modelId: { type: "string" },
              title: { type: "string", nullable: true },
              createdAt: { type: "string" },
              updatedAt: { type: "string" },
            },
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { aibUserId } = request.webUser!;
      const { section, modelId, title } = request.body ?? {};
      if (!section || !modelId) {
        return reply.code(400).send({ error: "section и modelId обязательны" });
      }
      const model = AI_MODELS[modelId];
      if (!model) return reply.code(400).send({ error: "Неизвестная модель" });

      const dialog = await dialogService.create({
        userId: aibUserId!,
        section: section as Section,
        modelId,
        title,
      });
      return {
        id: dialog.id,
        section: dialog.section,
        modelId: dialog.modelId,
        title: dialog.title ?? null,
        createdAt: dialog.createdAt.toISOString(),
        updatedAt: dialog.updatedAt.toISOString(),
      };
    },
  );

  // ── PATCH /web/dialogs/:id ──────────────────────────────────────────────
  fastify.patch<{ Params: { id: string }; Body: { title?: string } }>(
    "/web/dialogs/:id",
    {
      schema: {
        description: "Update dialog title by ID",
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
        body: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
          required: ["title"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              id: { type: "string" },
              title: { type: "string" },
            },
          },
          400: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
            description: "Title is required",
          },
          403: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
            description: "Forbidden",
          },
          404: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
            description: "Not found",
          },
        },
      },
    },
    async (request, reply) => {
      const { aibUserId } = request.webUser!;
      const { id } = request.params;
      const { title } = request.body ?? {};
      if (!title) return reply.code(400).send({ error: "title is required" });

      const dialog = await dialogService.findById(id);
      if (!dialog) return reply.code(404).send({ error: "Dialog not found" });
      if (dialog.userId !== aibUserId) return reply.code(403).send({ error: "Forbidden" });

      const updated = await dialogService.rename(id, title);
      return { id: updated.id, title: updated.title };
    },
  );

  // ── DELETE /web/dialogs/:id ─────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    "/web/dialogs/:id",
    {
      schema: {
        description: "Soft-delete a dialog by ID",
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              success: { type: "boolean" },
            },
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
      const { aibUserId } = request.webUser!;
      const { id } = request.params;
      const dialog = await dialogService.findById(id);
      if (!dialog) return reply.code(404).send({ error: "Dialog not found" });
      if (dialog.userId !== aibUserId) return reply.code(403).send({ error: "Forbidden" });

      await dialogService.softDelete(id, aibUserId!);
      return { success: true };
    },
  );

  // ── GET /web/dialogs/:id/messages ───────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    "/web/dialogs/:id/messages",
    {
      schema: {
        description: "Get messages for a dialog by ID",
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                id: { type: "string" },
                role: { type: "string" },
                content: { type: "string" },
                mediaUrl: { type: "string", nullable: true },
                mediaType: { type: "string", nullable: true },
                inputTokens: { type: "integer" },
                outputTokens: { type: "integer" },
                createdAt: { type: "string" },
                attachments: {
                  type: "array",
                  nullable: true,
                  items: {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                      s3Key: { type: "string" },
                      mimeType: { type: "string" },
                      name: { type: "string" },
                      size: { type: "number", nullable: true },
                      url: { type: "string", nullable: true },
                      kind: { type: "string" },
                    },
                  },
                },
              },
            },
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
      const { aibUserId } = request.webUser!;
      const { id } = request.params;

      const dialog = await dialogService.findById(id);
      if (!dialog) return reply.code(404).send({ error: "Dialog not found" });
      if (dialog.userId !== aibUserId) return reply.code(403).send({ error: "Forbidden" });

      const messages = await dialogService.getMessages(id);
      const resolved = await Promise.all(
        (
          messages as Array<{
            id: string;
            role: string;
            content: string;
            mediaUrl: string | null;
            mediaType: string | null;
            attachments: unknown;
            inputTokens: number;
            outputTokens: number;
            createdAt: Date;
          }>
        ).map(async (m) => {
          let mediaUrl = m.mediaUrl ?? null;
          if (mediaUrl && !mediaUrl.startsWith("http")) {
            mediaUrl = (await getFileUrl(mediaUrl)) ?? mediaUrl;
          }
          // attachments — JSON-поле в Message, prisma вернёт unknown. Маппим в
          // DTO с подписанным URL для превью. Изображения легко определяются по
          // mimeType (image/*), остальное считаем document.
          const rawAtts = Array.isArray(m.attachments)
            ? (m.attachments as Array<{
                s3Key?: string;
                mimeType?: string;
                name?: string;
                size?: number;
              }>)
            : [];
          const attachments = await Promise.all(
            rawAtts
              .filter((a) => typeof a.s3Key === "string" && typeof a.mimeType === "string")
              .map(async (a) => {
                const url = (await getFileUrl(a.s3Key!).catch(() => null)) ?? null;
                return {
                  s3Key: a.s3Key!,
                  mimeType: a.mimeType!,
                  name: a.name ?? "attachment",
                  size: typeof a.size === "number" ? a.size : null,
                  url,
                  kind: a.mimeType!.startsWith("image/") ? "image" : "document",
                };
              }),
          );
          return {
            id: m.id,
            role: m.role,
            content: m.content,
            mediaUrl,
            mediaType: m.mediaType ?? null,
            inputTokens: m.inputTokens,
            outputTokens: m.outputTokens,
            createdAt: m.createdAt.toISOString(),
            attachments: attachments.length > 0 ? attachments : null,
          };
        }),
      );
      return resolved;
    },
  );

  // ── POST /web/dialogs/:id/send (SSE) ────────────────────────────────────
  /**
   * Отправка сообщения с потоковым ответом через Server-Sent Events.
   *
   * Протокол SSE:
   *   event: chunk    data: { text: string }
   *   event: done     data: { messageId, tokensUsed, balance }
   *   event: error    data: { code, message }
   */
  fastify.post<{
    Params: { id: string };
    Body: {
      content?: string;
      /** S3 keys картинок (если пользователь приложил картинку). */
      imageS3Keys?: string[];
      /** Документы для модели (PDF/DOCX/XLSX/CSV/TXT/JSON). */
      documentAttachments?: Array<{
        s3Key: string;
        mimeType: string;
        name: string;
        size?: number;
      }>;
    };
  }>("/web/dialogs/:id/send", { schema: { hide: true } as any }, async (request, reply) => {
    const { aibUserId } = request.webUser!;
    const { id } = request.params;
    const content = (request.body?.content ?? "").trim();
    const imageS3Keys = request.body?.imageS3Keys?.filter((k) => typeof k === "string" && k);
    const documentAttachments = request.body?.documentAttachments?.filter(
      (a) => a && typeof a.s3Key === "string" && typeof a.mimeType === "string",
    );
    // Сообщение можно пустым (только attachment'ы) — chatService разберётся; но
    // если совсем ничего нет — пинаем 400.
    if (!content && !imageS3Keys?.length && !documentAttachments?.length) {
      return reply.code(400).send({ error: "Сообщение не может быть пустым" });
    }

    const dialog = await dialogService.findById(id);
    if (!dialog) return reply.code(404).send({ error: "Dialog not found" });
    if (dialog.userId !== aibUserId) return reply.code(403).send({ error: "Forbidden" });

    // @ts-expect-error some weird fastify magic
    const headers: OutgoingHttpHeaders = {
      ...reply.getHeaders(),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    };

    // @fastify/cors ставит Access-Control-Allow-Origin через reply.header(),
    // которые попадают в raw только при reply.send(). Здесь мы пишем напрямую
    // в reply.raw — поэтому сливаем ранее установленные fastify-заголовки
    // (CORS, прочие хуки) в writeHead, иначе браузер режет ответ по CORS.
    // reply.raw.writeHead(200, {
    //   ...reply.getHeaders(),
    //   "Content-Type": "text/event-stream",
    //   "Cache-Control": "no-cache, no-transform",
    //   Connection: "keep-alive",
    //   "X-Accel-Buffering": "no",
    // });
    reply.raw.writeHead(200, headers);
    reply.hijack();

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const stream = chatService.sendMessageStream({
        dialogId: id,
        userId: aibUserId!,
        content,
        // Картинки: передаём И imageS3Keys (для history-re-attach и save в DB),
        // И imageUrls (presigned) — без последних адаптер не получит `image_url`
        // блока в content и модель ответит «не вижу файла» (см. chat.service:357,
        // строит `LLMInput.imageUrls` ТОЛЬКО из переданных `imageUrls`).
        // Бот резолвит s3Key→URL до вызова сервиса; для web делаем то же тут.
        ...(imageS3Keys?.length
          ? {
              imageS3Keys,
              imageUrls: (
                await Promise.all(imageS3Keys.map((k) => getFileUrl(k).catch(() => null)))
              ).filter((u): u is string => typeof u === "string" && u.length > 0),
            }
          : {}),
        ...(documentAttachments?.length
          ? {
              documentAttachments: documentAttachments.map<StoredAttachment>((a) => ({
                s3Key: a.s3Key,
                mimeType: a.mimeType,
                name: a.name,
                ...(typeof a.size === "number" ? { size: a.size } : {}),
              })),
            }
          : {}),
      });
      let result: Awaited<ReturnType<typeof stream.next>>;
      while (true) {
        result = await stream.next();
        if (result.done) break;
        send("chunk", { text: result.value });
      }

      // Post-deduct balance уже лежит в `result.value` (см. `SendMessageResult`
      // в chat.service.ts) — отдельный `db.user.findUnique` повторял бы работу,
      // которую только что сделал `deductTokens`. Берём прямо из стрима.
      send("done", {
        tokensUsed: result.value?.tokensUsed ?? 0,
        inputTokens: result.value?.inputTokens ?? 0,
        outputTokens: result.value?.outputTokens ?? 0,
        balance: {
          tokenBalance: result.value?.tokenBalance?.toString() ?? "0",
          subscriptionTokenBalance: result.value?.subscriptionTokenBalance?.toString() ?? "0",
        },
      });
    } catch (err) {
      let code = "INTERNAL_ERROR";
      let message = "Что-то пошло не так";
      if (err instanceof ContextOverflowError) {
        code = "CONTEXT_OVERFLOW";
        message = "Превышен контекст модели. Начните новый диалог.";
      } else if (err instanceof DocumentNotSupportedError) {
        code = "DOCUMENT_NOT_SUPPORTED";
        message = err.message;
      } else if (err instanceof DocumentExtractFailedError) {
        code = "DOCUMENT_EXTRACT_FAILED";
        message = err.message;
      } else if (err instanceof Error && /insufficient|balance/i.test(err.message)) {
        code = "INSUFFICIENT_BALANCE";
        message = "Недостаточно токенов";
      }
      logger.error({ err, code }, "web/dialogs/send failed");
      send("error", { code, message });
    } finally {
      reply.raw.end();
    }
  });
};
