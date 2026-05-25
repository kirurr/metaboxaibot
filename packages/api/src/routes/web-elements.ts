/**
 * /web/elements — пользовательские Element'ы: именованные (@-тег) наборы
 * референсных изображений для @-синтаксиса моделей (Kling и т.п.).
 *
 * Картинки элемента хранятся как UploadedMedia с проставленным elementId, поэтому
 * в общий список переиспользования (web-uploaded-media.ts) они НЕ попадают —
 * `uploadedMediaService.list` фильтрует elementId IS NULL.
 *
 * Защищён `webTelegramLinkedPreHandler` — тот же гейт, что у web-chat/web-uploaded-media:
 * Element/UploadedMedia создаются только когда есть User.id.
 */

import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { webTelegramLinkedPreHandler } from "../middlewares/web-auth.js";
import {
  badRequestResponse,
  conflictResponse,
  constructOpenAPIonRouteHook,
} from "../utils/openapi.js";
import { elementService, ElementNameConflictError } from "../services/element.service.js";
import { getFileUrl, uploadBuffer } from "../services/s3.service.js";
import { CHAT_UPLOAD_MAX_BYTES, IMAGE_MIMES, extFromMime } from "../utils/upload-mime.js";
import { createElementBodySchema, updateElementBodySchema } from "@metabox/shared-browser/dto";
import { logger } from "../logger.js";
import type { UploadedMedia as PrismaUploadedMedia } from "@prisma/client";
import type { ElementWithMedia } from "../services/element.service.js";

async function serializeMedia(item: PrismaUploadedMedia) {
  const url = await getFileUrl(item.s3Key).catch(() => null);
  return {
    id: item.id,
    s3Key: item.s3Key,
    name: item.name,
    mimeType: item.mimeType,
    size: item.size,
    url: url ?? null,
    createdAt: item.createdAt.toISOString(),
  };
}

async function serializeElement(element: ElementWithMedia) {
  return {
    id: element.id,
    name: element.name,
    createdAt: element.createdAt.toISOString(),
    media: await Promise.all(element.media.map((m) => serializeMedia(m))),
  };
}

const mediaSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    s3Key: { type: "string" },
    name: { type: "string" },
    mimeType: { type: "string" },
    size: { type: "number" },
    url: { type: "string", nullable: true },
    createdAt: { type: "string" },
  },
} as const;

const elementSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    createdAt: { type: "string" },
    media: { type: "array", items: mediaSchema },
  },
} as const;

const elementsResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: { items: { type: "array", items: elementSchema } },
} as const;

const successSchema = {
  type: "object",
  additionalProperties: true,
  properties: { success: { type: "boolean" } },
} as const;

const bodySchema = {
  type: "object",
  additionalProperties: true,
  required: ["name"],
  properties: { name: { type: "string" } },
} as const;

const idParamsSchema = {
  type: "object",
  additionalProperties: true,
  required: ["id"],
  properties: { id: { type: "string" } },
} as const;

const mediaParamsSchema = {
  type: "object",
  additionalProperties: true,
  required: ["id", "mediaId"],
  properties: { id: { type: "string" }, mediaId: { type: "string" } },
} as const;

