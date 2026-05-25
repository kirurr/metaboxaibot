/**
 * Integration tests for /web/elements (packages/api/src/routes/web-elements.ts)
 * + the element-media upload and its interaction with /web/uploaded-media.
 *
 * Покрывает:
 *  - webTelegramLinkedPreHandler: 401 / 403 на list;
 *  - create: 200 + пустой media; дубль имени → 409; невалидное имя → 400;
 *  - rename: 200; дубль → 409; чужой / несуществующий → 404; невалидное имя → 400;
 *  - upload media: image → 200; не-image (mp4) → 415; в чужой/несуществующий → 404;
 *  - list: элементы newest-first с media;
 *  - РЕГРЕССИЯ-КРИТИЧНО: картинка элемента НЕ попадает в /web/uploaded-media,
 *    а обычный chat-upload — попадает;
 *  - delete media: 200, исчезает из элемента; чужую/несуществующую → 404;
 *  - delete element: каскадно удаляет media-строки; чужой / несуществующий → 404.
 *
 * S3-side-effects мокаются как в web-uploaded-media.test.ts.
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
import { db } from "./helpers/db.js";
import { bearer, createTestUser } from "./fixtures/users.js";
import { buildMultipart, MP4_BYTES, PNG_BYTES } from "./fixtures/multipart.js";

interface ElementMedia {
  id: string;
  s3Key: string;
  name: string;
  mimeType: string;
  size: number;
  url: string | null;
  createdAt: string;
}
interface Element {
  id: string;
  name: string;
  createdAt: string;
  media: ElementMedia[];
}

function createElement(app: FastifyInstance, token: string, name: string) {
  return app.inject({
    method: "POST",
    url: "/web/elements",
    payload: { name },
    headers: bearer(token),
  });
}

function uploadImage(
  app: FastifyInstance,
  token: string,
  elementId: string,
  file: { value: Buffer; filename: string; contentType: string },
) {
  const mp = buildMultipart([{ name: "file", ...file }]);
  return app.inject({
    method: "POST",
    url: `/web/elements/${elementId}/media`,
    payload: mp.payload,
    headers: { ...mp.headers, ...bearer(token) },
  });
}

const PNG = { value: PNG_BYTES, filename: "ref.png", contentType: "image/png" };

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// ── Auth guard ────────────────────────────────────────────────────────────────

describe("auth guard", () => {
  it("returns 401 without Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/web/elements" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 TELEGRAM_NOT_LINKED for web-only user", async () => {
    const { accessToken } = await createTestUser({ withTelegram: false });
    const res = await app.inject({
      method: "GET",
      url: "/web/elements",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "TELEGRAM_NOT_LINKED" });
  });
});

// ── Create ──────────────────────────────────────────────────────────────────

describe("POST /web/elements", () => {
  it("creates an element with an empty media list", async () => {
    const { accessToken } = await createTestUser();
    const res = await createElement(app, accessToken, "hero");
    expect(res.statusCode).toBe(200);
    const el = res.json() as Element;
    expect(el).toMatchObject({ name: "hero", media: [] });
    expect(el.id).toBeTruthy();
  });

  it("rejects a duplicate name for the same user with 409", async () => {
    const { accessToken } = await createTestUser();
    expect((await createElement(app, accessToken, "dup")).statusCode).toBe(200);
    expect((await createElement(app, accessToken, "dup")).statusCode).toBe(409);
  });

  it("allows the same name for different users", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    expect((await createElement(app, a.accessToken, "shared")).statusCode).toBe(200);
    expect((await createElement(app, b.accessToken, "shared")).statusCode).toBe(200);
  });

  it("rejects an invalid name with 400", async () => {
    const { accessToken } = await createTestUser();
    for (const name of ["has space", "comma,", ""]) {
      expect((await createElement(app, accessToken, name)).statusCode).toBe(400);
    }
  });
});

// ── Rename ──────────────────────────────────────────────────────────────────

describe("PATCH /web/elements/:id", () => {
  it("renames an element", async () => {
    const { accessToken } = await createTestUser();
    const id = (await createElement(app, accessToken, "old")).json().id as string;
    const res = await app.inject({
      method: "PATCH",
      url: `/web/elements/${id}`,
      payload: { name: "renamed" },
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Element).name).toBe("renamed");
  });

  it("returns 409 when renaming to an existing name", async () => {
    const { accessToken } = await createTestUser();
    await createElement(app, accessToken, "taken");
    const id = (await createElement(app, accessToken, "other")).json().id as string;
    const res = await app.inject({
      method: "PATCH",
      url: `/web/elements/${id}`,
      payload: { name: "taken" },
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 404 for a missing or foreign element", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const id = (await createElement(app, owner.accessToken, "mine")).json().id as string;

    const missing = await app.inject({
      method: "PATCH",
      url: "/web/elements/does-not-exist",
      payload: { name: "x" },
      headers: bearer(owner.accessToken),
    });
    expect(missing.statusCode).toBe(404);

    const foreign = await app.inject({
      method: "PATCH",
      url: `/web/elements/${id}`,
      payload: { name: "x" },
      headers: bearer(other.accessToken),
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("returns 400 for an invalid name", async () => {
    const { accessToken } = await createTestUser();
    const id = (await createElement(app, accessToken, "valid")).json().id as string;
    const res = await app.inject({
      method: "PATCH",
      url: `/web/elements/${id}`,
      payload: { name: "no good!" },
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── Upload media ──────────────────────────────────────────────────────────────

describe("POST /web/elements/:id/media", () => {
  it("uploads an image and returns its metadata", async () => {
    const { accessToken } = await createTestUser();
    const id = (await createElement(app, accessToken, "withpic")).json().id as string;

    const res = await uploadImage(app, accessToken, id, PNG);
    expect(res.statusCode).toBe(200);
    const media = res.json() as ElementMedia;
    expect(media).toMatchObject({ name: "ref.png", mimeType: "image/png" });
    expect(media.s3Key).toMatch(new RegExp(`^elements/\\d+/${id}/`));
    expect(media.url).toBe(`https://s3.test/${media.s3Key}`);

    // Картинка видна внутри элемента.
    const list = await app.inject({
      method: "GET",
      url: "/web/elements",
      headers: bearer(accessToken),
    });
    const el = (list.json().items as Element[]).find((e) => e.id === id)!;
    expect(el.media).toHaveLength(1);
    expect(el.media[0].id).toBe(media.id);
  });

  it("rejects a non-image file with 415", async () => {
    const { accessToken } = await createTestUser();
    const id = (await createElement(app, accessToken, "novideo")).json().id as string;
    const res = await uploadImage(app, accessToken, id, {
      value: MP4_BYTES,
      filename: "clip.mp4",
      contentType: "video/mp4",
    });
    expect(res.statusCode).toBe(415);
  });

  it("returns 404 when uploading into a missing or foreign element", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const id = (await createElement(app, owner.accessToken, "owned")).json().id as string;

    expect((await uploadImage(app, owner.accessToken, "nope", PNG)).statusCode).toBe(404);
    expect((await uploadImage(app, other.accessToken, id, PNG)).statusCode).toBe(404);
  });
});

// ── List ──────────────────────────────────────────────────────────────────────

describe("GET /web/elements", () => {
  it("returns the user's elements newest first", async () => {
    const { accessToken } = await createTestUser();
    await createElement(app, accessToken, "first");
    await createElement(app, accessToken, "second");

    const res = await app.inject({
      method: "GET",
      url: "/web/elements",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Element[];
    expect(items.map((e) => e.name)).toEqual(["second", "first"]);
  });
});

// ── Isolation from the general uploaded-media list (regression) ─────────────────

describe("element media is excluded from /web/uploaded-media", () => {
  it("element images do not leak into the reuse list, chat uploads do", async () => {
    const { accessToken } = await createTestUser();
    const id = (await createElement(app, accessToken, "iso")).json().id as string;
    await uploadImage(app, accessToken, id, PNG);

    // Обычная chat-загрузка — должна попасть в общий список.
    const mp = buildMultipart([
      { name: "file", value: PNG_BYTES, filename: "chat.png", contentType: "image/png" },
    ]);
    await app.inject({
      method: "POST",
      url: "/web/chat-uploads",
      payload: mp.payload,
      headers: { ...mp.headers, ...bearer(accessToken) },
    });

    const res = await app.inject({
      method: "GET",
      url: "/web/uploaded-media",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { s3Key: string; name: string }[];
    // Только chat-upload, картинки элемента нет.
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("chat.png");
    expect(items.every((i) => !i.s3Key.startsWith("elements/"))).toBe(true);
  });
});

// ── Delete media ────────────────────────────────────────────────────────────────

describe("DELETE /web/elements/:id/media/:mediaId", () => {
  it("removes a single image from the element", async () => {
    const { accessToken } = await createTestUser();
    const id = (await createElement(app, accessToken, "delpic")).json().id as string;
    const mediaId = (await uploadImage(app, accessToken, id, PNG)).json().id as string;

    const del = await app.inject({
      method: "DELETE",
      url: `/web/elements/${id}/media/${mediaId}`,
      headers: bearer(accessToken),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ success: true });

    const list = await app.inject({
      method: "GET",
      url: "/web/elements",
      headers: bearer(accessToken),
    });
    const el = (list.json().items as Element[]).find((e) => e.id === id)!;
    expect(el.media).toHaveLength(0);
  });

  it("returns 404 for a missing media id or a foreign user", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const id = (await createElement(app, owner.accessToken, "guard")).json().id as string;
    const mediaId = (await uploadImage(app, owner.accessToken, id, PNG)).json().id as string;

    const missing = await app.inject({
      method: "DELETE",
      url: `/web/elements/${id}/media/does-not-exist`,
      headers: bearer(owner.accessToken),
    });
    expect(missing.statusCode).toBe(404);

    const foreign = await app.inject({
      method: "DELETE",
      url: `/web/elements/${id}/media/${mediaId}`,
      headers: bearer(other.accessToken),
    });
    expect(foreign.statusCode).toBe(404);
  });
});

// ── Delete element ──────────────────────────────────────────────────────────────

describe("DELETE /web/elements/:id", () => {
  it("deletes the element and cascades its media rows", async () => {
    const { accessToken } = await createTestUser();
    const id = (await createElement(app, accessToken, "cascade")).json().id as string;
    const mediaId = (await uploadImage(app, accessToken, id, PNG)).json().id as string;

    const del = await app.inject({
      method: "DELETE",
      url: `/web/elements/${id}`,
      headers: bearer(accessToken),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ success: true });

    // Элемент исчез из списка.
    const list = await app.inject({
      method: "GET",
      url: "/web/elements",
      headers: bearer(accessToken),
    });
    expect((list.json().items as Element[]).some((e) => e.id === id)).toBe(false);

    // Media-строка удалена каскадом по FK.
    expect(await db.uploadedMedia.findUnique({ where: { id: mediaId } })).toBeNull();
  });

  it("returns 404 for a missing or foreign element", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const id = (await createElement(app, owner.accessToken, "protected")).json().id as string;

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/web/elements/does-not-exist",
          headers: bearer(owner.accessToken),
        })
      ).statusCode,
    ).toBe(404);

    const foreign = await app.inject({
      method: "DELETE",
      url: `/web/elements/${id}`,
      headers: bearer(other.accessToken),
    });
    expect(foreign.statusCode).toBe(404);

    // Элемент владельца на месте.
    const list = await app.inject({
      method: "GET",
      url: "/web/elements",
      headers: bearer(owner.accessToken),
    });
    expect((list.json().items as Element[]).some((e) => e.id === id)).toBe(true);
  });
});
