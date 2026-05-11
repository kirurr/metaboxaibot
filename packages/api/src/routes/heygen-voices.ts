import type { FastifyPluginAsync } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { acquireKey } from "../services/key-pool.service.js";
import { PoolExhaustedError } from "../utils/pool-exhausted-error.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

interface HeyGenVoice {
  voice_id: string;
  name: string;
  language: string;
  gender: string;
  preview_audio: string | null;
}

interface HeyGenVoicesResponse {
  data?: {
    voices?: HeyGenVoice[];
  };
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let voicesCache: { data: object[]; at: number } | null = null;

export const heygenVoicesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["heygen-voices"]),
  );

  /** GET /heygen-voices — proxy to HeyGen v2/voices, returns simplified voice list */
  fastify.get(
    "/heygen-voices",
    {
      schema: {
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                voice_id: { type: "string", description: "Voice ID" },
                name: { type: "string", description: "Voice name" },
                language: { type: "string", description: "Primary language" },
                gender: { type: "string", description: "Gender" },
                preview_audio: { type: "string", nullable: true, description: "Preview audio URL" },
              },
              required: ["voice_id", "name", "language", "gender", "preview_audio"],
            },
          },
          502: {
            description: "HeyGen API error",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
          503: {
            description: "HeyGen API key not configured",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      if (voicesCache && Date.now() - voicesCache.at < CACHE_TTL_MS) {
        return voicesCache.data;
      }

      let apiKey: string;
      try {
        apiKey = (await acquireKey("heygen")).apiKey;
      } catch (err) {
        if (err instanceof PoolExhaustedError) {
          return reply.status(503).send({ error: "HeyGen API key not configured" });
        }
        throw err;
      }

      const res = await fetch("https://api.heygen.com/v2/voices", {
        headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      });

      if (!res.ok) {
        const text = await res.text();
        return reply.status(502).send({ error: `HeyGen error: ${res.status} ${text}` });
      }

      const json = (await res.json()) as HeyGenVoicesResponse;
      const voices = json.data?.voices ?? [];

      const data = voices.map((v) => ({
        voice_id: v.voice_id,
        name: v.name,
        language: v.language ?? "",
        gender: v.gender ?? "",
        preview_audio: v.preview_audio ?? null,
      }));

      voicesCache = { data, at: Date.now() };
      return data;
    },
  );
};
