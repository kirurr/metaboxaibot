/**
 * MSW handlers for HeyGen upstream API (https://api.heygen.com).
 * Used by `web-pickers.ts` (avatars/looks) and `user-avatars.ts` + the video
 * adapter (assets upload, video create/status).
 *
 * Defaults are happy-path so existing tests with `onUnhandledRequest: "error"`
 * don't fall over once a route accidentally pings HeyGen. Per-test overrides
 * via `mswServer.use(...)`.
 */

import { http, HttpResponse } from "msw";

export const HEYGEN_BASE = "https://api.heygen.com";

export const heygenHandlers = [
  // Public avatar catalog (web-pickers GET /web/avatars/heygen).
  http.get(`${HEYGEN_BASE}/v3/avatars/looks`, () =>
    HttpResponse.json({
      data: [
        {
          id: "look-1",
          name: "Test Look",
          gender: "female",
          preview_image_url: "https://cdn.test/heygen/look-1.jpg",
        },
      ],
    }),
  ),

  // Voice catalog (heygen-voices route).
  http.get(`${HEYGEN_BASE}/v2/voices`, () =>
    HttpResponse.json({
      data: { voices: [] },
    }),
  ),

  // Asset upload — used by HeyGen avatar/video adapters.
  http.post(`${HEYGEN_BASE}/v3/assets`, () =>
    HttpResponse.json({
      data: { id: "asset-test-1", url: "https://cdn.test/heygen/asset-test-1" },
    }),
  ),
];
