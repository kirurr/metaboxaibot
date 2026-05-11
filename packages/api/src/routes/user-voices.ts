import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { db } from "../db.js";
import { getFileUrl } from "../services/s3.service.js";
import { acquireById } from "../services/key-pool.service.js";
import { ElevenLabsAdapter } from "../ai/audio/elevenlabs.adapter.js";
import { userStateService } from "../services/user-state.service.js";
import { getRedis } from "../redis.js";
import {
  config,
  getT,
  voiceCloneReturnRedisKey,
  VOICE_CLONE_RETURN_TTL_SECONDS,
} from "@metabox/shared";
import type { Language } from "@metabox/shared";
import { logger } from "../logger.js";
import { constructOpenAPIonRouteHook, badRequestResponse } from "../utils/openapi.js";

type AuthRequest = FastifyRequest & { userId: bigint };

export const userVoicesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["user-voices"]),
  );

  /** GET /user-voices?provider=elevenlabs — list user voices */
  fastify.get<{ Querystring: { provider?: string } }>(
    "/user-voices",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            provider: { type: "string", description: "Filter by provider (e.g., elevenlabs)" },
          },
        },
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Voice ID" },
                provider: { type: "string", description: "Provider name" },
                name: { type: "string", description: "Voice name" },
                externalId: { type: "string", description: "External provider ID" },
                previewUrl: { type: "string", nullable: true, description: "Preview URL" },
                hasAudio: { type: "boolean", description: "Whether voice has audio" },
                status: { type: "string", description: "Voice status" },
                createdAt: { type: "string", description: "Creation timestamp" },
              },
              required: ["id", "provider", "name", "externalId", "previewUrl", "hasAudio", "status", "createdAt"],
            },
          },
        },
      },
    },
    async (request) => {
    const { userId } = request as AuthRequest;
    const { provider } = request.query;
    const voices = await db.userVoice.findMany({
      where: { userId, ...(provider ? { provider } : {}) },
      orderBy: { createdAt: "desc" },
    });
    return voices.map((v) => ({
      id: v.id,
      provider: v.provider,
      name: v.name,
      externalId: v.externalId,
      previewUrl: v.previewUrl,
      hasAudio: v.previewUrl !== null || v.audioS3Key !== null,
      status: v.status,
      createdAt: v.createdAt.toISOString(),
    }));
  });

  /**
   * POST /user-voices/start-creation
   * Activates the `voice-clone` audio model and sends the cloning prompt to Telegram.
   * Optional `returnTo` flag stores a Redis marker to return to HeyGen after clone succeeds.
   */
  fastify.post<{ Body?: { returnTo?: string } }>(
    "/user-voices/start-creation",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            returnTo: { type: "string", enum: ["heygen"], description: "Return to HeyGen after clone" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { userId } = request as AuthRequest;
      const returnTo = request.body?.returnTo;

      if (returnTo !== undefined && returnTo !== "heygen") {
        return reply.status(400).send({ error: `Unsupported returnTo: ${returnTo}` });
      }

      await userStateService.setModelForSection(userId, "audio", "voice-clone");
      await userStateService.setState(userId, "AUDIO_ACTIVE", "audio");

      if (returnTo === "heygen") {
        await getRedis().set(
          voiceCloneReturnRedisKey(userId),
          returnTo,
          "EX",
          VOICE_CLONE_RETURN_TTL_SECONDS,
        );
      } else {
        // Stale marker from a previous flow would silently re-activate HeyGen
        // after an unrelated clone — drop it on every plain start.
        await getRedis().del(voiceCloneReturnRedisKey(userId));
      }

      const user = await db.user.findUnique({
        where: { id: userId },
        select: { language: true },
      });
      const t = getT((user?.language ?? "en") as Language);

      if (config.bot.token) {
        // parse_mode HTML — у voiceClone есть <blockquote>/<b> теги с советами
        // Cartesia. Без него юзер видит сырую разметку.
        await fetch(`https://api.telegram.org/bot${config.bot.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: String(userId),
            text: `${t.audio.voiceClone}\n\n${t.audio.voiceCloneActivated}`,
            parse_mode: "HTML",
          }),
        }).catch((err) => logger.warn(err, "voice clone start: failed to send prompt"));
      }

      return { ok: true };
    },
  );

  /**
   * GET /user-voices/:id/preview-url — resolve a playable URL on demand.
   * Prefers ElevenLabs-hosted preview; otherwise mints a fresh presigned URL for S3.
   */
  fastify.get<{ Params: { id: string } }>(
    "/user-voices/:id/preview-url",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", description: "Voice ID" },
          },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              url: { type: "string", description: "Playable audio URL" },
            },
            required: ["url"],
          },
          404: {
            description: "Voice not found or no preview available",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { userId } = request as AuthRequest;
      const { id } = request.params;
      const voice = await db.userVoice.findFirst({
        where: { id, userId },
        select: { previewUrl: true, audioS3Key: true },
      });
      if (!voice) return reply.status(404).send({ error: "Voice not found" });
      if (voice.previewUrl) return { url: voice.previewUrl };
      if (voice.audioS3Key) {
        const url = await getFileUrl(voice.audioS3Key).catch(() => null);
        if (url) return { url };
      }
      return reply.status(404).send({ error: "No preview available" });
    },
  );

  /** PATCH /user-voices/:id — rename */
  fastify.patch<{ Params: { id: string }; Body: { name: string } }>(
    "/user-voices/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", description: "Voice ID" },
          },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string", description: "New voice name" },
          },
          required: ["name"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string" },
              provider: { type: "string" },
              name: { type: "string" },
              externalId: { type: "string" },
              previewUrl: { type: "string", nullable: true },
              hasAudio: { type: "boolean" },
              status: { type: "string" },
              createdAt: { type: "string" },
            },
            required: ["id", "provider", "name", "externalId", "previewUrl", "hasAudio", "status", "createdAt"],
          },
          400: badRequestResponse,
          404: {
            description: "Voice not found",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { userId } = request as AuthRequest;
      const { id } = request.params;
      const { name } = request.body;
      if (!name?.trim()) return reply.status(400).send({ error: "name is required" });

      const voice = await db.userVoice.findFirst({ where: { id, userId } });
      if (!voice) return reply.status(404).send({ error: "Voice not found" });

      const updated = await db.userVoice.update({
        where: { id },
        data: { name: name.trim() },
      });
      return {
        id: updated.id,
        provider: updated.provider,
        name: updated.name,
        externalId: updated.externalId,
        previewUrl: updated.previewUrl,
        hasAudio: updated.previewUrl !== null || updated.audioS3Key !== null,
        status: updated.status,
        createdAt: updated.createdAt.toISOString(),
      };
    },
  );

  /** DELETE /user-voices/:id — delete from DB and from ElevenLabs */
  fastify.delete<{ Params: { id: string } }>(
    "/user-voices/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", description: "Voice ID" },
          },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
            },
            required: ["success"],
          },
          404: {
            description: "Voice not found",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
    const { userId } = request as AuthRequest;
    const { id } = request.params;

    const voice = await db.userVoice.findFirst({ where: { id, userId } });
    if (!voice) return reply.status(404).send({ error: "Voice not found" });

    // Delete from ElevenLabs on the SAME key the voice was created on — voice_id
    // живёт per-account, env-ключ может его не видеть. Если ключ уже удалён из
    // пула — acquireById fallback'ается на env (best-effort). Failure не блокирует
    // удаление из БД.
    if (voice.externalId) {
      try {
        const acquired = await acquireById(voice.providerKeyId, "elevenlabs");
        await ElevenLabsAdapter.deleteVoice(voice.externalId, acquired.apiKey);
      } catch (err) {
        logger.warn(
          { voiceId: voice.id, externalId: voice.externalId, err },
          "user-voices DELETE: ElevenLabs cleanup failed (continuing with DB delete)",
        );
      }
    }

    await db.userVoice.delete({ where: { id } });
    return { success: true };
  });
};
