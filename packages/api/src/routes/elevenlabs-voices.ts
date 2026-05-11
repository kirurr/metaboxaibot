import type { FastifyPluginAsync } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { acquireKey } from "../services/key-pool.service.js";
import { PoolExhaustedError } from "../utils/pool-exhausted-error.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

interface ElevenLabsVoiceRaw {
  voice_id: string;
  name: string;
  category?: string;
  labels?: { gender?: string; language?: string };
  preview_url?: string | null;
}

interface ElevenLabsVoicesResponse {
  voices?: ElevenLabsVoiceRaw[];
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let voicesCache: { data: object[]; at: number } | null = null;

export const elevenlabsVoicesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["elevenlabs-voices"]),
  );

  /** GET /elevenlabs-voices — proxy to ElevenLabs /v1/voices, returns premade voices */
  fastify.get(
    "/elevenlabs-voices",
    {
      schema: {
        response: {
          200: {
            type: "array",
            description: "List of premade ElevenLabs voices",
            items: {
              type: "object",
              properties: {
                voice_id: { type: "string", description: "Unique voice identifier" },
                name: { type: "string", description: "Voice display name" },
                category: { type: "string", description: "Voice category (premade)" },
                gender: { type: "string", nullable: true, description: "Gender (male/female/null)" },
                language: { type: "string", nullable: true, description: "Primary language code" },
                preview_url: { type: "string", nullable: true, description: "Preview audio URL" },
              },
              required: ["voice_id", "name", "category", "gender", "language", "preview_url"],
            },
          },
          502: {
            description: "ElevenLabs API error",
            type: "object",
            properties: {
              error: { type: "string", description: "Error message from ElevenLabs API" },
            },
          },
          503: {
            description: "ElevenLabs API key not configured",
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
      apiKey = (await acquireKey("elevenlabs")).apiKey;
    } catch (err) {
      if (err instanceof PoolExhaustedError) {
        return reply.status(503).send({ error: "ElevenLabs API key not configured" });
      }
      throw err;
    }

    const res = await fetch("https://api.elevenlabs.io/v1/voices?show_legacy=false", {
      headers: { "xi-api-key": apiKey, Accept: "application/json" },
    });

    if (!res.ok) {
      const text = await res.text();
      return reply.status(502).send({ error: `ElevenLabs error: ${res.status} ${text}` });
    }

    const json = (await res.json()) as ElevenLabsVoicesResponse;
    const voices = (json.voices ?? []).filter((v) => v.category === "premade");

    const data = voices.map((v) => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category ?? "premade",
      gender: v.labels?.gender ?? null,
      language: v.labels?.language ?? null,
      preview_url: v.preview_url ?? null,
    }));

    voicesCache = { data, at: Date.now() };
    return data;
  });
};