export const webElementsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", webTelegramLinkedPreHandler);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["web-elements"]));

  /** GET /web/elements — все элементы пользователя (newest first) с media. */
  fastify.get(
    "/web/elements",
    {
      schema: {
        description: "List the current user's elements with their reference images",
        response: { 200: elementsResponseSchema },
      },
    },
    async (request) => {
      const { aibUserId } = request.webUser!;
      const elements = await elementService.list(aibUserId!);
      return { items: await Promise.all(elements.map((el) => serializeElement(el))) };
    },
  );

  /** POST /web/elements — создать пустой элемент. 409 при дубле имени. */
  fastify.post<{ Body: { name: string } }>(
    "/web/elements",
    {
      schema: {
        description: "Create a new element",
        body: bodySchema,
        response: { 200: elementSchema, 400: badRequestResponse, 409: conflictResponse },
      },
    },
    async (request, reply) => {
      const parsed = createElementBodySchema.safeParse(request.body);
      if (!parsed.success) {
        await reply.status(400).send({ error: parsed.error.message });
        return;
      }
      const { aibUserId } = request.webUser!;
      try {
        const element = await elementService.create(aibUserId!, parsed.data.name);
        return await serializeElement(element);
      } catch (err) {
        if (err instanceof ElementNameConflictError) {
          await reply.status(409).send({ error: "Element name already exists" });
          return;
        }
        throw err;
      }
    },
  );

  /** PATCH /web/elements/:id — переименовать. 404 / 409. */
  fastify.patch<{ Params: { id: string }; Body: { name: string } }>(
    "/web/elements/:id",
    {
      schema: {
        description: "Rename an element",
        params: idParamsSchema,
        body: bodySchema,
        response: { 200: elementSchema, 400: badRequestResponse, 409: conflictResponse },
      },
    },
    async (request, reply) => {
      const parsed = updateElementBodySchema.safeParse(request.body);
      if (!parsed.success) {
        await reply.status(400).send({ error: parsed.error.message });
        return;
      }
      const { aibUserId } = request.webUser!;
      try {
        const element = await elementService.rename(
          aibUserId!,
          request.params.id,
          parsed.data.name,
        );
        if (!element) {
          await reply.status(404).send({ error: "Element not found" });
          return;
        }
        return await serializeElement(element);
      } catch (err) {
        if (err instanceof ElementNameConflictError) {
          await reply.status(409).send({ error: "Element name already exists" });
          return;
        }
        throw err;
      }
    },
  );

  /** DELETE /web/elements/:id — удалить элемент (media каскадятся, S3 не трогаем). */
  fastify.delete<{ Params: { id: string } }>(
    "/web/elements/:id",
    {
      schema: {
        description: "Delete an element and its reference images (S3 objects untouched)",
        params: idParamsSchema,
        response: { 200: successSchema },
      },
    },
    async (request, reply) => {
      const { aibUserId } = request.webUser!;
      const deleted = await elementService.delete(aibUserId!, request.params.id);
      if (!deleted) {
        await reply.status(404).send({ error: "Element not found" });
        return;
      }
      return { success: true };
    },
  );

  /** POST /web/elements/:id/media — загрузить картинку в элемент (multipart, image only). */
  fastify.post<{ Params: { id: string } }>(
    "/web/elements/:id/media",
    {
      schema: {
        description: "Upload a reference image into an element",
        consumes: ["multipart/form-data"],
        params: idParamsSchema,
        response: {
          200: mediaSchema,
          400: badRequestResponse,
          413: badRequestResponse,
          415: badRequestResponse,
          500: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { aibUserId } = request.webUser!;
      const elementId = request.params.id;

      let part;
      try {
        part = await request.file({ limits: { fileSize: CHAT_UPLOAD_MAX_BYTES } });
      } catch (err) {
        logger.warn({ err }, "element-media: failed to read multipart");
        return reply.code(400).send({ error: "Файл не передан" });
      }
      if (!part) {
        return reply.code(400).send({ error: "Файл не передан" });
      }

      // Только изображения — Element это набор референсных картинок.
      if (!IMAGE_MIMES.has(part.mimetype)) {
        return reply.code(415).send({
          error: `Тип файла не поддерживается: ${part.mimetype}`,
          code: "UNSUPPORTED_MEDIA_TYPE",
        });
      }

      let buffer: Buffer;
      try {
        buffer = await part.toBuffer();
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.code(413).send({
            error: `Файл больше ${Math.round(CHAT_UPLOAD_MAX_BYTES / 1024 / 1024)} МБ`,
            code: "FILE_TOO_LARGE",
          });
        }
        logger.warn({ err }, "element-media: toBuffer failed");
        return reply.code(400).send({ error: "Не удалось прочитать файл" });
      }

      const ext = extFromMime(part.mimetype);
      const s3Key = `elements/${aibUserId}/${elementId}/${randomUUID()}.${ext}`;
      const uploaded = await uploadBuffer(s3Key, buffer, part.mimetype).catch((err) => {
        logger.error({ err, s3Key }, "element-media: S3 upload failed");
        return null;
      });
      if (!uploaded) {
        return reply.code(500).send({ error: "S3 недоступен" });
      }

      const name = part.filename || `image.${ext}`;
      const media = await elementService.addMedia(aibUserId!, elementId, {
        s3Key,
        name,
        mimeType: part.mimetype,
        size: buffer.byteLength,
      });
      if (!media) {
        // Элемент не найден / чужой — файл уже в S3, но строку не создаём.
        return reply.code(404).send({ error: "Element not found" });
      }

      return serializeMedia(media);
    },
  );

  /** DELETE /web/elements/:id/media/:mediaId — убрать картинку из элемента. */
  fastify.delete<{ Params: { id: string; mediaId: string } }>(
    "/web/elements/:id/media/:mediaId",
    {
      schema: {
        description: "Remove a reference image from an element (S3 object untouched)",
        params: mediaParamsSchema,
        response: { 200: successSchema },
      },
    },
    async (request, reply) => {
      const { aibUserId } = request.webUser!;
      const removed = await elementService.removeMedia(
        aibUserId!,
        request.params.id,
        request.params.mediaId,
      );
      if (!removed) {
        await reply.status(404).send({ error: "Element media not found" });
        return;
      }
      return { success: true };
    },
  );
};
