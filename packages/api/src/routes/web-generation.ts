/**
 * /web/generation/* — запуск генераций с веб-приложения.
 *
 * Защищены `webTelegramLinkedPreHandler` — 401 без JWT, 403 TELEGRAM_NOT_LINKED
 * если юзер не привязал TG (генерации требуют токенов, привязанных к User.id).
 *
 * Под капотом переиспользуется *GenerationService.submit* (та же логика, что в
 * bot-flow); разница только в том что `telegramChatId === null` и настройки
 * приходят явным payload'ом через `extraModelSettings`, потому что на вебе
 * нет TG-style userStateService.
 */

import type { FastifyPluginAsync } from "fastify";
import { webTelegramLinkedPreHandler } from "../middlewares/web-auth.js";
import { generationService } from "../services/generation.service.js";
import { videoGenerationService } from "../services/video-generation.service.js";
import { audioGenerationService } from "../services/audio-generation.service.js";
import { costPreviewService } from "../services/cost-preview.service.js";
import { getFileUrl } from "../services/s3.service.js";
import { db } from "../db.js";
import { AI_MODELS, UserFacingError } from "@metabox/shared";
import { logger } from "../logger.js";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";

/** Резолвит s3Key'и из payload'а в presigned URL'ы. Дропающиеся ключи молча
 * скипаются — лучше отдать неполный слот провайдеру, чем 500. */
async function resolveMediaInputs(
  mediaInputs: Record<string, string[]> | undefined,
): Promise<Record<string, string[]> | undefined> {
  if (!mediaInputs) return undefined;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(mediaInputs).map(async ([slotKey, s3Keys]) => {
        const urls = (await Promise.all(s3Keys.map((k) => getFileUrl(k).catch(() => null)))).filter(
          (u): u is string => typeof u === "string" && u.length > 0,
        );
        return [slotKey, urls] as const;
      }),
    ),
  );
}

