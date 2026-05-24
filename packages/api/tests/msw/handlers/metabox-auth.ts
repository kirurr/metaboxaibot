/**
 * MSW handlers for Metabox auth-bridge endpoints called by `web-auth.ts`
 * and by `ensureAibUserForMetabox` (account-sync, transitively invoked on
 * signup / login / refresh).
 *
 * Auth-related email sending lives inside Metabox itself — these stubs make
 * the bridge POSTs succeed without hitting the real service. Defaults are
 * happy-path; per-test override via `mswServer.use(...)`.
 *
 * Base URL must match `process.env.METABOX_API_URL` set in `tests/setup/env.ts`.
 */

import { http, HttpResponse } from "msw";

const METABOX_BASE = "https://metabox-test.example.com";

const TEST_METABOX_USER_ID = "mb-user-test";

export const metaboxAuthHandlers = [
  // ── web-auth.ts direct calls ─────────────────────────────────────────────
  http.post(`${METABOX_BASE}/api/internal/web-register`, () =>
    HttpResponse.json({
      metaboxUserId: TEST_METABOX_USER_ID,
      email: "new-user@test.example",
      firstName: "New",
      lastName: null,
      referralCode: "REF-TEST",
      requiresVerification: false,
    }),
  ),

  http.post(`${METABOX_BASE}/api/internal/web-validate-credentials`, () =>
    HttpResponse.json({
      metaboxUserId: TEST_METABOX_USER_ID,
      email: "login-user@test.example",
      firstName: "Login",
      lastName: null,
      referralCode: "REF-LOGIN",
    }),
  ),

  http.post(`${METABOX_BASE}/api/internal/web-get-profile`, () =>
    HttpResponse.json({
      metaboxUserId: TEST_METABOX_USER_ID,
      email: "profile@test.example",
      firstName: "Profile",
      lastName: null,
      name: "Profile",
      telegramId: null,
      telegramUsername: null,
      referralCode: "REF-TEST",
    }),
  ),

  http.post(`${METABOX_BASE}/api/internal/web-resend-verification`, () =>
    HttpResponse.json({ ok: true }),
  ),

  http.post(`${METABOX_BASE}/api/internal/web-password-reset-request`, () =>
    HttpResponse.json({ ok: true }),
  ),

  http.post(`${METABOX_BASE}/api/internal/web-password-reset-confirm`, () =>
    HttpResponse.json({ ok: true }),
  ),

  http.post(`${METABOX_BASE}/api/internal/web-change-password`, () =>
    HttpResponse.json({ ok: true }),
  ),

  // ── account-sync (ensureAibUserForMetabox) bridge calls ──────────────────
  // GET helpers use the `/api` prefix (not `/api/internal`) per metabox-bridge.
  http.get(`${METABOX_BASE}/api/internal/follow-merge`, ({ request }) => {
    const url = new URL(request.url);
    const id = url.searchParams.get("metaboxUserId") ?? TEST_METABOX_USER_ID;
    return HttpResponse.json({ metaboxUserId: id });
  }),

  http.post(`${METABOX_BASE}/api/internal/set-aibox-id`, () =>
    HttpResponse.json({ ok: true, alreadySet: false }),
  ),

  http.post(`${METABOX_BASE}/api/internal/reconcile-by-aibox`, () =>
    HttpResponse.json({ ok: true, case: "none" }),
  ),

  http.get(`${METABOX_BASE}/api/internal/pending-token-grants`, () =>
    HttpResponse.json({ orders: [] }),
  ),

  http.get(`${METABOX_BASE}/api/internal/subscription-status`, () =>
    HttpResponse.json({ status: "none" }),
  ),

  http.post(`${METABOX_BASE}/api/internal/mark-order-granted`, () =>
    HttpResponse.json({ ok: true }),
  ),

  http.post(`${METABOX_BASE}/api/internal/mark-tokens-granted`, () =>
    HttpResponse.json({ ok: true }),
  ),
];
