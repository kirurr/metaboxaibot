import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { config } from "@metabox/shared";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";
import { promptExamplesService } from "../services/prompt-examples.js";
import type { PromptExample as PrismaPromptExample } from "@prisma/client";
import {
  listPromptExamplesQuerySchema,
  createPromptExampleBodySchema,
  updatePromptExampleBodySchema,
  type PromptExample,
  type CreatePromptExampleBody,
  type UpdatePromptExampleBody,
} from "@metabox/shared-browser/dto";

function serialize(example: PrismaPromptExample): PromptExample {
  return {
    id: example.id,
    modelId: example.modelId,
    modelSettings: example.modelSettings ?? null,
    prompt: example.prompt,
    mediaS3Key: example.mediaS3Key,
    thumbnailS3Key: example.thumbnailS3Key,
    section: example.section as PromptExample["section"],
    createdAt: example.createdAt.toISOString(),
  };
}

const listQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    section: { type: "string", enum: ["image", "video", "audio"] },
    cursor: { type: "string" },
    take: { type: "string" },
  },
} as const;

const itemSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    modelId: { type: "string" },
    modelSettings: { nullable: true },
    prompt: { type: "string" },
    mediaS3Key: { type: "string", nullable: true },
    thumbnailS3Key: { type: "string", nullable: true },
    section: { type: "string" },
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

export async function webPromptsRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /web/prompts — public */
  fastify.get<{
    Querystring: { section?: string; cursor?: string; take?: string };
  }>(
    "/web/prompts",
    {
      schema: {
        tags: ["web-prompts"],
        description: "List prompt examples with cursor pagination",
        querystring: listQuerySchema,
        response: { 200: pageSchema },
      },
    },
    async (request, reply) => {
      const parsed = listPromptExamplesQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        await reply.status(400).send({ error: parsed.error.message });
        return;
      }
      const page = await promptExamplesService.list(parsed.data);
      return { items: page.items.map(serialize), nextCursor: page.nextCursor };
    },
  );

  /** Admin CRUD under /admin/prompts */
  await fastify.register(async (admin) => {
    admin.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["web-prompts"]));
    admin.addHook("preHandler", async (request, reply) => {
      const secret = config.api.adminSecret;
      const provided = request.headers["x-admin-secret"];
      if (secret && provided === secret) return;

      try {
        await telegramAuthHook(request, reply);
      } catch {
        await reply.status(403).send({ error: "Forbidden" });
        return;
      }

      const { userId } = request as unknown as { userId: bigint };
      const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (!user || (user.role !== "ADMIN" && user.role !== "MODERATOR")) {
        await reply.status(403).send({ error: "Forbidden" });
      }
    });

    /** GET /admin/prompts */
    admin.get<{
      Querystring: { section?: string; cursor?: string; take?: string };
    }>(
      "/admin/prompts",
      {
        schema: {
          description: "Admin: list all prompt examples with cursor pagination",
          querystring: listQuerySchema,
          response: { 200: pageSchema },
        },
      },
      async (request, reply) => {
        const parsed = listPromptExamplesQuerySchema.safeParse(request.query);
        if (!parsed.success) {
          await reply.status(400).send({ error: parsed.error.message });
          return;
        }
        const page = await promptExamplesService.list(parsed.data);
        return { items: page.items.map(serialize), nextCursor: page.nextCursor };
      },
    );

    /** POST /admin/prompts */
    admin.post<{ Body: CreatePromptExampleBody }>(
      "/admin/prompts",
      {
        schema: {
          description: "Admin: create a prompt example",
          body: {
            type: "object",
            additionalProperties: true,
            required: ["modelId", "prompt", "section"],
            properties: {
              modelId: { type: "string" },
              modelSettings: {},
              prompt: { type: "string" },
              mediaS3Key: { type: "string" },
              thumbnailS3Key: { type: "string" },
              section: { type: "string", enum: ["image", "video", "audio"] },
            },
          },
          response: { 200: itemSchema, 400: badRequestResponse },
        },
      },
      async (request, reply) => {
        const parsed = createPromptExampleBodySchema.safeParse(request.body);
        if (!parsed.success) {
          await reply.status(400).send({ error: parsed.error.message });
          return;
        }
        const example = await promptExamplesService.create(parsed.data);
        return serialize(example);
      },
    );

    /** PATCH /admin/prompts/:id */
    admin.patch<{ Params: { id: string }; Body: UpdatePromptExampleBody }>(
      "/admin/prompts/:id",
      {
        schema: {
          description: "Admin: update a prompt example",
          params: {
            type: "object",
            additionalProperties: true,
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          body: {
            type: "object",
            additionalProperties: true,
            properties: {
              modelId: { type: "string" },
              modelSettings: {},
              prompt: { type: "string" },
              mediaS3Key: { type: "string", nullable: true },
              thumbnailS3Key: { type: "string", nullable: true },
              section: { type: "string", enum: ["image", "video", "audio"] },
            },
          },
          response: {
            200: itemSchema,
            404: { type: "object", additionalProperties: true, properties: { error: { type: "string" } } },
          },
        },
      },
      async (request, reply) => {
        const parsed = updatePromptExampleBodySchema.safeParse(request.body);
        if (!parsed.success) {
          await reply.status(400).send({ error: parsed.error.message });
          return;
        }
        const updated = await promptExamplesService.update(request.params.id, parsed.data);
        if (!updated) {
          await reply.status(404).send({ error: "Prompt example not found" });
          return;
        }
        return serialize(updated);
      },
    );

    /** DELETE /admin/prompts/:id */
    admin.delete<{ Params: { id: string } }>(
      "/admin/prompts/:id",
      {
        schema: {
          description: "Admin: delete a prompt example",
          params: {
            type: "object",
            additionalProperties: true,
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          response: {
            200: { type: "object", additionalProperties: true, properties: { success: { type: "boolean" } } },
            404: { type: "object", additionalProperties: true, properties: { error: { type: "string" } } },
          },
        },
      },
      async (request, reply) => {
        const deleted = await promptExamplesService.delete(request.params.id);
        if (!deleted) {
          await reply.status(404).send({ error: "Prompt example not found" });
          return;
        }
        return { success: true };
      },
    );
  });
}
