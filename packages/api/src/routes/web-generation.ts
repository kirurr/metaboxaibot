/**
 * /web/generation/* — запуск генераций с веб-приложения.
 *
 * Защищены `webTelegramLinkedPreHandler` — 401 без JWT, 403 TELEGRAM_NOT_LINKED
 * если юзер не привязал TG (генерации требуют токенов, привязанных к User.id).
 *
 * Под капотом переиспользуется `generationService.submitImage` (та же логика,
 * что в bot-flow); разница только в том что `telegramChatId === null` и
 * настройки приходят явным payload'ом через `extraModelSettings`, потому что
 * на вебе нет TG-style userStateService.
 */

import type { FastifyPluginAsync } from "fastify";
import { webTelegramLinkedPreHandler } from "../middlewares/web-auth.js";
import { generationService } from "../services/generation.service.js";
import { getFileUrl } from "../services/s3.service.js";
import { AI_MODELS } from "@metabox/shared";
import { logger } from "../logger.js";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";

export const webGenerationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", webTelegramLinkedPreHandler);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["web-generation"]));

  // ── POST /web/generation/image ─────────────────────────────────────────────
  fastify.post<{
    Body: {
      modelId: string;
      modeId?: string;
      prompt: string;
      // Значения произвольные — modelSettings хранится как JSON и поддерживает
      // структурированные значения (например motion-picker — массив `{id,strength}`).
      settings?: Record<string, unknown>;
      mediaInputs?: Record<string, string[]>;
    };
  }>(
    "/web/generation/image",
    {
      schema: {
        description: "Submit a new image generation from the web app",
        body: {
          type: "object",
          required: ["modelId", "prompt"],
          properties: {
            modelId: { type: "string" },
            modeId: { type: "string" },
            prompt: { type: "string" },
            settings: { type: "object", additionalProperties: true },
            mediaInputs: {
              type: "object",
              additionalProperties: { type: "array", items: { type: "string" } },
            },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { dbJobId: { type: "string" } },
          },
          400: badRequestResponse,
          402: badRequestResponse,
          500: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { aibUserId } = request.webUser!;
      const { modelId, prompt, settings, mediaInputs } = request.body;

      const model = AI_MODELS[modelId];
      if (!model) {
        return reply.code(400).send({ code: "BAD_REQUEST", error: "Unknown model" });
      }
      if (!prompt.trim() && !model.promptOptional) {
        return reply.code(400).send({ code: "BAD_REQUEST", error: "Prompt is required" });
      }

      // s3Key → presigned URL. Падающие резолвы пропускаем — лучше отдать
      // неполный слот провайдеру (он сам решит), чем уронить запрос 500'кой.
      const resolvedMediaInputs: Record<string, string[]> | undefined = mediaInputs
        ? Object.fromEntries(
            await Promise.all(
              Object.entries(mediaInputs).map(async ([slotKey, s3Keys]) => {
                const urls = (
                  await Promise.all(s3Keys.map((k) => getFileUrl(k).catch(() => null)))
                ).filter((u): u is string => typeof u === "string" && u.length > 0);
                return [slotKey, urls] as const;
              }),
            ),
          )
        : undefined;

      try {
        const { dbJobId } = await generationService.submitImage({
          userId: aibUserId!,
          modelId,
          prompt,
          telegramChatId: null,
          ...(resolvedMediaInputs ? { mediaInputs: resolvedMediaInputs } : {}),
          ...(settings ? { extraModelSettings: settings } : {}),
        });
        return { dbJobId };
      } catch (err) {
        if (err instanceof Error && /insufficient|balance/i.test(err.message)) {
          return reply
            .code(402)
            .send({ code: "INSUFFICIENT_BALANCE", error: "Недостаточно токенов" });
        }
        logger.error(
          { err, modelId, userId: aibUserId?.toString() },
          "web-generation/image failed",
        );
        return reply.code(500).send({ code: "INTERNAL_ERROR", error: "Что-то пошло не так" });
      }
    },
  );
};
