import type { FastifyPluginAsync } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { acquireKey } from "../services/key-pool.service.js";
import { PoolExhaustedError } from "../utils/pool-exhausted-error.js";

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

  /** GET /elevenlabs-voices — proxy to ElevenLabs /v1/voices, returns premade voices */
  fastify.get("/elevenlabs-voices", async (_request, reply) => {
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
