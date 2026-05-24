/**
 * Integration tests for packages/api/src/routes/web-prompts.ts.
 *
 * Покрывает три блока:
 *  1. admin-guard auth (Bearer JWT path: ADMIN/MODERATOR pass, остальные 401/403);
 *  2. public GET /web/prompts (pagination + section filter + s3Key hidden);
 *  3. admin CRUD + POST /admin/prompts/uploads (happy path с мокнутым S3).
 *
 * Ответы валидируются zod-схемами из `@metabox/shared-browser/dto` — это
 * фиксирует контракт DTO как часть теста: схема меняется → тест краснеет.
 *
 * S3 в тестовом окружении не сконфигурирован, поэтому `uploadBuffer` /
 * `getFileUrl` / `s3Service.getFileUrl` мокаются на весь файл.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PromptExample as PrismaPromptExample } from "@prisma/client";
import type * as S3ServiceModule from "../src/services/s3.service.js";

vi.mock("../src/services/s3.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof S3ServiceModule>();
  const fakeUrl = async (key: string): Promise<string> => `https://s3.test/${key}`;
  const fakeUpload = async (key: string): Promise<string> => key;
  return {
    ...actual,
    uploadBuffer: vi.fn(fakeUpload),
    getFileUrl: vi.fn(fakeUrl),
    s3Service: {
      ...actual.s3Service,
      uploadBuffer: vi.fn(fakeUpload),
      getFileUrl: vi.fn(fakeUrl),
    },
  };
});

import { AI_MODELS } from "@metabox/shared";
import {
  adminPromptsModelsResponseSchema,
  promptExampleSchema,
  promptExamplesPageSchema,
  type CreatePromptExampleBody,
  type UpdatePromptExampleBody,
} from "@metabox/shared-browser/dto";
import { buildTestApp } from "./helpers/build-app.js";
import { db } from "./helpers/db.js";
import { bearer, createTestUser } from "./fixtures/users.js";
import { buildMultipart, MP4_BYTES, PNG_BYTES } from "./fixtures/multipart.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function pickModelId(section: "design" | "video"): string {
  const m = Object.values(AI_MODELS).find((x) => x.section === section);
  if (!m) throw new Error(`No AI_MODELS with section=${section} — fixtures stale`);
  return m.id;
}

interface SeedOverrides {
  modelId?: string;
  prompt?: string;
  section?: "design" | "video";
  mediaS3Key?: string | null;
  thumbnailS3Key?: string | null;
  modelSettings?: unknown;
}

/**
 * Seed одной строки PromptExample напрямую через Prisma. Все поля
 * имеют разумные дефолты — если в тесте важно конкретное значение, передай
 * через `overrides`.
 */
