/**
 * /web/gallery — мирроr `/gallery/*` (миниапы) под web-auth.
 *
 * Использует `webTelegramLinkedPreHandler` — тот же гейт, что у web-chat,
 * web-generation, web-billing. Причина: gallery items создаются только когда
 * есть `User.id` (FK), а web-generation сам требует привязанный TG. Web-only
 * юзер без User-записи не имеет gallery-материала, так что 403 TELEGRAM_NOT_LINKED
 * — это правда контракта, а не искусственное ограничение.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { webTelegramLinkedPreHandler } from "../middlewares/web-auth.js";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";
import {
  galleryService,
  GalleryBadRequestError,
  GalleryForbiddenError,
  GalleryNotFoundError,
} from "../services/gallery.service.js";

function mapGalleryError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof GalleryNotFoundError) return reply.code(404).send({ error: err.message });
  if (err instanceof GalleryForbiddenError) return reply.code(403).send({ error: err.message });
  if (err instanceof GalleryBadRequestError) return reply.code(400).send({ error: err.message });
  throw err;
}

const folderResponseSchema = {
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
};

export const webGalleryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", webTelegramLinkedPreHandler);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["web-gallery"]));

  /**
   * GET /web/gallery?section=image|audio|video&page=1&limit=20&modelId&modelIds&folderId
   * Returns the current user's completed generation jobs, newest first.
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
  }>(
    "/web/gallery",
    {
      schema: {
        description: "List completed generation jobs for the current web user",
        querystring: {
          type: "object",
          properties: {
            section: { type: "string", description: "image | audio | video" },
            page: { type: "string" },
            limit: { type: "string" },
            modelId: { type: "string" },
            modelIds: { type: "string", description: "Comma-separated list of model IDs" },
            folderId: { type: "string" },
          },
        },
      },
    },
    async (request: FastifyRequest) => {
      const aibUserId = request.webUser!.aibUserId!;
      const { section, page = "1", limit = "20", modelId, modelIds, folderId } = request.query as {
        section?: string;
        page?: string;
        limit?: string;
        modelId?: string;
        modelIds?: string;
        folderId?: string;
      };
      return galleryService.listJobs(
        aibUserId,
        {
          section,
          page: parseInt(page, 10) || 1,
          limit: parseInt(limit, 10) || 20,
          modelId,
          modelIds,
          folderId,
        },
        { favoritesFirst: true },
      );
    },
  );

  /**
   * GET /web/gallery/model-counts?section=image|audio|video
   * Per-model generation counts for the current user.
   */
  fastify.get<{ Querystring: { section?: string; folderId?: string } }>(
    "/web/gallery/model-counts",
    {
      schema: {
        description: "Per-model job counts for current user",
        querystring: {
          type: "object",
          properties: {
            section: { type: "string" },
            folderId: { type: "string" },
          },
        },
      },
    },
    async (request: FastifyRequest) => {
      const aibUserId = request.webUser!.aibUserId!;
      const { section, folderId } = request.query as {
        section?: string;
        folderId?: string;
      };
      return galleryService.getModelCounts(aibUserId, section, folderId);
    },
  );

  /**
   * GET /web/gallery/:id/preview-url
   * :id is a GenerationJobOutput ID.
   */
  fastify.get<{ Params: { id: string } }>(
    "/web/gallery/:id/preview-url",
    {
      schema: {
        description: "Get playable preview URL for gallery item",
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { url: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const aibUserId = request.webUser!.aibUserId!;
      const { id } = request.params;
      try {
        const url = await galleryService.getOutputPreviewUrl(aibUserId, id);
        return { url };
      } catch (err) {
        if (err instanceof GalleryBadRequestError)
          return reply.code(422).send({ error: err.message });
        return mapGalleryError(err, reply);
      }
    },
  );

  /**
   * GET /web/gallery/outputs/:id/original-url
   * Returns a presigned S3 URL with attachment-disposition for browser download.
   */
  fastify.get<{ Params: { id: string } }>(
    "/web/gallery/outputs/:id/original-url",
    {
      schema: {
        description: "Get original file download URL",
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { url: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const aibUserId = request.webUser!.aibUserId!;
      const { id } = request.params;
      try {
        const url = await galleryService.getOutputOriginalUrl(aibUserId, id);
        return { url };
      } catch (err) {
        if (err instanceof GalleryBadRequestError)
          return reply.code(422).send({ error: err.message });
        return mapGalleryError(err, reply);
      }
    },
  );

  /**
   * GET /web/gallery/jobs/:id
   * Single job + outputs. Used by web frontend for deep-link `/gallery/:jobId`.
   * Returns 404 on unknown / not-owned job.
   */
  fastify.get<{ Params: { id: string } }>(
    "/web/gallery/jobs/:id",
    {
      schema: {
        description: "Fetch a single completed job by id",
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      const aibUserId = request.webUser!.aibUserId!;
      const { id } = request.params;
      try {
        return await galleryService.getJobById(aibUserId, id);
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );

  /**
   * DELETE /web/gallery/jobs/:id
   * Removes the entire generation job — all outputs + S3 artifacts.
   */
  fastify.delete<{ Params: { id: string } }>(
    "/web/gallery/jobs/:id",
    {
      schema: {
        description: "Delete a generation job and its outputs",
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      const aibUserId = request.webUser!.aibUserId!;
      const { id } = request.params;
      try {
        await galleryService.deleteJob(aibUserId, id);
        return { success: true };
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );

  // ── Folders ───────────────────────────────────────────────────────────────

  fastify.get(
    "/web/gallery/folders",
    {
      schema: {
        description: "Get user's gallery folders",
        response: {
          200: { type: "array", items: folderResponseSchema },
        },
      },
    },
    async (request) => {
      const aibUserId = request.webUser!.aibUserId!;
      return galleryService.listFolders(aibUserId);
    },
  );

  fastify.post<{ Body: { name: string } }>(
    "/web/gallery/folders",
    {
      schema: {
        description: "Create a new gallery folder",
        body: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        response: {
          200: folderResponseSchema,
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const aibUserId = request.webUser!.aibUserId!;
      const { name } = request.body;
      try {
        return await galleryService.createFolder(aibUserId, name);
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );

  fastify.patch<{
    Params: { folderId: string };
    Body: { name?: string; isPinned?: boolean };
  }>(
    "/web/gallery/folders/:folderId",
    {
      schema: {
        description: "Rename or pin/unpin a folder",
        params: {
          type: "object",
          properties: { folderId: { type: "string" } },
          required: ["folderId"],
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            isPinned: { type: "boolean" },
          },
        },
        response: { 200: folderResponseSchema },
      },
    },
    async (request, reply) => {
      const aibUserId = request.webUser!.aibUserId!;
      const { folderId } = request.params;
      const { name, isPinned } = request.body;
      try {
        return await galleryService.updateFolder(aibUserId, folderId, { name, isPinned });
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );

  fastify.delete<{ Params: { folderId: string } }>(
    "/web/gallery/folders/:folderId",
    {
      schema: {
        description: "Delete a gallery folder",
        params: {
          type: "object",
          properties: { folderId: { type: "string" } },
          required: ["folderId"],
        },
      },
    },
    async (request, reply) => {
      const aibUserId = request.webUser!.aibUserId!;
      const { folderId } = request.params;
      try {
        await galleryService.deleteFolder(aibUserId, folderId);
        return { success: true };
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );

  fastify.post<{
    Params: { folderId: string };
    Body: { jobId: string };
  }>(
    "/web/gallery/folders/:folderId/items",
    {
      schema: {
        description: "Add a job to a folder",
        params: {
          type: "object",
          properties: { folderId: { type: "string" } },
          required: ["folderId"],
        },
        body: {
          type: "object",
          properties: { jobId: { type: "string" } },
          required: ["jobId"],
        },
      },
    },
    async (request, reply) => {
      const aibUserId = request.webUser!.aibUserId!;
      const { folderId } = request.params;
      const { jobId } = request.body;
      try {
        await galleryService.addJobToFolder(aibUserId, folderId, jobId);
        return { success: true };
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );

  fastify.delete<{ Params: { folderId: string; jobId: string } }>(
    "/web/gallery/folders/:folderId/items/:jobId",
    {
      schema: {
        description: "Remove a job from a folder",
        params: {
          type: "object",
          properties: {
            folderId: { type: "string" },
            jobId: { type: "string" },
          },
          required: ["folderId", "jobId"],
        },
      },
    },
    async (request, reply) => {
      const aibUserId = request.webUser!.aibUserId!;
      const { folderId, jobId } = request.params;
      try {
        await galleryService.removeJobFromFolder(aibUserId, folderId, jobId);
        return { success: true };
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );

  // ── Favorites (sugar over a default folder) ───────────────────────────────

  fastify.post<{ Body: { jobId: string } }>(
    "/web/gallery/favorites",
    {
      schema: {
        description: "Add a job to the user's Favorites folder (auto-created)",
        body: {
          type: "object",
          properties: { jobId: { type: "string" } },
          required: ["jobId"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { folderId: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const aibUserId = request.webUser!.aibUserId!;
      const { jobId } = request.body;
      try {
        return await galleryService.addToFavorites(aibUserId, jobId);
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );

  fastify.delete<{ Params: { jobId: string } }>(
    "/web/gallery/favorites/:jobId",
    {
      schema: {
        description: "Remove a job from the user's Favorites folder",
        params: {
          type: "object",
          properties: { jobId: { type: "string" } },
          required: ["jobId"],
        },
      },
    },
    async (request, reply) => {
      const aibUserId = request.webUser!.aibUserId!;
      const { jobId } = request.params;
      try {
        await galleryService.removeFromFavorites(aibUserId, jobId);
        return { success: true };
      } catch (err) {
        return mapGalleryError(err, reply);
      }
    },
  );
};
