/**
 * MSW handlers for Higgsfield upstream API (https://platform.higgsfield.ai).
 * Used by:
 *   - `web-pickers.ts`              → GET /v1/motions
 *   - `user-avatars.ts` (Soul flow) → POST /v1/custom-references + GET /v1/custom-references/:id
 *
 * Defaults are happy-path; per-test override via `mswServer.use(...)`.
 */

import { http, HttpResponse } from "msw";

export const HIGGSFIELD_BASE = "https://platform.higgsfield.ai";

export const higgsfieldHandlers = [
  // Motions catalog.
  http.get(`${HIGGSFIELD_BASE}/v1/motions`, () =>
    HttpResponse.json([
      {
        id: "motion-1",
        name: "Test Motion",
        description: "A swooping camera",
        preview_url: "https://cdn.test/higgsfield/motion-1.mp4",
        category: "camera",
      },
    ]),
  ),

  // Soul styles catalog (web-pickers GET /web/soul-styles).
  http.get(`${HIGGSFIELD_BASE}/v1/text2image/soul-styles`, () =>
    HttpResponse.json([
      {
        id: "style-1",
        name: "Test Style",
        description: "Cinematic look",
        preview_url: "https://cdn.test/higgsfield/style-1.jpg",
      },
    ]),
  ),

  // Soul custom reference (user-avatars / Higgsfield soul provider).
  http.post(`${HIGGSFIELD_BASE}/v1/custom-references`, () =>
    HttpResponse.json({
      id: "soul-ref-1",
      status: "queued",
    }),
  ),

  http.get(`${HIGGSFIELD_BASE}/v1/custom-references/:id`, ({ params }) =>
    HttpResponse.json({
      id: params.id,
      status: "ready",
    }),
  ),
];