export const webGenerationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", webTelegramLinkedPreHandler);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["web-generation"]));

  // ── GET /web/generations?modelIds=a,b&limit=20 ─────────────────────────────
  // История генераций юзера (done + failed) с пресайнднутыми URL'ами outputs'ов.
  // Web-эквивалент `/gallery` без telegram-download-токенов: всё через прямые
  // S3 presigned URL'ы. Фильтр `modelIds` — CSV из members семейства (на фронте
  // ресолвим из `family.members` чтобы вкладки Standard/Pro/etc. шарили историю).
  fastify.get<{
    Querystring: { modelIds?: string; section?: string; limit?: string };
  }>(
    "/web/generations",
    {
      schema: {
        description: "List user's recent generations (done + failed) with presigned outputs",
        querystring: {
          type: "object",
          properties: {
            modelIds: {
              type: "string",
              description: "Comma-separated modelId filter (e.g. 'flux,flux-pro')",
            },
            section: { type: "string", description: "design | video | audio | gpt" },
            limit: { type: "string", description: "Page size, default 20, max 50" },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              items: { type: "array", items: { type: "object", additionalProperties: true } },
            },
          },
          500: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { aibUserId } = request.webUser!;
      const { modelIds, section, limit = "20" } = request.query;
      const take = Math.min(parseInt(limit, 10) || 20, 50);
      const modelIdsArr = modelIds ? modelIds.split(",").filter(Boolean) : null;

      try {
        const jobs = await db.generationJob.findMany({
          where: {
            userId: aibUserId!,
            // Включаем и done и failed — failed нужно показать с error-карточкой.
            // Pending/processing с web-стороны не тянем: они трекаются локально
            // по dbJobId сразу после submit'а (`pendingJobs` в GenerateScene).
            status: { in: ["done", "failed"] },
            ...(section ? { section } : {}),
            ...(modelIdsArr ? { modelId: { in: modelIdsArr } } : {}),
          },
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            section: true,
            modelId: true,
            prompt: true,
            status: true,
            error: true,
            errorCode: true,
            tokensSpent: true,
            createdAt: true,
            completedAt: true,
            outputs: {
              orderBy: { index: "asc" },
              select: { id: true, s3Key: true, outputUrl: true, thumbnailS3Key: true },
            },
          },
        });

        // Презайнднутые URL'ы — outputUrl уже может быть в БД (некоторые
        // провайдеры пишут публичный URL напрямую), иначе подписываем s3Key.
        const items = await Promise.all(
          jobs.map(async (job) => {
            const outputs = await Promise.all(
              job.outputs.map(async (o) => {
                const url =
                  o.outputUrl ?? (o.s3Key ? await getFileUrl(o.s3Key).catch(() => null) : null);
                const thumbnailUrl = o.thumbnailS3Key
                  ? await getFileUrl(o.thumbnailS3Key).catch(() => null)
                  : null;
                return { id: o.id, url, thumbnailUrl };
              }),
            );
            return {
              id: job.id,
              section: job.section,
              modelId: job.modelId,
              prompt: job.prompt,
              status: job.status,
              error: job.error,
              errorCode: job.errorCode,
              tokensSpent: job.tokensSpent ? job.tokensSpent.toString() : null,
              createdAt: job.createdAt.toISOString(),
              completedAt: job.completedAt ? job.completedAt.toISOString() : null,
              outputs,
            };
          }),
        );

        return { items };
      } catch (err) {
        logger.error({ err, userId: aibUserId?.toString() }, "web-generations list failed");
        return reply
          .code(500)
          .send({ code: "INTERNAL_ERROR", error: "Не удалось загрузить историю" });
      }
    },
  );

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

      const resolvedMediaInputs = await resolveMediaInputs(mediaInputs);

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

  // ── POST /web/generation/video ─────────────────────────────────────────────
  fastify.post<{
    Body: {
      modelId: string;
      modeId?: string;
      prompt: string;
      settings?: Record<string, unknown>;
      mediaInputs?: Record<string, string[]>;
    };
  }>(
    "/web/generation/video",
    {
      schema: {
        description: "Submit a new video generation from the web app",
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

      const resolvedMediaInputs = await resolveMediaInputs(mediaInputs);

      // Pre-flight адаптер-чек (Veo image→8s, HeyGen avatar+voice и т.п.).
      const validation = videoGenerationService.validateVideoRequest({
        modelId,
        prompt,
        modelSettings: settings,
        mediaInputs: resolvedMediaInputs,
        userId: aibUserId!,
      });
      if (validation) {
        return reply.code(400).send({
          code: "BAD_REQUEST",
          error: validation.key,
          details: validation.params ?? undefined,
        });
      }

      try {
        const { dbJobId } = await videoGenerationService.submitVideo({
          userId: aibUserId!,
          modelId,
          prompt,
          telegramChatId: null,
          ...(resolvedMediaInputs ? { mediaInputs: resolvedMediaInputs } : {}),
          ...(settings ? { extraModelSettings: settings } : {}),
        });
        return { dbJobId };
      } catch (err) {
        if (err instanceof UserFacingError) {
          return reply.code(400).send({ code: "USER_FACING", error: err.message });
        }
        if (err instanceof Error && /insufficient|balance/i.test(err.message)) {
          return reply
            .code(402)
            .send({ code: "INSUFFICIENT_BALANCE", error: "Недостаточно токенов" });
        }
        logger.error(
          { err, modelId, userId: aibUserId?.toString() },
          "web-generation/video failed",
        );
        return reply.code(500).send({ code: "INTERNAL_ERROR", error: "Что-то пошло не так" });
      }
    },
  );

  // ── POST /web/generation/preview ──────────────────────────────────────────
  // Динамический предпросмотр стоимости — UI зовёт после каждого изменения
  // настроек/слотов (с дебаунсом). Под капотом тот же `costPreviewService`,
  // что и при сабмите, поэтому цифра на кнопке гарантированно совпадает с
  // фактическим списанием. Для video дополнительно прогоняется
  // probeHeygenAudioDuration — поэтому s3Key'и нужно резолвить в URL'ы.
  fastify.post<{
    Body: {
      modelId: string;
      modeId?: string;
      prompt?: string;
      settings?: Record<string, unknown>;
      mediaInputs?: Record<string, string[]>;
    };
  }>(
    "/web/generation/preview",
    {
      schema: {
        description: "Estimate generation cost for the current inputs",
        body: {
          type: "object",
          required: ["modelId"],
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
            properties: {
              cost: { type: "number" },
              pricingMode: { type: "string" },
              durationSec: { type: "number" },
              numImages: { type: "number" },
            },
          },
          400: badRequestResponse,
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

      try {
        const section = model.section;
        if (section === "design") {
          const preview = await costPreviewService.previewImage({
            userId: aibUserId!,
            modelId,
            prompt: prompt ?? "",
            telegramChatId: null,
            ...(settings ? { extraModelSettings: settings } : {}),
          });
          return {
            cost: preview.cost,
            pricingMode: "total" as const,
            numImages: preview.numImages,
          };
        }
        if (section === "video") {
          // Для video нужны URL'ы аудио-слотов чтобы ffprobe мог измерить длину
          // (HeyGen биллится посекундно). Если слотов нет — pricingMode станет
          // "per_second" и UI покажет «≈ N ✦ / sec».
          const resolvedMediaInputs = await resolveMediaInputs(mediaInputs);
          const preview = await costPreviewService.previewVideo({
            userId: aibUserId!,
            modelId,
            prompt: prompt ?? "",
            telegramChatId: null,
            ...(resolvedMediaInputs ? { mediaInputs: resolvedMediaInputs } : {}),
            ...(settings ? { extraModelSettings: settings } : {}),
          });
          return {
            cost: preview.cost,
            pricingMode: preview.pricingMode,
            durationSec: preview.effectiveDuration,
          };
        }
        if (section === "audio") {
          const preview = await costPreviewService.previewAudio({
            userId: aibUserId!,
            modelId,
            prompt: prompt ?? "",
            telegramChatId: null,
            ...(settings ? { extraModelSettings: settings } : {}),
          });
          return { cost: preview.cost, pricingMode: "total" as const };
        }
        return reply.code(400).send({ code: "BAD_REQUEST", error: "Unsupported section" });
      } catch (err) {
        logger.warn(
          { err, modelId, userId: aibUserId?.toString() },
          "web-generation/preview failed",
        );
        return reply.code(500).send({ code: "INTERNAL_ERROR", error: "Preview failed" });
      }
    },
  );

  // ── POST /web/generation/audio ─────────────────────────────────────────────
  // audio пока не использует mediaInputs (voice-clone slots — отдельная история).
  fastify.post<{
    Body: {
      modelId: string;
      prompt: string;
      settings?: Record<string, unknown>;
    };
  }>(
    "/web/generation/audio",
    {
      schema: {
        description: "Submit a new audio generation from the web app",
        body: {
          type: "object",
          required: ["modelId", "prompt"],
          properties: {
            modelId: { type: "string" },
            prompt: { type: "string" },
            settings: { type: "object", additionalProperties: true },
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
      const { modelId, prompt, settings } = request.body;

      const model = AI_MODELS[modelId];
      if (!model) {
        return reply.code(400).send({ code: "BAD_REQUEST", error: "Unknown model" });
      }
      if (!prompt.trim() && !model.promptOptional) {
        return reply.code(400).send({ code: "BAD_REQUEST", error: "Prompt is required" });
      }

      try {
        const { dbJobId } = await audioGenerationService.submitAudio({
          userId: aibUserId!,
          modelId,
          prompt,
          telegramChatId: null,
          ...(settings ? { extraModelSettings: settings } : {}),
        });
        return { dbJobId };
      } catch (err) {
        if (err instanceof UserFacingError) {
          return reply.code(400).send({ code: "USER_FACING", error: err.message });
        }
        if (err instanceof Error && /insufficient|balance/i.test(err.message)) {
          return reply
            .code(402)
            .send({ code: "INSUFFICIENT_BALANCE", error: "Недостаточно токенов" });
        }
        logger.error(
          { err, modelId, userId: aibUserId?.toString() },
          "web-generation/audio failed",
        );
        return reply.code(500).send({ code: "INTERNAL_ERROR", error: "Что-то пошло не так" });
      }
    },
  );
};
