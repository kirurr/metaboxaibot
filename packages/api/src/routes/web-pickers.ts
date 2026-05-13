/**
 * /web/pickers/* — каталоги для генерационных пикеров (HeyGen avatars,
 * HiggsField motions, HiggsField Soul styles).
 *
 * Зеркалит существующие маршруты `/heygen-avatars`, `/higgsfield-motions`,
 * `/soul-styles` (которые под `telegramAuthHook`) под `webTelegramLinkedPreHandler`.
 * Логика и кеш — параллельные, чтобы не трогать мини-аппу.
 */

import type { FastifyPluginAsync } from "fastify";
import { webTelegramLinkedPreHandler } from "../middlewares/web-auth.js";
import { acquireKey } from "../services/key-pool.service.js";
import { PoolExhaustedError } from "../utils/pool-exhausted-error.js";
import { logger } from "../logger.js";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";

// ── Shared ──────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 60 * 1000; // 1ч

// ── HeyGen avatars ──────────────────────────────────────────────────────────

interface HeyGenLookItem {
  id: string;
  name: string;
  gender?: string | null;
  preview_image_url?: string | null;
}
interface HeyGenLooksPage {
  data?: HeyGenLookItem[];
  has_more?: boolean;
  next_token?: string | null;
}
type AvatarItem = {
  id: string;
  name: string;
  gender: string | null;
  previewUrl: string | null;
};

// Аватаров много (~1000+), но для web MVP грузим первую страницу без фильтров.
// Pagination/search можно добавить когда понадобится — пока скролл-лист достаточно.
let avatarsCache: { data: AvatarItem[]; at: number } | null = null;

async function getHeyGenApiKey(): Promise<string | null> {
  try {
    return (await acquireKey("heygen")).apiKey;
  } catch (err) {
    if (err instanceof PoolExhaustedError) return null;
    throw err;
  }
}

// ── HiggsField motions ──────────────────────────────────────────────────────

interface HiggsFieldMotionRaw {
  id: string;
  name: string;
  description?: string;
  preview_url?: string | null;
  category?: string;
}
type MotionItem = {
  id: string;
  name: string;
  description: string | null;
  previewUrl: string | null;
  category: string | null;
};

let motionsCache: { data: MotionItem[]; at: number } | null = null;

async function getHiggsFieldApiKey(): Promise<string | null> {
  // Higgsfield key = "apiKey:apiSecret" combined; провайдер в pool — higgsfield_soul.
  try {
    return (await acquireKey("higgsfield_soul")).apiKey;
  } catch (err) {
    if (err instanceof PoolExhaustedError) return null;
    throw err;
  }
}

// ── HiggsField Soul styles ──────────────────────────────────────────────────

interface SoulStyleRaw {
  id: string;
  name: string;
  description?: string | null;
  preview_url: string;
}
type SoulStyleItem = {
  id: string;
  name: string;
  description: string | null;
  previewUrl: string;
};

let stylesCache: { data: SoulStyleItem[]; at: number } | null = null;

// ── Routes ──────────────────────────────────────────────────────────────────

export const webPickersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", webTelegramLinkedPreHandler);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["web-pickers"]));

  const itemSchema = {
    type: "object",
    additionalProperties: true,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string", nullable: true },
      previewUrl: { type: "string", nullable: true },
    },
  };

  // ── GET /web/avatars/heygen ───────────────────────────────────────────────
  fastify.get(
    "/web/avatars/heygen",
    {
      schema: {
        description: "List HeyGen public avatars (first page, cached for 1h)",
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                gender: { type: "string", nullable: true },
                previewUrl: { type: "string", nullable: true },
              },
            },
          },
          502: badRequestResponse,
          503: badRequestResponse,
        },
      },
    },
    async (_request, reply) => {
      if (avatarsCache && Date.now() - avatarsCache.at < CACHE_TTL_MS) return avatarsCache.data;

      const apiKey = await getHeyGenApiKey();
      if (!apiKey) return reply.status(503).send({ error: "HeyGen API key not configured" });

      const url = new URL("https://api.heygen.com/v3/avatars/looks");
      url.searchParams.set("ownership", "public");
      url.searchParams.set("limit", "100");

      const res = await fetch(url, {
        headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      });
      if (!res.ok) {
        const text = await res.text();
        return reply.status(502).send({ error: `HeyGen error: ${res.status} ${text}` });
      }
      const page = (await res.json()) as HeyGenLooksPage;
      const data: AvatarItem[] = (page.data ?? []).map((l) => ({
        id: l.id,
        name: l.name,
        gender: l.gender ?? null,
        previewUrl: l.preview_image_url ?? null,
      }));
      avatarsCache = { data, at: Date.now() };
      return data;
    },
  );

  // ── GET /web/motions ──────────────────────────────────────────────────────
  fastify.get(
    "/web/motions",
    {
      schema: {
        description: "List HiggsField motion presets (cached for 1h)",
        response: {
          200: { type: "array", items: itemSchema },
          502: badRequestResponse,
          503: badRequestResponse,
        },
      },
    },
    async (_request, reply) => {
      if (motionsCache && Date.now() - motionsCache.at < CACHE_TTL_MS) return motionsCache.data;

      const apiKey = await getHiggsFieldApiKey();
      if (!apiKey) return reply.status(503).send({ error: "HiggsField API key not configured" });

      const res = await fetch("https://platform.higgsfield.ai/v1/motions", {
        headers: { Authorization: `Key ${apiKey}`, Accept: "application/json" },
      });
      if (!res.ok) {
        const text = await res.text();
        return reply.status(502).send({ error: `HiggsField error: ${res.status} ${text}` });
      }
      const raw = (await res.json()) as HiggsFieldMotionRaw[];
      const data: MotionItem[] = raw.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description ?? null,
        previewUrl: m.preview_url ?? null,
        category: m.category ?? null,
      }));
      motionsCache = { data, at: Date.now() };
      return data;
    },
  );

  // ── GET /web/soul-styles ──────────────────────────────────────────────────
  fastify.get(
    "/web/soul-styles",
    {
      schema: {
        description: "List HiggsField Soul style presets (cached for 1h)",
        response: {
          200: { type: "array", items: itemSchema },
          502: badRequestResponse,
          503: badRequestResponse,
        },
      },
    },
    async (_request, reply) => {
      if (stylesCache && Date.now() - stylesCache.at < CACHE_TTL_MS) return stylesCache.data;

      const apiKey = await getHiggsFieldApiKey();
      if (!apiKey) return reply.status(503).send({ error: "HiggsField API key not configured" });

      const res = await fetch("https://platform.higgsfield.ai/v1/text2image/soul-styles", {
        headers: { Authorization: `Key ${apiKey}`, Accept: "application/json" },
      });
      if (!res.ok) {
        const text = await res.text();
        logger.warn({ status: res.status, body: text }, "web/soul-styles fetch failed");
        return reply.status(502).send({ error: `HiggsField error: ${res.status} ${text}` });
      }
      const raw = (await res.json()) as SoulStyleRaw[];
      const data: SoulStyleItem[] = raw.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description ?? null,
        previewUrl: s.preview_url,
      }));
      stylesCache = { data, at: Date.now() };
      return data;
    },
  );
};
