import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { config, AI_MODELS } from "@metabox/shared";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { extractWebUserFromRequest } from "../middlewares/web-auth.js";
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
import { s3Service } from "../services/s3.service.js";

async function serialize(
  example: PrismaPromptExample,
  options: { includeS3Keys?: boolean } = {},
): Promise<PromptExample> {
  let [thumbnailUrl, mediaUrl] = await Promise.all([
    example.thumbnailS3Key
      ? s3Service.getFileUrl(example.thumbnailS3Key)
      : "https://picsum.photos/400",
    example.mediaS3Key ? s3Service.getFileUrl(example.mediaS3Key) : "https://picsum.photos/400",
  ]);

  // TODO: remove this hack when we ready to add generated images, its just for testing
  if (example.section === "video") {
    mediaUrl =
      "https://d8j0ntlcm91z4.cloudfront.net/user_3CIjqzTsrKEUr8OzFBaYO4ux3nG/hf_20260413_121933_7dfa9582-a536-4a83-9041-ee5aa102ff8c.mp4";
  }

  const aiModel = AI_MODELS[example.modelId];
  return {
    id: example.id,
    model: aiModel
      ? {
          id: aiModel.id,
          name: aiModel.name,
          section: aiModel.section,
          provider: aiModel.provider,
          settings: aiModel.settings ?? null,
        }
      : null,
    modelSettings: example.modelSettings ?? null,
    prompt: example.prompt,
    thumbnailUrl: thumbnailUrl ?? null,
    mediaUrl: mediaUrl ?? null,
    ...(options.includeS3Keys
      ? {
          mediaS3Key: example.mediaS3Key ?? null,
          thumbnailS3Key: example.thumbnailS3Key ?? null,
        }
      : {}),
    section: example.section,
    createdAt: example.createdAt.toISOString(),
  };
}

const listQuerySchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    section: { type: "string" },
    cursor: { type: "string" },
    take: { type: "string" },
  },
} as const;

const itemSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    model: {
      nullable: true,
      type: "object",
      additionalProperties: true,
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        section: { type: "string" },
        provider: { type: "string" },
        settings: { type: "array", nullable: true },
      },
    },
    modelSettings: { nullable: true },
    prompt: { type: "string" },
    mediaUrl: { type: "string", nullable: true },
    thumbnailUrl: { type: "string", nullable: true },
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

const modelDtoSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    section: { type: "string" },
    provider: { type: "string" },
    settings: { type: "array", nullable: true },
  },
} as const;

const modelsResponseSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    models: { type: "array", items: modelDtoSchema },
  },
} as const;

const PROMPT_MODEL_SECTIONS = ["design", "video"] as const;
type PromptModelSection = (typeof PROMPT_MODEL_SECTIONS)[number];

function listPromptModels() {
  const models = Object.values(AI_MODELS)
    .filter((m): m is typeof m & { section: PromptModelSection } =>
      (PROMPT_MODEL_SECTIONS as readonly string[]).includes(m.section),
    )
    .sort((a, b) => {
      if (a.section !== b.section) return a.section.localeCompare(b.section);
      return a.name.localeCompare(b.name);
    })
    .map((m) => ({
      id: m.id,
      name: m.name,
      section: m.section,
      provider: m.provider,
      settings: m.settings ?? null,
    }));
  return { models };
}

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
      return {
        items: await Promise.all(page.items.map((it) => serialize(it))),
        nextCursor: page.nextCursor,
      };
    },
  );

  /** Admin CRUD under /admin/prompts */
  await fastify.register(async (admin) => {
    admin.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["web-prompts"]));
    admin.addHook("preHandler", async (request, reply) => {
      const secret = config.api.adminSecret;
      const provided = request.headers["x-admin-secret"];
      if (secret && provided === secret) return;

      const authHeader = request.headers.authorization ?? "";
      let aibUserId: bigint | null = null;

      if (authHeader.startsWith("Bearer ")) {
        // Web JWT (packages/web)
        const webUser = await extractWebUserFromRequest(request);
        if (!webUser || webUser.aibUserId === null) {
          await reply.status(403).send({ error: "Forbidden" });
          return;
        }
        request.webUser = webUser;
        aibUserId = webUser.aibUserId;
      } else {
        // TMA initData / wtoken (Telegram miniapp)
        try {
          await telegramAuthHook(request, reply);
        } catch {
          await reply.status(403).send({ error: "Forbidden" });
          return;
        }
        if (reply.sent) return;
        aibUserId = (request as unknown as { userId: bigint }).userId;
      }

      const user = await db.user.findUnique({ where: { id: aibUserId }, select: { role: true } });
      if (!user || (user.role !== "ADMIN" && user.role !== "MODERATOR")) {
        await reply.status(403).send({ error: "Forbidden" });
      }
    });

    /** GET /admin/prompts — catalog of design+video models (settings) for the prompt editor */
    admin.get(
      "/admin/prompts",
      {
        schema: {
          description:
            "Admin: list design & video models with settings (for prompt example editor)",
          response: { 200: modelsResponseSchema },
        },
      },
      async () => listPromptModels(),
    );

    /** GET /admin/prompts/:id — single prompt example */
    admin.get<{ Params: { id: string } }>(
      "/admin/prompts/:id",
      {
        schema: {
          description: "Admin: get a prompt example by id",
          params: {
            type: "object",
            additionalProperties: true,
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          response: {
            200: itemSchema,
            404: {
              type: "object",
              additionalProperties: true,
              properties: { error: { type: "string" } },
            },
          },
        },
      },
      async (request, reply) => {
        const example = await promptExamplesService.findById(request.params.id);
        if (!example) {
          await reply.status(404).send({ error: "Prompt example not found" });
          return;
        }
        return await serialize(example, { includeS3Keys: true });
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
              section: { type: "string" },
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
        return await serialize(example, { includeS3Keys: true });
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
              section: { type: "string" },
            },
          },
          response: {
            200: itemSchema,
            404: {
              type: "object",
              additionalProperties: true,
              properties: { error: { type: "string" } },
            },
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
        return await serialize(updated, { includeS3Keys: true });
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
