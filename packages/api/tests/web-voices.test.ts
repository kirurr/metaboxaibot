/**
 * Integration tests for packages/api/src/routes/web-voices.ts.
 *
 * Покрывает четыре эндпоинта:
 *   - GET /web/voices/cartesia          — listing + key-pool 503 + upstream 502 + cache
 *   - GET /web/voices/cartesia/:id/preview — binary audio stream
 *   - GET /web/voices/elevenlabs        — listing + filter category=premade + cache
 *   - GET /web/voices/openai            — статичный hardcoded каталог
 *
 * Авторизация — `webTelegramLinkedPreHandler`: 401 без Bearer, 403
 * `TELEGRAM_NOT_LINKED` для web-only юзеров (withTelegram: false).
 *
 * Module-level кеши `cartesiaCache`/`elevenLabsCache` в `web-voices.ts` живут
 * на всё время процесса — обходим порядком: cold-state (503/502) идут ДО
 * первого успешного 200, который заполнит кеш. Тест "cache hit" проверяет, что
 * последующий вызов возвращает данные даже когда MSW отдаёт ошибку.
 *
 * `key-pool.service.ts` имеет собственный 30-сек in-process кеш списка ключей —
 * сбрасываем `invalidatePoolCache()` в `beforeEach`, иначе seeded `ProviderKey`
 * не виден `acquireKey()` сразу после `truncateAll`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { http, HttpResponse } from "msw";
import { buildTestApp } from "./helpers/build-app.js";
import { bearer, createTestUser } from "./fixtures/users.js";
import { createTestProviderKey } from "./fixtures/provider-keys.js";
import { mswServer } from "./msw/server.js";
import { CARTESIA_PREVIEW_CDN_URL } from "./msw/handlers/voices.js";
import { invalidatePoolCache } from "../src/services/key-pool.service.js";

interface VoiceItem {
  id: string;
  name: string;
  description: string | null;
  gender: string | null;
  language: string | null;
  hasPreview: boolean;
  previewUrl: string | null;
}

describe("web-voices routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // afterEach в vitest.setup.ts чистит БД и Redis, но не in-process кеш
    // key-pool — без сброса seeded ProviderKey не виден acquireKey() 30 секунд.
    invalidatePoolCache();
  });

  // ── /web/voices/cartesia ───────────────────────────────────────────────────
  describe("GET /web/voices/cartesia", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/web/voices/cartesia" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Unauthorized" });
    });

    it("returns 403 TELEGRAM_NOT_LINKED for web-only user", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "GET",
        url: "/web/voices/cartesia",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "TELEGRAM_NOT_LINKED" });
    });

    it("returns 503 when no Cartesia key is in the pool", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/voices/cartesia",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("Cartesia") });
    });

    it("returns 502 when Cartesia API responds with an error", async () => {
      await createTestProviderKey("cartesia", "test-cartesia-key");
      const { accessToken } = await createTestUser();
      mswServer.use(
        http.get(
          "https://api.cartesia.ai/voices",
          () => new HttpResponse("upstream broken", { status: 500 }),
        ),
      );
      const res = await app.inject({
        method: "GET",
        url: "/web/voices/cartesia",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("Cartesia") });
    });

    it("returns 200 with mapped voices and filters out is_public:false", async () => {
      await createTestProviderKey("cartesia", "test-cartesia-key");
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/voices/cartesia",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as VoiceItem[];
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual({
        id: "voice-public-1",
        name: "Public Voice",
        description: "A friendly public voice",
        gender: "female",
        language: "en",
        hasPreview: true,
        // Cartesia preview-URL не отдаём в листинге — фронт тянет через stream-endpoint.
        previewUrl: null,
      });
    });

    it("returns cached data on a subsequent call even when DB key is gone", async () => {
      // Предыдущий тест уже наполнил cartesiaCache. afterEach дропнул ProviderKey,
      // но кеш на module level выживает — этот вызов обязан вернуть тот же payload.
      const { accessToken } = await createTestUser();
      mswServer.use(
        http.get("https://api.cartesia.ai/voices", () => {
          throw new Error("MSW: cartesia should not be called when cache is hot");
        }),
      );
      const res = await app.inject({
        method: "GET",
        url: "/web/voices/cartesia",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as VoiceItem[];
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("voice-public-1");
    });
  });

  // ── /web/voices/cartesia/:id/preview ───────────────────────────────────────
  describe("GET /web/voices/cartesia/:id/preview", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/web/voices/cartesia/some-id/preview",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 503 when no Cartesia key is in the pool", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/voices/cartesia/voice-public-1/preview",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("Cartesia") });
    });

    it("streams audio with correct status, content-type and binary body", async () => {
      await createTestProviderKey("cartesia", "test-cartesia-key");
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/voices/cartesia/voice-public-1/preview",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("audio/mpeg");
      expect(res.rawPayload).toBeInstanceOf(Buffer);
      expect(res.rawPayload.length).toBeGreaterThan(0);
    });
  });

  // ── /web/voices/elevenlabs ─────────────────────────────────────────────────
  describe("GET /web/voices/elevenlabs", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/web/voices/elevenlabs" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 503 when no ElevenLabs key is in the pool", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/voices/elevenlabs",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("ElevenLabs") });
    });

    it("returns 502 when ElevenLabs API responds with an error", async () => {
      await createTestProviderKey("elevenlabs", "test-elevenlabs-key");
      const { accessToken } = await createTestUser();
      mswServer.use(
        http.get(
          "https://api.elevenlabs.io/v1/voices",
          () => new HttpResponse("upstream broken", { status: 500 }),
        ),
      );
      const res = await app.inject({
        method: "GET",
        url: "/web/voices/elevenlabs",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("ElevenLabs") });
    });

    it("returns 200 with mapped voices and filters category=premade only", async () => {
      await createTestProviderKey("elevenlabs", "test-elevenlabs-key");
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/voices/elevenlabs",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as VoiceItem[];
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual({
        id: "el-premade-1",
        name: "Rachel",
        description: "calm",
        gender: "female",
        language: "en",
        hasPreview: true,
        // ElevenLabs preview-URL — прямой CDN-линк, отдаём как есть.
        previewUrl: "https://cdn.test/elevenlabs/rachel.mp3",
      });
    });

    it("returns cached data on a subsequent call even when DB key is gone", async () => {
      const { accessToken } = await createTestUser();
      mswServer.use(
        http.get("https://api.elevenlabs.io/v1/voices", () => {
          throw new Error("MSW: elevenlabs should not be called when cache is hot");
        }),
      );
      const res = await app.inject({
        method: "GET",
        url: "/web/voices/elevenlabs",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as VoiceItem[];
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("el-premade-1");
    });
  });

  // ── /web/voices/openai ─────────────────────────────────────────────────────
  describe("GET /web/voices/openai", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/web/voices/openai" });
      expect(res.statusCode).toBe(401);
    });

    it("returns the hardcoded 9-voice catalog", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/voices/openai",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as VoiceItem[];
      expect(body).toHaveLength(9);
      const ids = body.map((v) => v.id);
      expect(ids).toContain("alloy");
      expect(ids).toContain("nova");
      const alloy = body.find((v) => v.id === "alloy");
      expect(alloy).toMatchObject({
        name: "Alloy",
        hasPreview: true,
        previewUrl: "/voice-samples/openai/alloy.wav",
      });
    });
  });
});
