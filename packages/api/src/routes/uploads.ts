import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { userUploadsService } from "../services/user-uploads.service.js";
import { getFileUrl } from "../services/s3.service.js";
import { constructOpenAPIonRouteHook, badRequestResponse } from "../utils/openapi.js";

type AuthRequest = FastifyRequest & { userId: bigint };

interface UploadDTO {
  id: string;
  type: string;
  name: string;
  url: string;
  s3Key: string | null;
  createdAt: string;
}

type RawUpload = {
  id: string;
  type: string;
  name: string;
  url: string;
  s3Key: string | null;
  createdAt: Date;
};

/** Resolve a fresh URL: if s3Key exists use S3 (presigned or public), else keep stored URL. */
async function resolveUrl(u: RawUpload): Promise<string> {
  if (u.s3Key) {
    const fresh = await getFileUrl(u.s3Key).catch(() => null);
    if (fresh) return fresh;
  }
  return u.url;
}

async function toDTO(u: RawUpload): Promise<UploadDTO> {
  return {
    id: u.id,
    type: u.type,
    name: u.name,
    url: await resolveUrl(u),
    s3Key: u.s3Key,
    createdAt: u.createdAt.toISOString(),
  };
}

export const uploadsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["uploads"]),
  );

  /** GET /uploads?type=voice — list user uploads, optionally filtered by type */
  fastify.get<{ Querystring: { type?: string } }>("/uploads", {
    schema: {
      description: "List user uploads, optionally filtered by type",
      querystring: {
        type: "object",
        properties: {
          type: { type: "string", description: "Filter by upload type (e.g., voice)" },
        },
      },
      response: {
        200: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: { type: "string" },
              name: { type: "string" },
              url: { type: "string" },
              s3Key: { type: "string", nullable: true },
              createdAt: { type: "string" },
            },
          },
        },
      },
    },
  }, async (request) => {
    const { userId } = request as AuthRequest;
    const { type } = request.query;
    const uploads = await userUploadsService.list(userId, type);
    return Promise.all(uploads.map(toDTO));
  });

  /** PATCH /uploads/:id — rename */
  fastify.patch<{ Params: { id: string }; Body: { name: string } }>(
    "/uploads/:id",
    {
      schema: {
        description: "Rename an upload by ID",
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string" },
              type: { type: "string" },
              name: { type: "string" },
              url: { type: "string" },
              s3Key: { type: "string", nullable: true },
              createdAt: { type: "string" },
            },
          },
          400: { 
            type: "object", 
            description: "Name is required",
            properties: { error: { type: "string" } } 
          },
          404: { 
            type: "object", 
            description: "Not found",
            properties: { error: { type: "string" } } 
          },
        },
      },
    },
    async (request, reply) => {
      const { userId } = request as AuthRequest;
      const { id } = request.params;
      const { name } = request.body;
      if (!name?.trim()) {
        return reply.status(400).send({ error: "name is required" });
      }
      const updated = await userUploadsService.rename(id, userId, name.trim());
      if (!updated) return reply.status(404).send({ error: "Upload not found" });
      return toDTO(updated);
    },
  );

  /** DELETE /uploads/:id */
  fastify.delete<{ Params: { id: string } }>("/uploads/:id", {
    schema: {
      description: "Delete an upload by ID",
      params: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            success: { type: "boolean" },
          },
        },
        404: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const { userId } = request as AuthRequest;
    const { id } = request.params;
    const ok = await userUploadsService.delete(id, userId);
    if (!ok) return reply.status(404).send({ error: "Upload not found" });
    return { success: true };
  });
};