/**
 * /web/voices/* — каталог голосов для веб-клиента (TTS-модели).
 *
 * Зеркалит `/cartesia-voices` и `/elevenlabs-voices` (которые под `telegramAuthHook`)
 * под `webTelegramLinkedPreHandler`. Логика и кеш — параллельные; если в будущем
 * захочется дедуплицировать, выносим вторично в `voice-catalog.service.ts`.
 *
 * Шейп ответа:
 *   GET /web/voices/cartesia | elevenlabs | openai → VoiceItem[]
 *     { id, name, language?, gender?, hasPreview, previewUrl? }
 *
 *  - cartesia: previewUrl=null в листинге (Cartesia требует Bearer), фронт
 *    тянет audio через `GET /web/voices/cartesia/:id/preview` (бинарный stream).
 *  - elevenlabs: previewUrl — прямая CDN-ссылка, `<audio src>` работает напрямую.
 *  - openai: статика `/voice-samples/openai/{id}.wav` (раздаёт SPA-server).
 */

import type { FastifyPluginAsync } from "fastify";
import { webTelegramLinkedPreHandler } from "../middlewares/web-auth.js";
import { acquireKey } from "../services/key-pool.service.js";
import { PoolExhaustedError } from "../utils/pool-exhausted-error.js";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";

// ── Shared types ─────────────────────────────────────────────────────────────

type VoiceItem = {
  id: string;
  name: string;
  description: string | null;
  gender: string | null;
  language: string | null;
  hasPreview: boolean;
  previewUrl: string | null;
};

const CACHE_TTL_MS = 60 * 60 * 1000; // 1ч — official-каталог редко обновляется.

// ── Cartesia ─────────────────────────────────────────────────────────────────

interface CartesiaVoiceRaw {
  id: string;
  name: string;
  description?: string;
  is_owner?: boolean;
  is_public?: boolean;
  gender?: string | null;
  language?: string;
  preview_file_url?: string | null;
}
interface CartesiaVoicesResponse {
  data?: CartesiaVoiceRaw[];
  has_more?: boolean;
}

const CARTESIA_VERSION = "2026-03-01";
const CARTESIA_API = "https://api.cartesia.ai";
let cartesiaCache: { data: VoiceItem[]; at: number } | null = null;

async function getCartesiaApiKey(): Promise<string | null> {
  try {
    return (await acquireKey("cartesia")).apiKey;
  } catch (err) {
    if (err instanceof PoolExhaustedError) return null;
    throw err;
  }
}

// ── ElevenLabs ───────────────────────────────────────────────────────────────

interface ElevenLabsVoiceRaw {
  voice_id: string;
  name: string;
  category?: string;
  labels?: { gender?: string; language?: string; description?: string };
  preview_url?: string | null;
}
interface ElevenLabsVoicesResponse {
  voices?: ElevenLabsVoiceRaw[];
}
let elevenLabsCache: { data: VoiceItem[]; at: number } | null = null;

