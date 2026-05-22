/**
 * Integration tests for packages/api/src/routes/web-model-settings.ts.
 *
 * 4 эндпоинта (GET/PATCH `/web/model-settings` + GET/PATCH `/web/model-settings/dialog/:id`)
 * мапятся на `userStateService` поверх JSONB-поля `UserState.modelSettings`.
 *
 * Покрываем: auth-гард (`webTelegramLinkedPreHandler` — 401/403), zod-валидацию
 * body, round-trip CRUD через PATCH→GET, deep-merge vs replace на уровне modelId,
 * изоляцию model- и dialog-настроек (dialog хранится под ключом `"dialog:<id>"`
 * в том же объекте).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers/build-app.js";
import { bearer, createTestUser } from "./fixtures/users.js";

describe("/web/model-settings routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── GET /web/model-settings ─────────────────────────────────────────────
  describe("GET /web/model-settings", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/web/model-settings" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 TELEGRAM_NOT_LINKED for a web-only user", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "GET",
        url: "/web/model-settings",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "TELEGRAM_NOT_LINKED" });
    });

    it("returns {} for a new user with no saved settings", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "GET",
        url: "/web/model-settings",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});
    });

    it("returns saved model settings after PATCH (round-trip)", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      const patch = await app.inject({
        method: "PATCH",
        url: "/web/model-settings",
        headers: bearer(accessToken),
        payload: { modelId: "m1", settings: { aspectRatio: "16:9" } },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json()).toEqual({ success: true });

      const get = await app.inject({
        method: "GET",
        url: "/web/model-settings",
        headers: bearer(accessToken),
      });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({ m1: { aspectRatio: "16:9" } });
    });
  });

  // ── PATCH /web/model-settings ───────────────────────────────────────────
  describe("PATCH /web/model-settings", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/web/model-settings",
        payload: { modelId: "m1", settings: {} },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 when modelId is missing", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "PATCH",
        url: "/web/model-settings",
        headers: bearer(accessToken),
        payload: { settings: {} },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when settings is missing", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "PATCH",
        url: "/web/model-settings",
        headers: bearer(accessToken),
        payload: { modelId: "m1" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("deep-merges keys on repeated PATCH (default behavior)", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      await app.inject({
        method: "PATCH",
        url: "/web/model-settings",
        headers: bearer(accessToken),
        payload: { modelId: "m1", settings: { a: 1 } },
      });
      await app.inject({
        method: "PATCH",
        url: "/web/model-settings",
        headers: bearer(accessToken),
        payload: { modelId: "m1", settings: { b: 2 } },
      });
      const get = await app.inject({
        method: "GET",
        url: "/web/model-settings",
        headers: bearer(accessToken),
      });
      expect(get.json()).toEqual({ m1: { a: 1, b: 2 } });
    });

    it("replaces the model entry entirely with replace=true", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      await app.inject({
        method: "PATCH",
        url: "/web/model-settings",
        headers: bearer(accessToken),
        payload: { modelId: "m1", settings: { a: 1, b: 2 } },
      });
      await app.inject({
        method: "PATCH",
        url: "/web/model-settings",
        headers: bearer(accessToken),
        payload: { modelId: "m1", settings: { c: 3 }, replace: true },
      });
      const get = await app.inject({
        method: "GET",
        url: "/web/model-settings",
        headers: bearer(accessToken),
      });
      expect(get.json()).toEqual({ m1: { c: 3 } });
    });
  });

  // ── GET /web/model-settings/dialog/:dialogId ────────────────────────────
  describe("GET /web/model-settings/dialog/:dialogId", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/web/model-settings/dialog/dlg-1" });
      expect(res.statusCode).toBe(401);
    });

    it("returns {} for a dialog with no saved overrides", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "GET",
        url: "/web/model-settings/dialog/dlg-1",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});
    });

    it("returns dialog-level overrides after PATCH (round-trip)", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      const patch = await app.inject({
        method: "PATCH",
        url: "/web/model-settings/dialog/dlg-1",
        headers: bearer(accessToken),
        payload: { settings: { tone: "casual" } },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json()).toEqual({ success: true });

      const get = await app.inject({
        method: "GET",
        url: "/web/model-settings/dialog/dlg-1",
        headers: bearer(accessToken),
      });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({ tone: "casual" });
    });
  });

  // ── PATCH /web/model-settings/dialog/:dialogId ──────────────────────────
  describe("PATCH /web/model-settings/dialog/:dialogId", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/web/model-settings/dialog/dlg-1",
        payload: { settings: {} },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 when settings is missing", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "PATCH",
        url: "/web/model-settings/dialog/dlg-1",
        headers: bearer(accessToken),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("stores dialog settings under the 'dialog:<id>' key, isolated from model settings", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      await app.inject({
        method: "PATCH",
        url: "/web/model-settings",
        headers: bearer(accessToken),
        payload: { modelId: "m1", settings: { x: 1 } },
      });
      await app.inject({
        method: "PATCH",
        url: "/web/model-settings/dialog/dlg-1",
        headers: bearer(accessToken),
        payload: { settings: { y: 2 } },
      });

      const allSettings = await app.inject({
        method: "GET",
        url: "/web/model-settings",
        headers: bearer(accessToken),
      });
      expect(allSettings.statusCode).toBe(200);
      expect(allSettings.json()).toEqual({
        m1: { x: 1 },
        "dialog:dlg-1": { y: 2 },
      });

      const dialogOnly = await app.inject({
        method: "GET",
        url: "/web/model-settings/dialog/dlg-1",
        headers: bearer(accessToken),
      });
      expect(dialogOnly.statusCode).toBe(200);
      expect(dialogOnly.json()).toEqual({ y: 2 });
    });
  });
});
