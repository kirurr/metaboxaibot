/**
 * Integration tests for /web/uploaded-media (packages/api/src/routes/web-uploaded-media.ts)
 * + the persistence hook in POST /web/chat-uploads (packages/api/src/routes/web-chat.ts).
 *
 * Покрывает:
 *  - webTelegramLinkedPreHandler: 401 / 403 на list;
 *  - upload image/video/audio через /web/chat-uploads создаёт UploadedMedia-строку,
 *    которая видна в GET /web/uploaded-media (newest first);
 *  - документ (PDF) НЕ попадает в список;
 *  - фильтр ?type= отсекает по типу;
 *  - курсорная пагинация (take + nextCursor) отдаёт вторую страницу;
 *  - DELETE убирает запись из списка; повторный DELETE → 404; чужую не трогает.
 *
 * S3-side-effects мокаются как в web-uploads.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

interface MediaItem {
  id: string;
  type: string;
  name: string;
  mimeType: string;
  size: number;
  url: string | null;
  createdAt: string;
}
interface MediaPage {
  items: MediaItem[];
  nextCursor: string | null;
}

async function upload(
  app: FastifyInstance,
  accessToken: string,
  file: { value: Buffer; filename: string; contentType: string },
) {
  const mp = buildMultipart([{ name: "file", ...file }]);
  return app.inject({
    method: "POST",
    url: "/web/chat-uploads",
    payload: mp.payload,
    headers: { ...mp.headers, ...bearer(accessToken) },
  });
}

describe("GET /web/uploaded-media", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Auth guard ──────────────────────────────────────────────────────────────

  it("returns 401 without Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/web/uploaded-media" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 TELEGRAM_NOT_LINKED for web-only user", async () => {
    const { accessToken } = await createTestUser({ withTelegram: false });
    const res = await app.inject({
      method: "GET",
      url: "/web/uploaded-media",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "TELEGRAM_NOT_LINKED" });
  });

  // ── Persistence on upload ─────────────────────────────────────────────────────

  it("lists media persisted on upload, newest first, and excludes documents", async () => {
    const { accessToken } = await createTestUser();

    await upload(app, accessToken, {
      value: PNG_BYTES,
      filename: "a.png",
      contentType: "image/png",
    });
    await upload(app, accessToken, {
      value: PDF_BYTES,
      filename: "doc.pdf",
      contentType: "application/pdf",
    });
    await upload(app, accessToken, {
      value: MP4_BYTES,
      filename: "clip.mp4",
      contentType: "video/mp4",
    });

    const res = await app.inject({
      method: "GET",
      url: "/web/uploaded-media",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MediaPage;

    // PDF (document) не сохраняется → только 2 записи.
    expect(body.items).toHaveLength(2);
    // newest first: mp4 загружен последним.
    expect(body.items[0].type).toBe("video");
    expect(body.items[0].name).toBe("clip.mp4");
    expect(body.items[1].type).toBe("image");
    expect(body.items[0].url).toMatch(/^https:\/\/s3\.test\/chat-uploads\//);
    expect(body.items.every((i) => i.type !== "document")).toBe(true);
  });

  // ── Type filter ───────────────────────────────────────────────────────────────

  it("filters by type", async () => {
    const { accessToken } = await createTestUser();
    await upload(app, accessToken, {
      value: PNG_BYTES,
      filename: "a.png",
      contentType: "image/png",
    });
    await upload(app, accessToken, {
      value: MP3_BYTES,
      filename: "s.mp3",
      contentType: "audio/mpeg",
    });

    const res = await app.inject({
      method: "GET",
      url: "/web/uploaded-media?type=audio",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MediaPage;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].type).toBe("audio");
  });

  // ── Cursor pagination ───────────────────────────────────────────────────────

  it("paginates with take + nextCursor", async () => {
    const { accessToken } = await createTestUser();
    for (let i = 0; i < 3; i++) {
      await upload(app, accessToken, {
        value: PNG_BYTES,
        filename: `p${i}.png`,
        contentType: "image/png",
      });
    }

    const first = await app.inject({
      method: "GET",
      url: "/web/uploaded-media?take=2",
      headers: bearer(accessToken),
    });
    expect(first.statusCode).toBe(200);
    const page1 = first.json() as MediaPage;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const second = await app.inject({
      method: "GET",
      url: `/web/uploaded-media?take=2&cursor=${page1.nextCursor}`,
      headers: bearer(accessToken),
    });
    const page2 = second.json() as MediaPage;
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    // Без пересечения между страницами.
    const ids = new Set([...page1.items, ...page2.items].map((i) => i.id));
    expect(ids.size).toBe(3);
  });
});

describe("DELETE /web/uploaded-media/:id", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("removes the record from the list", async () => {
    const { accessToken } = await createTestUser();
    await upload(app, accessToken, {
      value: PNG_BYTES,
      filename: "a.png",
      contentType: "image/png",
    });

    const list = await app.inject({
      method: "GET",
      url: "/web/uploaded-media",
      headers: bearer(accessToken),
    });
    const id = (list.json() as MediaPage).items[0].id;

    const del = await app.inject({
      method: "DELETE",
      url: `/web/uploaded-media/${id}`,
      headers: bearer(accessToken),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ success: true });

    const after = await app.inject({
      method: "GET",
      url: "/web/uploaded-media",
      headers: bearer(accessToken),
    });
    expect((after.json() as MediaPage).items).toHaveLength(0);
  });

  it("returns 404 for a missing / already-deleted id", async () => {
    const { accessToken } = await createTestUser();
    const res = await app.inject({
      method: "DELETE",
      url: "/web/uploaded-media/does-not-exist",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(404);
  });

  it("does not delete another user's media (404)", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    await upload(app, owner.accessToken, {
      value: PNG_BYTES,
      filename: "a.png",
      contentType: "image/png",
    });
    const id = (
      (
        await app.inject({
          method: "GET",
          url: "/web/uploaded-media",
          headers: bearer(owner.accessToken),
        })
      ).json() as MediaPage
    ).items[0].id;

    const del = await app.inject({
      method: "DELETE",
      url: `/web/uploaded-media/${id}`,
      headers: bearer(other.accessToken),
    });
    expect(del.statusCode).toBe(404);

    // Запись владельца на месте.
    const ownerList = await app.inject({
      method: "GET",
      url: "/web/uploaded-media",
      headers: bearer(owner.accessToken),
    });
    expect((ownerList.json() as MediaPage).items).toHaveLength(1);
  });
});
