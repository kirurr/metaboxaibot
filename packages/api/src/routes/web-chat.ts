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
import { webTelegramLinkedPreHandler } from "../middlewares/web-auth.js";
import { dialogService } from "../services/dialog.service.js";
import {
  chatService,
  ContextOverflowError,
  DocumentNotSupportedError,
  DocumentExtractFailedError,
} from "../services/chat.service.js";
import { db } from "../db.js";
import { getFileUrl } from "../services/s3.service.js";
import { logger } from "../logger.js";
import {
  AI_MODELS,
  MODELS_BY_SECTION,
  MODEL_FAMILIES,
  type Section,
  type AIModel,
} from "@metabox/shared";
import { constructOpenAPIonRouteHook, badRequestResponse } from "../utils/openapi.js";

function serializeModelCompact(m: AIModel) {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    section: m.section,
    // См. routes/models.ts — claude-прокси (kie-claude / evolink-claude) нормализуем
    // под бренд anthropic для UI.
    provider:
      m.provider === "kie-claude" || m.provider === "evolink-claude" ? "anthropic" : m.provider,
    familyId: m.familyId ?? null,
    familyName: m.familyId ? (MODEL_FAMILIES[m.familyId]?.name ?? null) : null,
    familyDefaultModelId: m.familyId ? (MODEL_FAMILIES[m.familyId]?.defaultModelId ?? null) : null,
    versionLabel: m.versionLabel ?? null,
    variantLabel: m.variantLabel ?? null,
    supportsImages: m.supportsImages,
    supportsDocuments: m.supportsDocuments ?? false,
  };
}

export const webChatRoutes: FastifyPluginAsync = async (fastify) => {
  // Все роуты здесь требуют и авторизации, и привязанного Telegram.
  fastify.addHook("preHandler", webTelegramLinkedPreHandler);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["web-chat"]),
  );

  // ── GET /web/models ─────────────────────────────────────────────────────
  fastify.get<{ Querystring: { section?: string } }>(
    "/web/models",
    {
      schema: {
        description: "Get list of AI models, optionally filtered by section",
        querystring: {
          type: "object",
          properties: {
            section: { type: "string" },
          },
        },
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                description: { type: "string" },
                section: { type: "string" },
                provider: { type: "string" },
                familyId: { type: "string", nullable: true },
                familyName: { type: "string", nullable: true },
                familyDefaultModelId: { type: "string", nullable: true },
                versionLabel: { type: "string", nullable: true },
                variantLabel: { type: "string", nullable: true },
                supportsImages: { type: "boolean" },
                supportsDocuments: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { section } = request.query;
      const models = section
        ? (MODELS_BY_SECTION[section as Section] ?? [])
        : Object.values(AI_MODELS);
      return models.map(serializeModelCompact);
    },
  );

  // ── GET /web/balance ────────────────────────────────────────────────────
  fastify.get("/web/balance", {
    schema: {
      description: "Get user balance information",
      response: {
        200: {
          type: "object",
          properties: {
            tokenBalance: { type: "string" },
            subscriptionTokenBalance: { type: "string" },
            subscription: {
              type: "object",
              nullable: true,
              properties: {
                planName: { type: "string" },
                period: { type: "string" },
                endDate: { type: "string" },
                tokensGranted: { type: "number" },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
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
  fastify.get<{ Querystring: { section?: string } }>(
    "/web/dialogs",
    {
      schema: {
        description: "List user dialogs optionally filtered by section",
        querystring: {
          type: "object",
          properties: {
            section: { type: "string" },
          },
        },
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                section: { type: "string" },
                modelId: { type: "string" },
                title: { type: "string", nullable: true },
                createdAt: { type: "string" },
                updatedAt: { type: "string" },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { aibUserId } = request.webUser!;
      const dialogs = await dialogService.listByUser(
        aibUserId!,
        request.query.section as Section | undefined,
      );
      return dialogs.map((d) => ({
        id: d.id,
        section: d.section,
        modelId: d.modelId,
        title: d.title ?? null,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      }));
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
            properties: {
              id: { type: "string" },
              title: { type: "string" },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } }, description: "Title is required" },
          403: { type: "object", properties: { error: { type: "string" } }, description: "Forbidden" },
          404: { type: "object", properties: { error: { type: "string" } }, description: "Not found" },
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
            properties: {
              success: { type: "boolean" },
            },
          },
          403: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
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
              properties: {
                id: { type: "string" },
                role: { type: "string" },
                content: { type: "string" },
                mediaUrl: { type: "string", nullable: true },
                mediaType: { type: "string", nullable: true },
                createdAt: { type: "string" },
              },
            },
          },
          403: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
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
            createdAt: Date;
          }>
        ).map(async (m) => {
          let mediaUrl = m.mediaUrl ?? null;
          if (mediaUrl && !mediaUrl.startsWith("http")) {
            mediaUrl = (await getFileUrl(mediaUrl)) ?? mediaUrl;
          }
          return {
            id: m.id,
            role: m.role,
            content: m.content,
            mediaUrl,
            mediaType: m.mediaType ?? null,
            createdAt: m.createdAt.toISOString(),
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
  fastify.post<{ Params: { id: string }; Body: { content?: string } }>(
    "/web/dialogs/:id/send",
    {
      schema: {
        description: "Send message to dialog with SSE streaming response",
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
        body: {
          type: "object",
          properties: {
            content: { type: "string" },
          },
          required: ["content"],
        },
        response: {
          200: {
            type: "string",
            description: "SSE stream. event: chunk (data: { text }), event: done (data: { tokensUsed, balance }), event: error (data: { code, message })",
          },
          400: badRequestResponse,
          403: badRequestResponse,
          404: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { aibUserId } = request.webUser!;
      const { id } = request.params;
      const content = (request.body?.content ?? "").trim();
      if (!content) {
        return reply.code(400).send({ error: "Сообщение не может быть пустым" });
      }

      const dialog = await dialogService.findById(id);
      if (!dialog) return reply.code(404).send({ error: "Dialog not found" });
      if (dialog.userId !== aibUserId) return reply.code(403).send({ error: "Forbidden" });

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const send = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const stream = chatService.sendMessageStream({
          dialogId: id,
          userId: aibUserId!,
          content,
        });
        let result: Awaited<ReturnType<typeof stream.next>>;
        while (true) {
          result = await stream.next();
          if (result.done) break;
          send("chunk", { text: result.value });
        }

        const balance = await db.user.findUnique({
          where: { id: aibUserId! },
          select: {
            tokenBalance: true,
            subscriptionTokenBalance: true,
          },
        });

        send("done", {
          tokensUsed: result.value?.tokensUsed ?? 0,
          balance: {
            tokenBalance: balance?.tokenBalance.toString() ?? "0",
            subscriptionTokenBalance: balance?.subscriptionTokenBalance.toString() ?? "0",
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
    },
  );
};
