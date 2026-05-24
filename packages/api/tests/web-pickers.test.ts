/**
 * Integration tests for packages/api/src/routes/web-pickers.ts.
 *
 * Покрывает три эндпоинта — GET /web/avatars/heygen, /web/motions, /web/soul-styles.
 * Все три:
 *  - под `webTelegramLinkedPreHandler` (401 / 403);
 *  - читают ключ из key-pool (provider "heygen" или "higgsfield_soul");
 *  - 503 если ключа нет, 502 если upstream упал, 200 на happy-path;
 *  - имеют module-level кеш (TTL 1ч) — тест `cache hit` бежит после 200
 *    и проверяет, что повторный вызов не дёргает upstream.
 *
 * Важно: `invalidatePoolCache()` в `beforeEach` сбрасывает 30-сек кеш
 * key-pool сервиса, без него seeded ProviderKey не виден `acquireKey()`
 * сразу после `truncateAll()`. Module-level кеш самих маршрутов — НЕ
 * сбрасывается, отсюда детерминированный порядок 503 → 502 → 200 → cache.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { http, HttpResponse } from "msw";
import { buildTestApp } from "./helpers/build-app.js";
import { bearer, createTestUser } from "./fixtures/users.js";
import { createTestProviderKey } from "./fixtures/provider-keys.js";
import { mswServer } from "./msw/server.js";
import { HEYGEN_BASE } from "./msw/handlers/heygen.js";
import { HIGGSFIELD_BASE } from "./msw/handlers/higgsfield.js";
import { invalidatePoolCache } from "../src/services/key-pool.service.js";

interface AvatarItem {
  id: string;
  name: string;
  gender: string | null;
  previewUrl: string | null;
}
interface CatalogItem {
  id: string;
  name: string;
  description: string | null;
  previewUrl: string | null;
  category?: string | null;
}

describe("web-pickers routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    invalidatePoolCache();
  });

  // ── /web/avatars/heygen ────────────────────────────────────────────────────
  describe("GET /web/avatars/heygen", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/web/avatars/heygen" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 TELEGRAM_NOT_LINKED for web-only user", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "GET",
        url: "/web/avatars/heygen",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "TELEGRAM_NOT_LINKED" });
    });

    it("returns 503 when no HeyGen key is in the pool", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/avatars/heygen",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("HeyGen") });
    });

    it("returns 502 when HeyGen upstream responds with an error", async () => {
      await createTestProviderKey("heygen", "test-heygen-key");
      const { accessToken } = await createTestUser();
      mswServer.use(
        http.get(
          `${HEYGEN_BASE}/v3/avatars/looks`,
          () => new HttpResponse("upstream broken", { status: 500 }),
        ),
      );
      const res = await app.inject({
        method: "GET",
        url: "/web/avatars/heygen",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("HeyGen") });
    });

    it("returns 200 with mapped avatars from upstream", async () => {
      await createTestProviderKey("heygen", "test-heygen-key");
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/avatars/heygen",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as AvatarItem[];
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual({
        id: "look-1",
        name: "Test Look",
        gender: "female",
        previewUrl: "https://cdn.test/heygen/look-1.jpg",
      });
    });

    it("returns cached data on a subsequent call even when DB key is gone", async () => {
      const { accessToken } = await createTestUser();
      mswServer.use(
        http.get(`${HEYGEN_BASE}/v3/avatars/looks`, () => {
          throw new Error("MSW: HeyGen should not be called when cache is hot");
        }),
      );
      const res = await app.inject({
        method: "GET",
        url: "/web/avatars/heygen",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as AvatarItem[];
      expect(body[0].id).toBe("look-1");
    });
  });

  // ── /web/motions ───────────────────────────────────────────────────────────
  describe("GET /web/motions", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/web/motions" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 503 when no Higgsfield key is in the pool", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/motions",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("HiggsField") });
    });

    it("returns 502 when Higgsfield upstream responds with an error", async () => {
      await createTestProviderKey("higgsfield_soul", "test-hf-key:test-hf-secret");
      const { accessToken } = await createTestUser();
      mswServer.use(
        http.get(
          `${HIGGSFIELD_BASE}/v1/motions`,
          () => new HttpResponse("upstream broken", { status: 500 }),
        ),
      );
      const res = await app.inject({
        method: "GET",
        url: "/web/motions",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("HiggsField") });
    });

    it("returns 200 with mapped motions from upstream", async () => {
      await createTestProviderKey("higgsfield_soul", "test-hf-key:test-hf-secret");
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/motions",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as CatalogItem[];
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual({
        id: "motion-1",
        name: "Test Motion",
        description: "A swooping camera",
        previewUrl: "https://cdn.test/higgsfield/motion-1.mp4",
        category: "camera",
      });
    });

    it("returns cached data on a subsequent call even when DB key is gone", async () => {
      const { accessToken } = await createTestUser();
      mswServer.use(
        http.get(`${HIGGSFIELD_BASE}/v1/motions`, () => {
          throw new Error("MSW: motions should not be called when cache is hot");
        }),
      );
      const res = await app.inject({
        method: "GET",
        url: "/web/motions",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as CatalogItem[];
      expect(body[0].id).toBe("motion-1");
    });
  });

  // ── /web/soul-styles ───────────────────────────────────────────────────────
  describe("GET /web/soul-styles", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/web/soul-styles" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 503 when no Higgsfield key is in the pool", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/soul-styles",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("HiggsField") });
    });

    it("returns 502 when Higgsfield upstream responds with an error", async () => {
      await createTestProviderKey("higgsfield_soul", "test-hf-key:test-hf-secret");
      const { accessToken } = await createTestUser();
      mswServer.use(
        http.get(
          `${HIGGSFIELD_BASE}/v1/text2image/soul-styles`,
          () => new HttpResponse("upstream broken", { status: 500 }),
        ),
      );
      const res = await app.inject({
        method: "GET",
        url: "/web/soul-styles",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("HiggsField") });
    });

    it("returns 200 with mapped soul styles from upstream", async () => {
      await createTestProviderKey("higgsfield_soul", "test-hf-key:test-hf-secret");
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/soul-styles",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as CatalogItem[];
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: "style-1",
        name: "Test Style",
        description: "Cinematic look",
        previewUrl: "https://cdn.test/higgsfield/style-1.jpg",
      });
    });

    it("returns cached data on a subsequent call even when DB key is gone", async () => {
      const { accessToken } = await createTestUser();
      mswServer.use(
        http.get(`${HIGGSFIELD_BASE}/v1/text2image/soul-styles`, () => {
          throw new Error("MSW: soul-styles should not be called when cache is hot");
        }),
      );
      const res = await app.inject({
        method: "GET",
        url: "/web/soul-styles",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as CatalogItem[];
      expect(body[0].id).toBe("style-1");
    });
  });
});
