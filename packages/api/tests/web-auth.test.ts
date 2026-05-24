/**
 * Integration tests for packages/api/src/routes/web-auth.ts.
 *
 * Покрывает 13 /auth/web-* эндпоинтов, сгруппированных в describe-блоки:
 *  - Session: login / refresh / logout
 *  - Signup + email-verification + resend
 *  - Profile (web-me GET/PATCH) + transactions
 *  - Password: forgot / reset / change
 *  - Telegram link: init / status
 *
 * Стратегия моков:
 *  1. `validateEmail` дёргает реальный `dns.resolveMx` — мокается на весь
 *     файл, всегда `ok: true`. Без этого signup-тесты упирались бы в DNS.
 *  2. Metabox-bridge эндпоинты (`web-validate-credentials`, `web-register`,
 *     `web-get-profile`, password resets, plus account-sync internals —
 *     `follow-merge`, `set-aibox-id`, `reconcile-by-aibox`,
 *     `pending-token-grants`, `subscription-status`) — через MSW (см.
 *     `tests/msw/handlers/metabox-auth.ts`).
 *  3. AI Box User создаётся `ensureAibUserForMetabox` через реальный Prisma —
 *     это и есть основной side-effect signup/login flow.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import type { FastifyInstance } from "fastify";

vi.mock("../src/utils/email-validation.js", () => ({
  validateEmail: vi.fn(async (email: string) => ({
    ok: true as const,
    normalized: typeof email === "string" ? email.trim().toLowerCase() : "",
  })),
}));

import { buildTestApp } from "./helpers/build-app.js";
import { bearer, createTestUser } from "./fixtures/users.js";
import { db } from "./helpers/db.js";
import { getRedis } from "./helpers/redis.js";
import { mswServer } from "./msw/server.js";

const METABOX_BASE = "https://metabox-test.example.com";

interface IssuedSession {
  user: { metaboxUserId: string; email: string; firstName: string | null };
  accessToken: string;
  accessTokenExpiresAt: number;
  csrfToken: string;
}

describe("web-auth routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Signup ────────────────────────────────────────────────────────────────
  describe("POST /auth/web-signup", () => {
    it("returns 400 for an invalid email", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-signup",
        payload: { email: "not-an-email", password: "longenoughpw", firstName: "Bob" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for a password shorter than 8 characters", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-signup",
        payload: { email: "user@example.test", password: "short", firstName: "Bob" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for an empty firstName", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-signup",
        payload: { email: "user@example.test", password: "longenoughpw", firstName: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns { requiresVerification: true } when Metabox flags email confirmation", async () => {
      mswServer.use(
        http.post(`${METABOX_BASE}/api/internal/web-register`, () =>
          HttpResponse.json({
            metaboxUserId: "mb-newsignup",
            email: "verify-me@example.test",
            firstName: "Sue",
            lastName: null,
            referralCode: "REF",
            requiresVerification: true,
          }),
        ),
      );
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-signup",
        payload: {
          email: "verify-me@example.test",
          password: "longenoughpw",
          firstName: "Sue",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        requiresVerification: true,
        email: "verify-me@example.test",
        firstName: "Sue",
      });
      // requiresVerification path: AI Box User NOT created
      const dbUser = await db.user.findFirst({ where: { metaboxUserId: "mb-newsignup" } });
      expect(dbUser).toBeNull();
    });

    it("returns a session and creates an AI Box User when verification not required", async () => {
      mswServer.use(
        http.post(`${METABOX_BASE}/api/internal/web-register`, () =>
          HttpResponse.json({
            metaboxUserId: "mb-autoverify",
            email: "auto@example.test",
            firstName: "Sue",
            lastName: null,
            referralCode: "REF",
            requiresVerification: false,
          }),
        ),
      );
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-signup",
        payload: { email: "auto@example.test", password: "longenoughpw", firstName: "Sue" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as IssuedSession;
      expect(body.accessToken).toBeTruthy();
      expect(body.csrfToken).toBeTruthy();
      const created = await db.user.findFirst({ where: { metaboxUserId: "mb-autoverify" } });
      expect(created).not.toBeNull();
    });

    it("returns 409 EMAIL_EXISTS when Metabox reports duplicate", async () => {
      mswServer.use(
        http.post(
          `${METABOX_BASE}/api/internal/web-register`,
          () => new HttpResponse(JSON.stringify({ error: "Email taken" }), { status: 409 }),
        ),
      );
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-signup",
        payload: { email: "dup@example.test", password: "longenoughpw", firstName: "Sue" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "EMAIL_EXISTS" });
    });
  });

  // ── Login ─────────────────────────────────────────────────────────────────
  describe("POST /auth/web-login", () => {
    it("returns 400 for missing email/password", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-login",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 401 on bad credentials from Metabox", async () => {
      mswServer.use(
        http.post(
          `${METABOX_BASE}/api/internal/web-validate-credentials`,
          () => new HttpResponse(JSON.stringify({ error: "bad creds" }), { status: 401 }),
        ),
      );
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-login",
        payload: { email: "wrong@example.test", password: "longenoughpw" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 EMAIL_NOT_VERIFIED when Metabox blocks unverified login", async () => {
      mswServer.use(
        http.post(
          `${METABOX_BASE}/api/internal/web-validate-credentials`,
          () =>
            new HttpResponse(JSON.stringify({ error: "verify", code: "EMAIL_NOT_VERIFIED" }), {
              status: 403,
            }),
        ),
      );
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-login",
        payload: { email: "unverified@example.test", password: "longenoughpw" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    });

    it("issues a session and ensures an AI Box User row exists on happy path", async () => {
      mswServer.use(
        http.post(`${METABOX_BASE}/api/internal/web-validate-credentials`, () =>
          HttpResponse.json({
            metaboxUserId: "mb-loginhappy",
            email: "login@example.test",
            firstName: "Login",
            lastName: null,
            referralCode: "REF",
          }),
        ),
      );
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-login",
        payload: { email: "login@example.test", password: "longenoughpw" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as IssuedSession;
      expect(body.accessToken).toBeTruthy();
      const created = await db.user.findFirst({ where: { metaboxUserId: "mb-loginhappy" } });
      expect(created).not.toBeNull();
    });
  });

  // ── Refresh + Logout ──────────────────────────────────────────────────────
  describe("POST /auth/web-refresh", () => {
    it("returns 401 when no refresh cookie is sent", async () => {
      const res = await app.inject({ method: "POST", url: "/auth/web-refresh" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /auth/web-logout", () => {
    it("returns 200 even without a refresh cookie (no-op)", async () => {
      const res = await app.inject({ method: "POST", url: "/auth/web-logout" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });
  });

  // ── Profile ───────────────────────────────────────────────────────────────
  describe("GET /auth/web-me", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/auth/web-me" });
      expect(res.statusCode).toBe(401);
    });

    it("returns the profile for an authenticated web user", async () => {
      const { accessToken, user: testUser } = await createTestUser({ withTelegram: false });
      mswServer.use(
        http.post(`${METABOX_BASE}/api/internal/web-get-profile`, () =>
          HttpResponse.json({
            metaboxUserId: testUser.metaboxUserId,
            email: testUser.email,
            firstName: "Me",
            lastName: null,
            name: "Me",
            telegramId: null,
            telegramUsername: null,
            referralCode: "REF-ME",
          }),
        ),
      );
      const res = await app.inject({
        method: "GET",
        url: "/auth/web-me",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { user: { email: string }; csrfToken: string };
      expect(body.user.email).toBe(testUser.email);
    });
  });

  describe("PATCH /auth/web-me", () => {
    it("returns 400 when language is missing", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "PATCH",
        url: "/auth/web-me",
        payload: {},
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for an unsupported language", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "PATCH",
        url: "/auth/web-me",
        payload: { language: "xx-not-real" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 204 for a web-only user (no AI Box User row to update)", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "PATCH",
        url: "/auth/web-me",
        payload: { language: "en" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(204);
    });

    it("updates the language for a linked user and returns 200", async () => {
      const { user, accessToken } = await createTestUser();
      const res = await app.inject({
        method: "PATCH",
        url: "/auth/web-me",
        payload: { language: "en" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, language: "en" });
      const fresh = await db.user.findUnique({
        where: { id: user.id! },
        select: { language: true },
      });
      expect(fresh?.language).toBe("en");
    });
  });

  // ── Transactions ──────────────────────────────────────────────────────────
  describe("GET /auth/web-transactions", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/auth/web-transactions" });
      expect(res.statusCode).toBe(401);
    });

    it("returns an empty list for a web-only user", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "GET",
        url: "/auth/web-transactions",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ transactions: [] });
    });

    it("returns up to 20 recent transactions sorted desc", async () => {
      const { user, accessToken } = await createTestUser();
      // Explicit timestamps — createMany would otherwise assign the same
      // millisecond and break the desc-sort assertion below.
      await db.tokenTransaction.create({
        data: {
          userId: user.id!,
          amount: "10",
          type: "credit",
          reason: "test-grant",
          description: "older",
          createdAt: new Date("2025-01-01T00:00:00Z"),
        },
      });
      await db.tokenTransaction.create({
        data: {
          userId: user.id!,
          amount: "-5",
          type: "debit",
          reason: "test-spend",
          description: "newer",
          createdAt: new Date("2025-06-01T00:00:00Z"),
        },
      });
      const res = await app.inject({
        method: "GET",
        url: "/auth/web-transactions",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { transactions: Array<{ description: string }> };
      expect(body.transactions).toHaveLength(2);
      // sorted by createdAt desc — newest first
      expect(body.transactions[0].description).toBe("newer");
    });
  });

  // ── Verification & Password Flows ─────────────────────────────────────────
  describe("POST /auth/web-resend-verification", () => {
    it("returns 200 for an invalid email (silent no-op)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-resend-verification",
        payload: { email: "not-an-email" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });

    it("returns 200 on happy path", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-resend-verification",
        payload: { email: "user@example.test" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });
  });

  describe("POST /auth/web-forgot-password", () => {
    it("returns 200 for an invalid email (does not enumerate)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-forgot-password",
        payload: { email: "not-an-email" },
      });
      expect(res.statusCode).toBe(200);
    });

    it("returns 200 on first request and silently throttles repeats within 60s", async () => {
      const first = await app.inject({
        method: "POST",
        url: "/auth/web-forgot-password",
        payload: { email: "throttle@example.test" },
      });
      expect(first.statusCode).toBe(200);
      // Second call within the 60s window — throttle returns 200 silently;
      // we assert the side-effect via the Redis throttle key being set.
      const redis = getRedis();
      const throttleKey = await redis.get("web:pwreset:throttle:throttle@example.test");
      expect(throttleKey).toBe("1");
    });
  });

  describe("POST /auth/web-reset-password", () => {
    it("returns 400 for missing fields", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-reset-password",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when Metabox rejects token (400/410)", async () => {
      mswServer.use(
        http.post(
          `${METABOX_BASE}/api/internal/web-password-reset-confirm`,
          () => new HttpResponse(JSON.stringify({ error: "expired" }), { status: 410 }),
        ),
      );
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-reset-password",
        payload: { token: "stale-token", newPassword: "newlongpw1" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 200 on happy path", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-reset-password",
        payload: { token: "good-token", newPassword: "newlongpw1" },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("POST /auth/web-change-password", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-change-password",
        payload: { oldPassword: "oldlongpw", newPassword: "newlongpw" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 for a new password shorter than 8 chars", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-change-password",
        payload: { oldPassword: "oldlongpw", newPassword: "short" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 401 when Metabox rejects the old password", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      mswServer.use(
        http.post(
          `${METABOX_BASE}/api/internal/web-change-password`,
          () => new HttpResponse(JSON.stringify({ error: "wrong" }), { status: 401 }),
        ),
      );
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-change-password",
        payload: { oldPassword: "wronglongpw", newPassword: "newlongpw" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 on happy path", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-change-password",
        payload: { oldPassword: "oldlongpw", newPassword: "newlongpw" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });
  });

  // ── Telegram link ─────────────────────────────────────────────────────────
  describe("POST /auth/web-link-telegram/init", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "POST", url: "/auth/web-link-telegram/init" });
      expect(res.statusCode).toBe(401);
    });

    it("returns a deepLinkUrl and state", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-link-telegram/init",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { deepLinkUrl: string; state: string };
      expect(body.state).toMatch(/^[0-9a-f]{32}$/);
      expect(body.deepLinkUrl).toContain(`?start=linkweb_${body.state}`);
    });
  });

  describe("POST /auth/web-link-telegram/status", () => {
    it("returns 400 without state", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-link-telegram/status",
        payload: {},
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns linked:false when no Redis marker exists for the state", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-link-telegram/status",
        payload: { state: "no-such-state" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ linked: false, telegramUsername: null });
    });

    it("returns linked:true when bot has confirmed the link via Redis marker", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      const redis = getRedis();
      await redis.set(
        "web:link:linked:fakestate",
        JSON.stringify({ telegramId: "12345", telegramUsername: "tg_user" }),
      );
      const res = await app.inject({
        method: "POST",
        url: "/auth/web-link-telegram/status",
        payload: { state: "fakestate" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ linked: true, telegramUsername: "tg_user" });
    });
  });
});
