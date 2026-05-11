import type { FastifyPluginAsync } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { acquireKey } from "../services/key-pool.service.js";
import { PoolExhaustedError } from "../utils/pool-exhausted-error.js";
import { logger } from "../logger.js";
import { constructOpenAPIonRouteHook, badRequestResponse } from "../utils/openapi.js";

interface SoulStyle {
  id: string;
  name: string;
  description?: string | null;
  preview_url: string;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let stylesCache: { data: SoulStyle[]; at: number } | null = null;

export const soulStylesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["soul-styles"]),
  );

  /** GET /soul-styles — proxy to Higgsfield Cloud /v1/text2image/soul-styles with 1-hour cache */
  fastify.get("/soul-styles", {
    schema: {
      description: "Get Higgsfield Soul styles (cached for 1 hour)",
      response: {
        200: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Style ID" },
              name: { type: "string", description: "Style name" },
              description: { type: "string", nullable: true, description: "Style description" },
              preview_url: { type: "string", description: "Preview image URL" },
            },
          },
        },
        502: badRequestResponse,
        503: badRequestResponse,
      },
    },
  }, async (_request, reply) => {
    if (stylesCache && Date.now() - stylesCache.at < CACHE_TTL_MS) {
      return stylesCache.data;
    }

    // Higgsfield Soul использует комбинированный credential `apiKey:apiSecret`
    // (формат провайдера `higgsfield_soul` в key-pool, env-fallback соберёт пару
    // из двух env-переменных).
    let combined: string;
    try {
      combined = (await acquireKey("higgsfield_soul")).apiKey;
    } catch (err) {
      if (err instanceof PoolExhaustedError) {
        return reply.status(503).send({ error: "Higgsfield API key not configured" });
      }
      throw err;
    }

    const res = await fetch("https://platform.higgsfield.ai/v1/text2image/soul-styles", {
      headers: {
        Authorization: `Key ${combined}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      logger.warn({ status: res.status, body: text }, "Higgsfield soul-styles fetch failed");
      return reply.status(502).send({ error: `Higgsfield error: ${res.status} ${text}` });
    }

    const data = (await res.json()) as SoulStyle[];
    logger.info({ count: data.length }, "Higgsfield soul-styles fetched");
    stylesCache = { data, at: Date.now() };
    return data;
  });
};
