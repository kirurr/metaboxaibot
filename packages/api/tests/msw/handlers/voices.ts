/**
 * MSW handlers для внешних TTS-API, используемых `src/routes/web-voices.ts`:
 *   - Cartesia: GET /voices (list) + GET /voices/:id (preview meta) + CDN preview URL.
 *   - ElevenLabs: GET /v1/voices (single page).
 *
 * Дефолты — happy-path с двумя голосами на провайдера: первый удовлетворяет
 * фильтр (`is_public: true` / `category: "premade"`), второй — нет, чтобы
 * тесты могли проверить отсев "приватных"/"non-premade" голосов.
 *
 * Per-test override: `mswServer.use(http.get(URL, () => HttpResponse.json(...)))`.
 */

import { http, HttpResponse } from "msw";

// ── Constants reused by tests ────────────────────────────────────────────────

export const CARTESIA_PREVIEW_CDN_URL = "https://cdn.test/cartesia/preview.mp3";

// ── Cartesia ─────────────────────────────────────────────────────────────────

export const cartesiaHandlers = [
  // Список голосов. Маршрут пагинирует через `starting_after`, но дефолт
  // отдаёт одну страницу (has_more: false), чтобы цикл сразу выходил.
  http.get("https://api.cartesia.ai/voices", () =>
    HttpResponse.json({
      data: [
        {
          id: "voice-public-1",
          name: "Public Voice",
          description: "A friendly public voice",
          is_owner: false,
          is_public: true,
          gender: "female",
          language: "en",
          preview_file_url: CARTESIA_PREVIEW_CDN_URL,
        },
        {
          id: "voice-private-1",
          name: "Private Voice",
          description: "Owner-only voice",
          is_owner: true,
          is_public: false,
          gender: "male",
          language: "en",
          preview_file_url: null,
        },
      ],
      has_more: false,
    }),
  ),

  // Метаинфо по одному голосу — используется preview-стримом перед скачиванием.
  http.get("https://api.cartesia.ai/voices/:id", ({ params }) =>
    HttpResponse.json({
      id: params.id,
      name: "Public Voice",
      is_public: true,
      preview_file_url: CARTESIA_PREVIEW_CDN_URL,
    }),
  ),

  // Сам аудио-файл (preview) — короткий MP3-like буфер, content-type audio/mpeg.
  http.get(CARTESIA_PREVIEW_CDN_URL, () =>
    HttpResponse.arrayBuffer(
      new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0xde, 0xad, 0xbe, 0xef]).buffer,
      {
        headers: { "content-type": "audio/mpeg" },
      },
    ),
  ),
];

// ── ElevenLabs ───────────────────────────────────────────────────────────────

export const elevenLabsHandlers = [
  http.get("https://api.elevenlabs.io/v1/voices", () =>
    HttpResponse.json({
      voices: [
        {
          voice_id: "el-premade-1",
          name: "Rachel",
          category: "premade",
          labels: { gender: "female", language: "en", description: "calm" },
          preview_url: "https://cdn.test/elevenlabs/rachel.mp3",
        },
        {
          voice_id: "el-cloned-1",
          name: "Custom Clone",
          category: "cloned",
          labels: { gender: "male", language: "en" },
          preview_url: "https://cdn.test/elevenlabs/clone.mp3",
        },
      ],
    }),
  ),
];
