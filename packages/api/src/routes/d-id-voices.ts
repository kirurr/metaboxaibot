import type { FastifyPluginAsync } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { acquireKey } from "../services/key-pool.service.js";
import { PoolExhaustedError } from "../utils/pool-exhausted-error.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

interface DIDLanguageConfig {
  modelId?: string;
  availableModels?: string[];
}

interface DIDLanguage {
  language: string;
  locale: string;
  accent: string;
  config?: DIDLanguageConfig;
  previewUrl?: string;
}

interface DIDVoice {
  id: string;
  name: string;
  access: "public" | "premium" | "private" | "external-private";
  gender: string;
  languages: DIDLanguage[];
  provider: string;
  styles?: string[];
  description?: string;
  isLegacy: boolean;
}

type DIDVoicesResponse = DIDVoice[];

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let voicesCache: { data: object[]; at: number } | null = null;

const SAFE_MODELS = ["eleven_multilingual_v2", "eleven_turbo_v2"];

const filterSafeLanguages = (voice: DIDVoice) => {
  if (voice.provider === "microsoft") return voice.languages;

  return voice.languages.filter(
    (l) =>
      SAFE_MODELS.includes(l.config?.modelId ?? "") ||
      l.config?.availableModels?.some((m) => SAFE_MODELS.includes(m)),
  );
};

export const didVoicesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["d-id-voices"]),
  );

  /** GET /d-id-voices — proxy to D-ID /tts/voices, returns simplified voice list */
  fastify.get(
    "/d-id-voices",
    {
      schema: {
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Voice ID" },
                name: { type: "string", description: "Voice name" },
                gender: { type: "string", description: "Gender" },
                languages: {
                  type: "array",
                  description: "Available languages",
                  items: {
                    type: "object",
                    properties: {
                      language: { type: "string" },
                      locale: { type: "string" },
                      accent: { type: "string" },
                    },
                  },
                },
                provider: { type: "string", description: "Voice provider" },
                styles: { type: "array", items: { type: "string" }, description: "Voice styles" },
                description: { type: "string", description: "Voice description" },
              },
              required: ["id", "name", "gender", "languages", "provider", "styles", "description"],
            },
          },
          502: {
            description: "D-ID API error",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
          503: {
            description: "D-ID API key not configured",
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
      apiKey = (await acquireKey("did")).apiKey;
    } catch (err) {
      if (err instanceof PoolExhaustedError) {
        return reply.status(503).send({ error: "D-ID API key not configured" });
      }
      throw err;
    }

    const encoded = Buffer.from(`${apiKey}:`).toString("base64");
    const res = await fetch("https://api.d-id.com/tts/voices", {
      headers: { Authorization: `Basic ${encoded}`, Accept: "application/json" },
    });

    if (!res.ok) {
      const text = await res.text();
      return reply.status(502).send({ error: `D-ID error: ${res.status} ${text}` });
    }

    const json = (await res.json()) as DIDVoicesResponse;
    const voices = json ?? [];

    const data = voices.reduce(
      (acc, v) => {
        if (v.access === "public") {
          const languages = filterSafeLanguages(v);
          if (!languages) {
            return acc;
          }
          acc.push({
            id: v.id,
            name: v.name,
            gender: v.gender ?? "",
            languages: languages,
            provider: v.provider ?? "microsoft",
            styles: v.styles ?? [],
            description: v.description ?? "",
          });
        }
        return acc;
      },
      [] as Omit<DIDVoice, "isLegacy" | "access">[],
    );

    voicesCache = { data, at: Date.now() };
    return data;
  });
};
