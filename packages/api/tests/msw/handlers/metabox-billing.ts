/**
 * MSW handlers for Metabox billing endpoints called by `web-billing.ts`:
 *   - POST /api/internal/subscription-invoice   (createSubscriptionInvoice)
 *   - POST /api/internal/aibot-invoice          (createAiBotInvoice)
 *   - GET  /api/internal/alt-order-status       (order status polling)
 *
 * Base URL must match `process.env.METABOX_API_URL` set in `tests/setup/env.ts`.
 * Per-test override: `mswServer.use(http.post(URL, () => HttpResponse.json(...)))`.
 */

import { http, HttpResponse } from "msw";

const METABOX_BASE = "https://metabox-test.example.com";

export const metaboxBillingHandlers = [
  http.post(`${METABOX_BASE}/api/internal/subscription-invoice`, () =>
    HttpResponse.json({
      paymentUrl: "https://pay.test/sub/checkout",
      subscriptionId: "sub-test-1",
    }),
  ),

  http.post(`${METABOX_BASE}/api/internal/aibot-invoice`, () =>
    HttpResponse.json({
      paymentUrl: "https://pay.test/tokens/checkout",
      orderId: "ord-test-1",
    }),
  ),

  http.get(`${METABOX_BASE}/api/internal/alt-order-status`, () =>
    HttpResponse.json({ status: "PENDING" }),
  ),
];
