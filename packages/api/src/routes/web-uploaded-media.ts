/**
 * /web/uploaded-media — список и удаление ранее загруженных пользователем медиа
 * (картинки/видео/аудио). Питает попап «переиспользовать загруженное» на
 * страницах генерации. Записи создаются в POST /web/chat-uploads (web-chat.ts).
 *
 * Защищён `webTelegramLinkedPreHandler` — тот же гейт, что у web-chat/web-gallery:
 * media создаётся только когда есть User.id (FK на uploaded_media.userId).
 */

import type { FastifyPluginAsync } from "fastify";
import { webTelegramLinkedPreHandler } from "../middlewares/web-auth.js";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";
import { uploadedMediaService } from "../services/uploaded-media.service.js";
import { getFileUrl } from "../services/s3.service.js";
import { listUploadedMediaQuerySchema } from "@metabox/shared-browser/dto";
import type { UploadedMedia as PrismaUploadedMedia } from "@prisma/client";

async function serialize(item: PrismaUploadedMedia) {
  const url = await getFileUrl(item.s3Key).catch(() => null);
  return {
    id: item.id,
    type: item.type,
    s3Key: item.s3Key,
    name: item.name,
    mimeType: item.mimeType,
    size: item.size,
    url: url ?? null,
    createdAt: item.createdAt.toISOString(),
  };
}

const itemSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    s3Key: { type: "string" },
    name: { type: "string" },
    mimeType: { type: "string" },
    size: { type: "number" },
    url: { type: "string", nullable: true },
    createdAt: { type: "string" },
  },
} as const;

const pageSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    items: { type: "array", items: itemSchema },
    nextCursor: { type: "string", nullable: true },
  },
} as const;

const listQuerySchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    type: { type: "string" },
    cursor: { type: "string" },
    take: { type: "string" },
  },
} as const;

export const webUploadedMediaRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", webTelegramLinkedPreHandler);
  fastify.addHook("onRoute", (params) =>
    constructOpenAPIonRouteHook(params, ["web-uploaded-media"]),
  );

  /** GET /web/uploaded-media?type=&cursor=&take= — newest first, cursor pagination. */
  fastify.get<{ Querystring: { type?: string; cursor?: string; take?: string } }>(
    "/web/uploaded-media",
    {
      schema: {
        description: "List the current user's uploaded media with cursor pagination",
        querystring: listQuerySchema,
        response: { 200: pageSchema, 400: badRequestResponse },
      },
    },
    async (request, reply) => {
      const parsed = listUploadedMediaQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        await reply.status(400).send({ error: parsed.error.message });
        return;
      }
      const { aibUserId } = request.webUser!;
      const page = await uploadedMediaService.list({ userId: aibUserId!, ...parsed.data });
      return {
        items: await Promise.all(page.items.map((it) => serialize(it))),
        nextCursor: page.nextCursor,
      };
    },
  );

  /** DELETE /web/uploaded-media/:id — removes the row only (S3 object untouched). */
  fastify.delete<{ Params: { id: string } }>(
    "/web/uploaded-media/:id",
    {
      schema: {
        description: "Delete an uploaded-media record (does not delete the S3 object)",
        params: {
          type: "object",
          additionalProperties: true,
          required: ["id"],
          properties: { id: { type: "string" } },
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
      const { aibUserId } = request.webUser!;
      const deleted = await uploadedMediaService.delete(aibUserId!, request.params.id);
      if (!deleted) {
        await reply.status(404).send({ error: "Uploaded media not found" });
        return;
      }
      return { success: true };
    },
  );
};
