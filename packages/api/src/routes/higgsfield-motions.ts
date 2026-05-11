import type { FastifyPluginAsync } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { acquireKey } from "../services/key-pool.service.js";
import { PoolExhaustedError } from "../utils/pool-exhausted-error.js";

interface HiggsFieldMotion {
  id: string;
  name: string;
  description?: string;
  preview_url?: string | null;
  category?: string;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let motionsCache: { data: HiggsFieldMotion[]; at: number } | null = null;

export const higgsfieldMotionsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);

  /** GET /higgsfield-motions — proxy to Higgsfield /v1/motions with 1-hour cache */
  fastify.get("/higgsfield-motions", async (_request, reply) => {
    if (motionsCache && Date.now() - motionsCache.at < CACHE_TTL_MS) {
      return motionsCache.data;
    }

    // Higgsfield-аккаунт использует комбинированный credential `apiKey:apiSecret`.
    // В key-pool такой формат хранит только провайдер `higgsfield_soul` (env-fallback
    // соберёт пару из двух env-переменных), поэтому тянем его и подставляем как есть
    // в Authorization-заголовок.
    let combined: string;
    try {
      combined = (await acquireKey("higgsfield_soul")).apiKey;
    } catch (err) {
      if (err instanceof PoolExhaustedError) {
        return reply.status(503).send({ error: "Higgsfield API key not configured" });
      }
      throw err;
    }

    const res = await fetch("https://platform.higgsfield.ai/v1/motions", {
      headers: {
        Authorization: `Key ${combined}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return reply.status(502).send({ error: `Higgsfield error: ${res.status} ${text}` });
    }

    const data = (await res.json()) as HiggsFieldMotion[];
    motionsCache = { data, at: Date.now() };
    return data;
  });
};