async function getElevenLabsApiKey(): Promise<string | null> {
  try {
    return (await acquireKey("elevenlabs")).apiKey;
  } catch (err) {
    if (err instanceof PoolExhaustedError) return null;
    throw err;
  }
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

// Захардкоженный каталог — у OpenAI TTS фиксированный набор голосов, API listing
// для них нет. Preview-аудио лежит в `public/voice-samples/openai/{id}.wav`.
const OPENAI_VOICES: VoiceItem[] = [
  {
    id: "alloy",
    name: "Alloy",
    description: "Neutral",
    gender: null,
    language: "en",
    hasPreview: true,
    previewUrl: "/voice-samples/openai/alloy.wav",
  },
  {
    id: "ash",
    name: "Ash",
    description: "Male",
    gender: "male",
    language: "en",
    hasPreview: true,
    previewUrl: "/voice-samples/openai/ash.wav",
  },
  {
    id: "coral",
    name: "Coral",
    description: "Female",
    gender: "female",
    language: "en",
    hasPreview: true,
    previewUrl: "/voice-samples/openai/coral.wav",
  },
  {
    id: "echo",
    name: "Echo",
    description: "Neutral",
    gender: null,
    language: "en",
    hasPreview: true,
    previewUrl: "/voice-samples/openai/echo.wav",
  },
  {
    id: "fable",
    name: "Fable",
    description: "British",
    gender: null,
    language: "en",
    hasPreview: true,
    previewUrl: "/voice-samples/openai/fable.wav",
  },
  {
    id: "nova",
    name: "Nova",
    description: "Female",
    gender: "female",
    language: "en",
    hasPreview: true,
    previewUrl: "/voice-samples/openai/nova.wav",
  },
  {
    id: "onyx",
    name: "Onyx",
    description: "Deep male",
    gender: "male",
    language: "en",
    hasPreview: true,
    previewUrl: "/voice-samples/openai/onyx.wav",
  },
  {
    id: "sage",
    name: "Sage",
    description: "Calm",
    gender: null,
    language: "en",
    hasPreview: true,
    previewUrl: "/voice-samples/openai/sage.wav",
  },
  {
    id: "shimmer",
    name: "Shimmer",
    description: "Female",
    gender: "female",
    language: "en",
    hasPreview: true,
    previewUrl: "/voice-samples/openai/shimmer.wav",
  },
];

// ── Route ────────────────────────────────────────────────────────────────────

export const webVoicesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", webTelegramLinkedPreHandler);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["web-voices"]));

  const voiceItemSchema = {
    type: "object",
    additionalProperties: true,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string", nullable: true },
      gender: { type: "string", nullable: true },
      language: { type: "string", nullable: true },
      hasPreview: { type: "boolean" },
      previewUrl: { type: "string", nullable: true },
    },
  };

  // ── GET /web/voices/cartesia ──────────────────────────────────────────────
  fastify.get(
    "/web/voices/cartesia",
    {
      schema: {
        description: "List public Cartesia TTS voices",
        response: {
          200: { type: "array", items: voiceItemSchema },
          503: badRequestResponse,
          502: badRequestResponse,
        },
      },
    },
    async (_request, reply) => {
      if (cartesiaCache && Date.now() - cartesiaCache.at < CACHE_TTL_MS) {
        return cartesiaCache.data;
      }
      const apiKey = await getCartesiaApiKey();
      if (!apiKey) return reply.status(503).send({ error: "Cartesia API key not configured" });

      const all: CartesiaVoiceRaw[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const url = new URL(`${CARTESIA_API}/voices`);
        url.searchParams.set("limit", "100");
        url.searchParams.set("is_owner", "false");
        url.searchParams.append("expand[]", "preview_file_url");
        if (cursor) url.searchParams.set("starting_after", cursor);

        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Cartesia-Version": CARTESIA_VERSION,
            Accept: "application/json",
          },
        });
        if (!res.ok) {
          const text = await res.text();
          return reply.status(502).send({ error: `Cartesia error: ${res.status} ${text}` });
        }
        const json = (await res.json()) as CartesiaVoicesResponse;
        const data = json.data ?? [];
        all.push(...data);
        if (!json.has_more || data.length === 0) break;
        cursor = data[data.length - 1].id;
      }

      const data: VoiceItem[] = all
        .filter((v) => v.is_public)
        .map((v) => ({
          id: v.id,
          name: v.name,
          description: v.description ?? null,
          gender: v.gender ?? null,
          language: v.language ?? null,
          hasPreview: !!v.preview_file_url,
          // Cartesia preview-URL короткоживущий и требует Bearer — отдадим через
          // отдельный stream-endpoint когда юзер нажмёт play.
          previewUrl: null,
        }));

      cartesiaCache = { data, at: Date.now() };
      return data;
    },
  );

  // ── GET /web/voices/cartesia/:id/preview — stream аудио ───────────────────
  fastify.get<{ Params: { id: string } }>(
    "/web/voices/cartesia/:id/preview",
    {
      schema: {
        description: "Stream Cartesia voice preview as binary audio",
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const apiKey = await getCartesiaApiKey();
      if (!apiKey) return reply.status(503).send({ error: "Cartesia API key not configured" });

      const metaUrl = new URL(`${CARTESIA_API}/voices/${encodeURIComponent(id)}`);
      metaUrl.searchParams.append("expand[]", "preview_file_url");
      const metaRes = await fetch(metaUrl, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Cartesia-Version": CARTESIA_VERSION,
          Accept: "application/json",
        },
      });
      if (!metaRes.ok) {
        const text = await metaRes.text();
        return reply.status(502).send({ error: `Cartesia error: ${metaRes.status} ${text}` });
      }
      const voice = (await metaRes.json()) as CartesiaVoiceRaw;
      const previewUrl = voice.preview_file_url ?? null;
      if (!previewUrl) return reply.status(404).send({ error: "No preview available" });

      const fileRes = await fetch(previewUrl, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Cartesia-Version": CARTESIA_VERSION,
        },
      });
      if (!fileRes.ok) {
        const text = await fileRes.text().catch(() => "");
        return reply
          .status(502)
          .send({ error: `Cartesia preview download failed: ${fileRes.status} ${text}` });
      }
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      const contentType = fileRes.headers.get("content-type") ?? "audio/mpeg";
      return reply.header("content-type", contentType).send(buffer);
    },
  );

  // ── GET /web/voices/elevenlabs ────────────────────────────────────────────
  fastify.get(
    "/web/voices/elevenlabs",
    {
      schema: {
        description: "List premade ElevenLabs voices",
        response: {
          200: { type: "array", items: voiceItemSchema },
          503: badRequestResponse,
          502: badRequestResponse,
        },
      },
    },
    async (_request, reply) => {
      if (elevenLabsCache && Date.now() - elevenLabsCache.at < CACHE_TTL_MS) {
        return elevenLabsCache.data;
      }
      const apiKey = await getElevenLabsApiKey();
      if (!apiKey) return reply.status(503).send({ error: "ElevenLabs API key not configured" });

      const res = await fetch("https://api.elevenlabs.io/v1/voices?show_legacy=false", {
        headers: { "xi-api-key": apiKey, Accept: "application/json" },
      });
      if (!res.ok) {
        const text = await res.text();
        return reply.status(502).send({ error: `ElevenLabs error: ${res.status} ${text}` });
      }
      const json = (await res.json()) as ElevenLabsVoicesResponse;
      const data: VoiceItem[] = (json.voices ?? [])
        .filter((v) => v.category === "premade")
        .map((v) => ({
          id: v.voice_id,
          name: v.name,
          description: v.labels?.description ?? null,
          gender: v.labels?.gender ?? null,
          language: v.labels?.language ?? null,
          hasPreview: !!v.preview_url,
          // ElevenLabs preview-URL — прямая CDN-ссылка, валидна долго, можем отдать.
          previewUrl: v.preview_url ?? null,
        }));

      elevenLabsCache = { data, at: Date.now() };
      return data;
    },
  );

  // ── GET /web/voices/openai ────────────────────────────────────────────────
  fastify.get(
    "/web/voices/openai",
    {
      schema: {
        description: "List OpenAI TTS voices (hardcoded — OpenAI not exposed via API)",
        response: { 200: { type: "array", items: voiceItemSchema } },
      },
    },
    async () => OPENAI_VOICES,
  );
};
