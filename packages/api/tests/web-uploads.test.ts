/**
 * Integration tests for POST /web/chat-uploads
 * (defined in packages/api/src/routes/web-chat.ts).
 *
 * Принимает один multipart-файл, валидирует MIME, грузит в S3 под
 * `chat-uploads/{aibUserId}/{uuid}.{ext}` и возвращает s3Key + метаданные.
 *
 * Покрывает:
 *  - webTelegramLinkedPreHandler: 401 / 403;
 *  - 400 если файл не пришёл (нет multipart-парта);
 *  - 415 для неподдерживаемого MIME;
 *  - 500 если `uploadBuffer` возвращает null (S3 недоступен);
 *  - 200 для каждого kind (image/document/video/audio) — проверяем форму
 *    ответа и формат s3Key;
 *  - 200 с дефолтным `upload.{ext}` когда filename в parts не указан.
 *
 * S3-side-effects (`uploadBuffer`, `getFileUrl`) мокаются на весь файл:
 * `uploadBuffer` возвращает переданный ключ, `getFileUrl` — детерминированный
 * presigned URL вида `https://s3.test/{key}`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type * as S3ServiceModule from "../src/services/s3.service.js";

vi.mock("../src/services/s3.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof S3ServiceModule>();
  return {
    ...actual,
    uploadBuffer: vi.fn(async (key: string): Promise<string | null> => key),
    getFileUrl: vi.fn(async (key: string): Promise<string | null> => `https://s3.test/${key}`),
  };
});

import { buildTestApp } from "./helpers/build-app.js";
import { bearer, createTestUser } from "./fixtures/users.js";
import {
  buildMultipart,
  MP3_BYTES,
  MP4_BYTES,
  PDF_BYTES,
  PNG_BYTES,
} from "./fixtures/multipart.js";
import { uploadBuffer } from "../src/services/s3.service.js";

interface UploadResponse {
  s3Key: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "document" | "video" | "audio";
  url: string | null;
}

describe("POST /web/chat-uploads", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.mocked(uploadBuffer).mockClear();
    // Default: успешный аплоад возвращает ключ. Тесты, требующие иного, перепишут.
    vi.mocked(uploadBuffer).mockImplementation(async (key: string) => key);
  });

  // ── Auth guard ────────────────────────────────────────────────────────────

  it("returns 401 without Authorization header", async () => {
    const mp = buildMultipart([
      { name: "file", value: PNG_BYTES, filename: "a.png", contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/web/chat-uploads",
      payload: mp.payload,
      headers: mp.headers,
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 TELEGRAM_NOT_LINKED for web-only user", async () => {
    const { accessToken } = await createTestUser({ withTelegram: false });
    const mp = buildMultipart([
      { name: "file", value: PNG_BYTES, filename: "a.png", contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/web/chat-uploads",
      payload: mp.payload,
      headers: { ...mp.headers, ...bearer(accessToken) },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "TELEGRAM_NOT_LINKED" });
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it("returns 400 when no file part is present", async () => {
    const { accessToken } = await createTestUser();
    // Multipart с текстовым полем, без файла — request.file() вернёт undefined.
    const mp = buildMultipart([{ name: "note", value: "no file here" }]);
    const res = await app.inject({
      method: "POST",
      url: "/web/chat-uploads",
      payload: mp.payload,
      headers: { ...mp.headers, ...bearer(accessToken) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("Файл") });
  });

  it("returns 415 for an unsupported MIME type", async () => {
    const { accessToken } = await createTestUser();
    const mp = buildMultipart([
      {
        name: "file",
        value: Buffer.from("dummy"),
        filename: "weird.bin",
        contentType: "application/x-not-allowed",
      },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/web/chat-uploads",
      payload: mp.payload,
      headers: { ...mp.headers, ...bearer(accessToken) },
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  });

  // ── S3 failure ────────────────────────────────────────────────────────────

  it("returns 500 when S3 upload returns null", async () => {
    vi.mocked(uploadBuffer).mockResolvedValueOnce(null);
    const { accessToken } = await createTestUser();
    const mp = buildMultipart([
      { name: "file", value: PNG_BYTES, filename: "a.png", contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/web/chat-uploads",
      payload: mp.payload,
      headers: { ...mp.headers, ...bearer(accessToken) },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("S3") });
  });

  // ── Happy paths per kind ──────────────────────────────────────────────────

  it("returns 200 and image kind for a PNG", async () => {
    const { user, accessToken } = await createTestUser();
    const mp = buildMultipart([
      { name: "file", value: PNG_BYTES, filename: "snap.png", contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/web/chat-uploads",
      payload: mp.payload,
      headers: { ...mp.headers, ...bearer(accessToken) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UploadResponse;
    expect(body.kind).toBe("image");
    expect(body.mimeType).toBe("image/png");
    expect(body.size).toBe(PNG_BYTES.byteLength);
    expect(body.name).toBe("snap.png");
    expect(body.s3Key).toMatch(new RegExp(`^chat-uploads/${user.id}/[0-9a-f-]+\\.png$`));
    expect(body.url).toBe(`https://s3.test/${body.s3Key}`);
  });

  it("returns 200 and document kind for a PDF", async () => {
    const { accessToken } = await createTestUser();
    const mp = buildMultipart([
      { name: "file", value: PDF_BYTES, filename: "doc.pdf", contentType: "application/pdf" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/web/chat-uploads",
      payload: mp.payload,
      headers: { ...mp.headers, ...bearer(accessToken) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UploadResponse;
    expect(body.kind).toBe("document");
    expect(body.s3Key.endsWith(".pdf")).toBe(true);
  });

  it("returns 200 and video kind for an MP4", async () => {
    const { accessToken } = await createTestUser();
    const mp = buildMultipart([
      { name: "file", value: MP4_BYTES, filename: "clip.mp4", contentType: "video/mp4" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/web/chat-uploads",
      payload: mp.payload,
      headers: { ...mp.headers, ...bearer(accessToken) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UploadResponse;
    expect(body.kind).toBe("video");
    expect(body.s3Key.endsWith(".mp4")).toBe(true);
  });

  it("returns 200 and audio kind for an MP3", async () => {
    const { accessToken } = await createTestUser();
    const mp = buildMultipart([
      { name: "file", value: MP3_BYTES, filename: "song.mp3", contentType: "audio/mpeg" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/web/chat-uploads",
      payload: mp.payload,
      headers: { ...mp.headers, ...bearer(accessToken) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UploadResponse;
    expect(body.kind).toBe("audio");
    expect(body.s3Key.endsWith(".mp3")).toBe(true);
  });

  it("falls back to upload.<ext> name when filename is empty", async () => {
    const { accessToken } = await createTestUser();
    // filename="" имитирует браузерный Edge-case (drag-n-drop без имени).
    const mp = buildMultipart([
      { name: "file", value: PNG_BYTES, filename: "", contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/web/chat-uploads",
      payload: mp.payload,
      headers: { ...mp.headers, ...bearer(accessToken) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UploadResponse;
    expect(body.name).toBe("upload.png");
  });
});