async function seedPromptExample(overrides: SeedOverrides = {}): Promise<PrismaPromptExample> {
  const section = overrides.section ?? "design";
  return db.promptExample.create({
    data: {
      modelId: overrides.modelId ?? pickModelId(section),
      prompt: overrides.prompt ?? `prompt-${randomUUID().slice(0, 8)}`,
      section,
      mediaS3Key: overrides.mediaS3Key ?? null,
      thumbnailS3Key: overrides.thumbnailS3Key ?? null,
      ...(overrides.modelSettings !== undefined
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { modelSettings: overrides.modelSettings as any }
        : {}),
    },
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// ── 1. Admin auth guard ────────────────────────────────────────────────────

describe("web-prompts: admin auth guard (GET /admin/prompts)", () => {
  it("returns 401 with no Authorization header (delegated to telegram-auth)", async () => {
    // Без Bearer-токена admin-preHandler делегирует проверку telegramAuthHook,
    // который без initData/wtoken отвечает 401 — наш 403-фолбэк не доходит.
    const res = await app.inject({ method: "GET", url: "/admin/prompts" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for an invalid Bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/prompts",
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 for a web-only user without linked Telegram", async () => {
    const { accessToken } = await createTestUser({ withTelegram: false });
    const res = await app.inject({
      method: "GET",
      url: "/admin/prompts",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 for a USER role", async () => {
    const { accessToken } = await createTestUser({ role: "USER" });
    const res = await app.inject({
      method: "GET",
      url: "/admin/prompts",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 200 for an ADMIN role", async () => {
    const { accessToken } = await createTestUser({ role: "ADMIN" });
    const res = await app.inject({
      method: "GET",
      url: "/admin/prompts",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 200 for a MODERATOR role", async () => {
    const { accessToken } = await createTestUser({ role: "MODERATOR" });
    const res = await app.inject({
      method: "GET",
      url: "/admin/prompts",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
  });
});

// ── 2. Public GET /web/prompts ─────────────────────────────────────────────

describe("web-prompts: GET /web/prompts (public)", () => {
  it("returns an empty page when DB is empty (no auth required)", async () => {
    const res = await app.inject({ method: "GET", url: "/web/prompts" });
    expect(res.statusCode).toBe(200);
    const body = promptExamplesPageSchema.parse(res.json());
    expect(body).toEqual({ items: [], nextCursor: null });
  });

  it("returns several synthetic examples seeded directly into the DB", async () => {
    const designId = pickModelId("design");
    const videoId = pickModelId("video");
    // Пачка синтетических данных: 3 design + 2 video, у части есть медиа.
    const seeded = [
      await seedPromptExample({
        modelId: designId,
        prompt: "minimalist poster of a cat",
        section: "design",
        mediaS3Key: "prompts/design/seed-1.png",
        thumbnailS3Key: "prompts/design/seed-1-thumb.png",
      }),
      await seedPromptExample({
        modelId: designId,
        prompt: "isometric tiny office",
        section: "design",
      }),
      await seedPromptExample({
        modelId: designId,
        prompt: "soft pastel landscape",
        section: "design",
        mediaS3Key: "prompts/design/seed-3.png",
      }),
      await seedPromptExample({
        modelId: videoId,
        prompt: "looping cyberpunk alley",
        section: "video",
        mediaS3Key: "prompts/video/seed-4.mp4",
        thumbnailS3Key: "prompts/video/seed-4-thumb.png",
      }),
      await seedPromptExample({
        modelId: videoId,
        prompt: "slow zoom on a forest",
        section: "video",
      }),
    ];

    const res = await app.inject({ method: "GET", url: "/web/prompts" });
    expect(res.statusCode).toBe(200);
    const body = promptExamplesPageSchema.parse(res.json());

    expect(body.items).toHaveLength(seeded.length);
    expect(body.nextCursor).toBeNull();

    // Сортировка по id desc (сервис сортирует именно так).
    const ids = body.items.map((i) => i.id);
    expect([...ids].sort().reverse()).toEqual(ids);

    // Все promt'ы вернулись — порядок не критичен.
    const promptsReturned = new Set(body.items.map((i) => i.prompt));
    for (const s of seeded) expect(promptsReturned.has(s.prompt)).toBe(true);

    // mediaUrl/thumbnailUrl у записи с ключами — детерминированный fake-url.
    const withMedia = body.items.find((i) => i.prompt === "minimalist poster of a cat")!;
    expect(withMedia.mediaUrl).toBe("https://s3.test/prompts/design/seed-1.png");
    expect(withMedia.thumbnailUrl).toBe("https://s3.test/prompts/design/seed-1-thumb.png");
    // s3-ключи — admin-only, в публичном листинге их быть не должно.
    for (const item of body.items) {
      expect(item.mediaS3Key).toBeUndefined();
      expect(item.thumbnailS3Key).toBeUndefined();
    }

    // model.id у каждого item совпадает с modelId сидинга.
    const designItem = body.items.find((i) => i.prompt === "isometric tiny office")!;
    expect(designItem.model?.id).toBe(designId);
    const videoItem = body.items.find((i) => i.prompt === "slow zoom on a forest")!;
    expect(videoItem.model?.id).toBe(videoId);
  });

  it("filters by section", async () => {
    await seedPromptExample({ prompt: "d-1", section: "design" });
    await seedPromptExample({ prompt: "d-2", section: "design" });
    await seedPromptExample({ prompt: "v-1", section: "video" });

    const res = await app.inject({ method: "GET", url: "/web/prompts?section=video" });
    expect(res.statusCode).toBe(200);
    const body = promptExamplesPageSchema.parse(res.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.prompt).toBe("v-1");
    expect(body.items[0]!.section).toBe("video");
  });

  it("paginates with take + cursor", async () => {
    await seedPromptExample({ prompt: "p1" });
    await seedPromptExample({ prompt: "p2" });
    await seedPromptExample({ prompt: "p3" });

    const first = await app.inject({ method: "GET", url: "/web/prompts?take=2" });
    expect(first.statusCode).toBe(200);
    const firstBody = promptExamplesPageSchema.parse(first.json());
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).toBeTruthy();

    const second = await app.inject({
      method: "GET",
      url: `/web/prompts?take=2&cursor=${firstBody.nextCursor}`,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = promptExamplesPageSchema.parse(second.json());
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.nextCursor).toBeNull();

    const firstIds = new Set(firstBody.items.map((i) => i.id));
    for (const it of secondBody.items) expect(firstIds.has(it.id)).toBe(false);
  });

  it("returns 400 for invalid take (out of range)", async () => {
    const res = await app.inject({ method: "GET", url: "/web/prompts?take=999" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for non-numeric take", async () => {
    const res = await app.inject({ method: "GET", url: "/web/prompts?take=abc" });
    expect(res.statusCode).toBe(400);
  });
});

// ── 3. Admin CRUD ──────────────────────────────────────────────────────────

describe("web-prompts: admin CRUD", () => {
  async function asAdmin(): Promise<{ Authorization: string }> {
    const { accessToken } = await createTestUser({ role: "ADMIN" });
    return bearer(accessToken);
  }

  it("GET /admin/prompts returns the models catalog (design+video only)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/prompts",
      headers: await asAdmin(),
    });
    expect(res.statusCode).toBe(200);
    const body = adminPromptsModelsResponseSchema.parse(res.json());
    expect(body.models.length).toBeGreaterThan(0);
    for (const m of body.models) {
      expect(["design", "video"]).toContain(m.section);
    }
  });

  it("GET /admin/prompts/:id returns the example with s3Keys", async () => {
    const created = await seedPromptExample({
      prompt: "with-media",
      mediaS3Key: "prompts/design/m.png",
      thumbnailS3Key: "prompts/design/t.png",
    });

    const res = await app.inject({
      method: "GET",
      url: `/admin/prompts/${created.id}`,
      headers: await asAdmin(),
    });
    expect(res.statusCode).toBe(200);
    const body = promptExampleSchema.parse(res.json());
    expect(body.id).toBe(created.id);
    expect(body.mediaS3Key).toBe("prompts/design/m.png");
    expect(body.thumbnailS3Key).toBe("prompts/design/t.png");
    expect(body.mediaUrl).toBe("https://s3.test/prompts/design/m.png");
    expect(body.thumbnailUrl).toBe("https://s3.test/prompts/design/t.png");
  });

  it("GET /admin/prompts/:id returns 404 for missing id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/prompts/does-not-exist",
      headers: await asAdmin(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Prompt example not found" });
  });

  it("POST /admin/prompts creates a new example", async () => {
    const designId = pickModelId("design");
    const payload: CreatePromptExampleBody = {
      modelId: designId,
      prompt: "freshly created",
      section: "design",
      mediaS3Key: "prompts/design/new.png",
    };

    const res = await app.inject({
      method: "POST",
      url: "/admin/prompts",
      headers: await asAdmin(),
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = promptExampleSchema.parse(res.json());
    expect(body.prompt).toBe(payload.prompt);
    expect(body.section).toBe("design");
    expect(body.mediaS3Key).toBe(payload.mediaS3Key);
    expect(body.model?.id).toBe(designId);

    const inDb = await db.promptExample.findUnique({ where: { id: body.id } });
    expect(inDb?.prompt).toBe(payload.prompt);
  });

  it("POST /admin/prompts rejects empty prompt with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/prompts",
      headers: await asAdmin(),
      payload: { modelId: pickModelId("design"), prompt: "", section: "design" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /admin/prompts rejects missing section with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/prompts",
      headers: await asAdmin(),
      payload: { modelId: pickModelId("design"), prompt: "hi" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /admin/prompts/:id updates fields", async () => {
    const created = await seedPromptExample({
      prompt: "before",
      mediaS3Key: "prompts/design/old.png",
    });
    const payload: UpdatePromptExampleBody = { prompt: "after", mediaS3Key: null };

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/prompts/${created.id}`,
      headers: await asAdmin(),
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = promptExampleSchema.parse(res.json());
    expect(body.prompt).toBe("after");
    expect(body.mediaS3Key).toBeNull();

    const inDb = await db.promptExample.findUnique({ where: { id: created.id } });
    expect(inDb?.prompt).toBe("after");
    expect(inDb?.mediaS3Key).toBeNull();
  });

  it("PATCH /admin/prompts/:id returns 404 for missing id", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/prompts/does-not-exist",
      headers: await asAdmin(),
      payload: { prompt: "x" } satisfies UpdatePromptExampleBody,
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /admin/prompts/:id deletes the example", async () => {
    const created = await seedPromptExample({ prompt: "to-delete" });

    const res = await app.inject({
      method: "DELETE",
      url: `/admin/prompts/${created.id}`,
      headers: await asAdmin(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const inDb = await db.promptExample.findUnique({ where: { id: created.id } });
    expect(inDb).toBeNull();
  });

  it("DELETE /admin/prompts/:id returns 404 for missing id", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/admin/prompts/does-not-exist",
      headers: await asAdmin(),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── 4. Multipart upload ────────────────────────────────────────────────────

describe("web-prompts: POST /admin/prompts/uploads", () => {
  async function asAdmin(): Promise<{ Authorization: string }> {
    const { accessToken } = await createTestUser({ role: "ADMIN" });
    return bearer(accessToken);
  }

  it("happy path: uploads a PNG to design/media and returns s3Key + url", async () => {
    const mp = buildMultipart([
      { name: "section", value: "design" },
      { name: "kind", value: "media" },
      { name: "file", value: PNG_BYTES, filename: "x.png", contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/admin/prompts/uploads",
      headers: { ...(await asAdmin()), ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      s3Key: string;
      url: string | null;
      mimeType: string;
      size: number;
    };
    expect(body.s3Key).toMatch(/^prompts\/design\/[a-f0-9-]+\.png$/);
    expect(body.url).toBe(`https://s3.test/${body.s3Key}`);
    expect(body.mimeType).toBe("image/png");
    expect(body.size).toBe(PNG_BYTES.byteLength);
  });

  it("returns 400 when no file is attached", async () => {
    const mp = buildMultipart([
      { name: "section", value: "design" },
      { name: "kind", value: "media" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/admin/prompts/uploads",
      headers: { ...(await asAdmin()), ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when section is missing", async () => {
    const mp = buildMultipart([
      { name: "kind", value: "media" },
      { name: "file", value: PNG_BYTES, filename: "x.png", contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/admin/prompts/uploads",
      headers: { ...(await asAdmin()), ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "BAD_SECTION" });
  });

  it("returns 400 when kind is missing", async () => {
    const mp = buildMultipart([
      { name: "section", value: "design" },
      { name: "file", value: PNG_BYTES, filename: "x.png", contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/admin/prompts/uploads",
      headers: { ...(await asAdmin()), ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "BAD_KIND" });
  });

  it("returns 415 for unsupported mime type", async () => {
    const mp = buildMultipart([
      { name: "section", value: "design" },
      { name: "kind", value: "media" },
      {
        name: "file",
        value: Buffer.from("PK\x03\x04"),
        filename: "x.zip",
        contentType: "application/zip",
      },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/admin/prompts/uploads",
      headers: { ...(await asAdmin()), ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("returns 415 when video mime is sent into the design section", async () => {
    const mp = buildMultipart([
      { name: "section", value: "design" },
      { name: "kind", value: "media" },
      { name: "file", value: MP4_BYTES, filename: "x.mp4", contentType: "video/mp4" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/admin/prompts/uploads",
      headers: { ...(await asAdmin()), ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(415);
  });

  it("accepts a thumbnail image for the video section", async () => {
    const mp = buildMultipart([
      { name: "section", value: "video" },
      { name: "kind", value: "thumbnail" },
      { name: "file", value: PNG_BYTES, filename: "thumb.png", contentType: "image/png" },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/admin/prompts/uploads",
      headers: { ...(await asAdmin()), ...mp.headers },
      payload: mp.payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { s3Key: string };
    expect(body.s3Key).toMatch(/^prompts\/video\/[a-f0-9-]+\.png$/);
  });
});
