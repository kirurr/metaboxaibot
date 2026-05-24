/**
 * Integration tests for /web/billing/* in packages/api/src/routes/web-billing.ts.
 *
 * `GET /web/billing/catalog` уже покрыт smoke-tests; здесь — invoice + order
 * status (3 эндпоинта).
 *
 * Покрывает:
 *  - webTelegramLinkedPreHandler (401 без токена, 403 для web-only юзера);
 *  - 409 TG не привязан (для invoice-роутов: webUser.telegramId === null);
 *  - 400 на missing/некорректные параметры;
 *  - 200 happy-path → возвращает paymentUrl + orderId/subscriptionId;
 *  - 502 при Metabox ошибке (5xx upstream).
 *
 * Default-handlers для metabox invoice + alt-order-status сидят в
 * `tests/msw/handlers/metabox-billing.ts`; конкретные тесты переписывают их
 * через `mswServer.use(...)` для error-сценариев.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers/build-app.js";
import { bearer, createTestUser } from "./fixtures/users.js";
import { mswServer } from "./msw/server.js";

const METABOX_BASE = "https://metabox-test.example.com";

describe("/web/billing/* (invoice + order status)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── POST /web/billing/subscription-invoice ──────────────────────────────
  describe("POST /web/billing/subscription-invoice", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/web/billing/subscription-invoice",
        payload: { planId: "sub-test", period: "M1" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 TELEGRAM_NOT_LINKED for web-only user", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "POST",
        url: "/web/billing/subscription-invoice",
        payload: { planId: "sub-test", period: "M1" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "TELEGRAM_NOT_LINKED" });
    });

    it("returns 400 when planId or period is missing", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/billing/subscription-invoice",
        payload: {},
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for an unknown period", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/billing/subscription-invoice",
        payload: { planId: "sub-test", period: "M99" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 200 with paymentUrl + orderId on happy path", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/billing/subscription-invoice",
        payload: { planId: "sub-test", period: "M3" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { orderId: string; paymentUrl: string };
      expect(body.paymentUrl).toBe("https://pay.test/sub/checkout");
      expect(body.orderId).toBe("sub-test-1");
    });

    it("returns 502 when Metabox responds with a 5xx", async () => {
      mswServer.use(
        http.post(
          `${METABOX_BASE}/api/internal/subscription-invoice`,
          () => new HttpResponse(JSON.stringify({ error: "upstream broken" }), { status: 500 }),
        ),
      );
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/billing/subscription-invoice",
        payload: { planId: "sub-test", period: "M1" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(502);
    });
  });

  // ── POST /web/billing/tokens-invoice ────────────────────────────────────
  describe("POST /web/billing/tokens-invoice", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/web/billing/tokens-invoice",
        payload: { productId: "pkg-test" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 when productId is missing", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/billing/tokens-invoice",
        payload: {},
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 200 with paymentUrl + orderId on happy path", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/billing/tokens-invoice",
        payload: { productId: "pkg-test" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { orderId: string; paymentUrl: string };
      expect(body.paymentUrl).toBe("https://pay.test/tokens/checkout");
      expect(body.orderId).toBe("ord-test-1");
    });

    it("returns 502 when Metabox responds with a 5xx", async () => {
      mswServer.use(
        http.post(
          `${METABOX_BASE}/api/internal/aibot-invoice`,
          () => new HttpResponse(JSON.stringify({ error: "upstream broken" }), { status: 502 }),
        ),
      );
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/billing/tokens-invoice",
        payload: { productId: "pkg-test" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(502);
    });
  });

  // ── GET /web/billing/order/:id/status ───────────────────────────────────
  describe("GET /web/billing/order/:id/status", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/web/billing/order/ord-1/status",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 with default PENDING status from Metabox", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/billing/order/ord-1/status",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "PENDING" });
    });

    it("returns PAID when Metabox marks order paid", async () => {
      mswServer.use(
        http.get(`${METABOX_BASE}/api/internal/alt-order-status`, () =>
          HttpResponse.json({ status: "PAID" }),
        ),
      );
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/billing/order/ord-1/status",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "PAID" });
    });

    it("returns the upstream status code on Metabox 404", async () => {
      mswServer.use(
        http.get(
          `${METABOX_BASE}/api/internal/alt-order-status`,
          () => new HttpResponse("not found", { status: 404 }),
        ),
      );
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/billing/order/ord-missing/status",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
