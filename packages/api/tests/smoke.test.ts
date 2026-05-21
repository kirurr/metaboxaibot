/**
 * Smoke tests — wire-up check for the test infra (buildTestApp + Prisma +
 * Redis + msw + web JWT). Picks GET /web/billing/catalog because it hits
 * every interesting layer: web auth → DB lookup → outgoing Metabox call
 * (mocked by msw).
 *
 * If anything is wrong (env not stubbed, msw not intercepting, JWT secret
 * mismatch, Telegram-linked check broken) one of these will fail.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers/build-app.js";
import { bearer, createTestUser } from "./fixtures/users.js";

describe("smoke: /web/billing/catalog", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("billing auth", () => {
    it("returns 401 when no Authorization header is provided", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/web/billing/catalog",
      });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Unauthorized" });
    });

    it("returns 403 TELEGRAM_NOT_LINKED for a web-only user without Telegram", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });

      const res = await app.inject({
        method: "GET",
        url: "/web/billing/catalog",
        headers: bearer(accessToken),
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "TELEGRAM_NOT_LINKED" });
    });
  });

  it("returns 200 with catalog for an authenticated, Telegram-linked user", async () => {
    const { accessToken } = await createTestUser({ withTelegram: true });

    const res = await app.inject({
      method: "GET",
      url: "/web/billing/catalog",
      headers: bearer(accessToken),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { subscriptions: unknown[]; tokenPackages: unknown[] };
    expect(Array.isArray(body.subscriptions)).toBe(true);
    expect(Array.isArray(body.tokenPackages)).toBe(true);
    expect(body.subscriptions.length).toBeGreaterThan(0);
    expect(body.tokenPackages.length).toBeGreaterThan(0);
  });
});
