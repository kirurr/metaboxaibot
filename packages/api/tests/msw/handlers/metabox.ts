/**
 * Default msw handlers for the Metabox internal API. Tests can override any
 * of these per-case with `mswServer.use(...)`. The base URL must match
 * `process.env.METABOX_API_URL` set in `vitest.setup.ts`.
 *
 * Endpoint contracts mirror `packages/api/src/services/metabox-bridge.service.ts`
 * (GET goes to `/api`, POST goes to `/api/internal`).
 */

import { http, HttpResponse } from "msw";

const METABOX_BASE = "https://metabox-test.example.com";

export const metaboxHandlers = [
  // GET /aibot/catalog — used by /web/billing/catalog
  http.get(`${METABOX_BASE}/api/aibot/catalog`, () =>
    HttpResponse.json({
      subscriptions: [
        {
          id: "sub-test",
          name: "Test Plan",
          tokens: "1000",
          priceMonthly: "299.00",
          discount3m: 10,
          discount6m: 15,
          discount12m: 20,
        },
      ],
      tokenPackages: [
        {
          id: "pkg-test",
          name: "Starter pack",
          tokens: "100",
          priceRub: "99.00",
          badge: null,
        },
      ],
    }),
  ),
];
