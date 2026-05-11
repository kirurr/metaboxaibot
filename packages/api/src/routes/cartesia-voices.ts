import type { FastifyPluginAsync } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { acquireKey } from "../services/key-pool.service.js";
import { PoolExhaustedError } from "../utils/pool-exhausted-error.js";

interface CartesiaVoiceRaw {
  id: string;
  name: string;
  description?: string;
  is_owner?: boolean;
  is_public?: boolean;
  gender?: string | null;
  language?: string;
  created_at?: string;
  preview_file_url?: string | null;
}

interface CartesiaVoicesResponse {
  data?: CartesiaVoiceRaw[];
  has_more?: boolean;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let voicesCache: { data: object[]; at: number } | null = null;

const CARTESIA_VERSION = "2026-03-01";
const CARTESIA_API = "https://api.cartesia.ai";

async function getCartesiaApiKey(): Promise<string | null> {
  try {
    return (await acquireKey("cartesia")).apiKey;
  } catch (err) {
    if (err instanceof PoolExhaustedError) return null;
    throw err;
  }
}

export const cartesiaVoicesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);

  /**
   * GET /cartesia-voices — список официальных (public) Cartesia voices.
   * is_owner=false → исключает наших клонированных голосов (они отдаются через
   * /user-voices). Кэш 1ч — official-каталог редко меняется.
   *
   * Note: preview-URL (`preview_file_url`) НЕ включаем в листинг и НЕ кэшируем —
   * Cartesia подписывает их короткоживущим токеном (TTL минут), а наш кэш на час
   * стабильно возвращал бы протухшие линки. Клиент получает только `has_preview`,
   * а сам URL запрашивается on-demand через `/cartesia-voices/:id/preview-url`.
   */
  fastify.get("/cartesia-voices", async (_request, reply) => {
    if (voicesCache && Date.now() - voicesCache.at < CACHE_TTL_MS) {
      return voicesCache.data;
    }

    const apiKey = await getCartesiaApiKey();
    if (!apiKey) {
      return reply.status(503).send({ error: "Cartesia API key not configured" });
    }

    const all: CartesiaVoiceRaw[] = [];
    let cursor: string | undefined;
    // Cap pages at 50 — официальных голосов не должно быть >5000.
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

    const data = all
      .filter((v) => v.is_public)
      .map((v) => ({
        voice_id: v.id,
        name: v.name,
        description: v.description ?? null,
        gender: v.gender ?? null,
        language: v.language ?? null,
        has_preview: !!v.preview_file_url,
      }));

    voicesCache = { data, at: Date.now() };
    return data;
  });

  /**
   * GET /cartesia-voices/:id/preview — стримит preview-аудио с Cartesia через
   * наш сервер. preview_file_url требует Bearer-заголовок (Cartesia 401 без
   * него), а browser'овский <audio> элемент авторизацию не передаёт. Поэтому
   * прокидываем байты сами: fetch /voices/:id с expand → получаем свежий
   * preview_file_url → fetch файла с Bearer → отдаём audio/mpeg клиенту.
   *
   * Webapp вызывает это через api.cartesiaVoices.previewBlob, который оборачивает
   * ответ в blob: URL для <audio>.
   */
  fastify.get<{ Params: { id: string } }>(
    "/cartesia-voices/:id/preview",
    async (request, reply) => {
      const { id } = request.params;
      const apiKey = await getCartesiaApiKey();
      if (!apiKey) {
        return reply.status(503).send({ error: "Cartesia API key not configured" });
      }

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
};
