/**
 * Integration tests for packages/api/src/routes/web-gallery.ts.
 *
 * Покрывает 14 эндпоинтов /web/gallery/* через app.inject:
 *  1. auth guard (webTelegramLinkedPreHandler: 401 без токена, 403 для bad
 *     token / web-only без linked telegram);
 *  2. GET /web/gallery — section/modelId/modelIds-фильтры + page/limit
 *     pagination;
 *  3. favoritesFirst — отдельный блок: ordering и cross-page pagination
 *     (web-route всегда передаёт favoritesFirst:true);
 *  4. GET /web/gallery/model-counts;
 *  5. GET /web/gallery/jobs/:id;
 *  6. GET /web/gallery/:id/preview-url (используем outputUrl-fallback, так
 *     как config.api.publicUrl в тест-окружении не задан);
 *  7. GET /web/gallery/outputs/:id/original-url (forceDownload — вызывает
 *     мокнутый getFileUrl с filename);
 *  8. DELETE /web/gallery/jobs/:id — каскад в DB + deleteFile-вызовы;
 *  9. folders CRUD + ограничения на default-папку;
 * 10. folder items add/remove;
 * 11. favorites — auto-create "Избранное"-папки на первом add'е, idempotent
 *     повтор, 404 при remove без существующей default-папки.
 *
 * Ответы валидируются zod-схемами из @metabox/shared-browser/dto — это
 * фиксирует контракт DTO как часть теста: схема меняется → тест краснеет.
 *
 * S3-side-effects (deleteFile, getFileUrl) мокаются на весь файл; URL/упак
 * мок-функций детерминирован для прямых equality-чек.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type {
  GenerationJob as PrismaGenerationJob,
  GalleryFolder as PrismaGalleryFolder,
} from "@prisma/client";
import type * as S3ServiceModule from "../src/services/s3.service.js";

vi.mock("../src/services/s3.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof S3ServiceModule>();
  const fakeUrl = async (key: string): Promise<string> => `https://s3.test/${key}`;
  const noopDelete = async (): Promise<void> => undefined;
  return {
    ...actual,
    getFileUrl: vi.fn(fakeUrl),
    deleteFile: vi.fn(noopDelete),
    s3Service: {
      ...actual.s3Service,
      getFileUrl: vi.fn(fakeUrl),
      deleteFile: vi.fn(noopDelete),
    },
  };
});

import {
  galleryFavoritesResponseSchema,
  galleryFolderSchema,
  galleryJobSchema,
  galleryListResponseSchema,
  galleryModelCountSchema,
  galleryUrlResponseSchema,
} from "@metabox/shared-browser/dto";
import { buildTestApp } from "./helpers/build-app.js";
import { db } from "./helpers/db.js";
import { bearer, createTestUser } from "./fixtures/users.js";
import { deleteFile, getFileUrl } from "../src/services/s3.service.js";

// ── Helpers ────────────────────────────────────────────────────────────────

interface SeedOutput {
  outputUrl?: string | null;
  s3Key?: string | null;
  thumbnailS3Key?: string | null;
  index?: number;
}

interface SeedJobOverrides {
  modelId?: string;
  section?: string;
  prompt?: string;
  status?: string;
  completedAt?: Date;
  outputs?: SeedOutput[];
}

/**
 * Insert a completed GenerationJob with optional nested outputs. Defaults
 * mirror a "happy" image-job that gallery.service.ts will accept (status
 * "done" — фильтр в listJobs/getJobById).
 */
async function seedJob(
  userId: bigint,
  overrides: SeedJobOverrides = {},
): Promise<PrismaGenerationJob> {
  const {
    modelId = "test-model-a",
    section = "image",
    prompt = `prompt-${Math.random().toString(36).slice(2, 8)}`,
    status = "done",
    completedAt = new Date(),
    outputs,
  } = overrides;

  return db.generationJob.create({
    data: {
      userId,
      dialogId: "test-dialog",
      section,
      modelId,
      status,
      prompt,
      completedAt,
      ...(outputs
        ? {
            outputs: {
              create: outputs.map((o, i) => ({
                index: o.index ?? i,
                outputUrl: o.outputUrl ?? `https://provider.test/${i}.png`,
                s3Key: o.s3Key ?? null,
                thumbnailS3Key: o.thumbnailS3Key ?? null,
              })),
            },
          }
        : {}),
    },
  });
}

interface SeedFolderOverrides {
  name?: string;
  isDefault?: boolean;
  isPinned?: boolean;
}

async function seedFolder(
  userId: bigint,
  overrides: SeedFolderOverrides = {},
): Promise<PrismaGalleryFolder> {
  return db.galleryFolder.create({
    data: {
      userId,
      name: overrides.name ?? "Test folder",
      isDefault: overrides.isDefault ?? false,
      isPinned: overrides.isPinned ?? false,
    },
  });
}

async function seedUserAndAuth(): Promise<{
  aibUserId: bigint;
  headers: { Authorization: string };
}> {
  const { user, accessToken } = await createTestUser({ withTelegram: true });
  if (user.id === null) throw new Error("createTestUser({withTelegram:true}) returned null id");
  return { aibUserId: user.id, headers: bearer(accessToken) };
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

// ── 1. Auth guard ──────────────────────────────────────────────────────────

describe("web-gallery: auth guard (GET /web/gallery)", () => {
  it("returns 401 without an Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/web/gallery" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for an invalid Bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/web/gallery",
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    // Bad-token decode проваливается в auth-hook'е раньше, чем
    // webTelegramLinkedPreHandler сможет ответить 403, → 401.
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for a web-only user without linked Telegram", async () => {
    const { accessToken } = await createTestUser({ withTelegram: false });
    const res = await app.inject({
      method: "GET",
      url: "/web/gallery",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── 2. GET /web/gallery — listJobs ─────────────────────────────────────────

describe("web-gallery: GET /web/gallery", () => {
  it("returns an empty page for a user with no jobs", async () => {
    const { headers } = await seedUserAndAuth();
    const res = await app.inject({ method: "GET", url: "/web/gallery", headers });
    expect(res.statusCode).toBe(200);
    const body = galleryListResponseSchema.parse(res.json());
    expect(body).toEqual({ items: [], total: 0, page: 1, limit: 20 });
  });

  it("filters by section", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    await Promise.all([
      seedJob(aibUserId, { section: "image", prompt: "i-1" }),
      seedJob(aibUserId, { section: "image", prompt: "i-2" }),
      seedJob(aibUserId, { section: "image", prompt: "i-3" }),
      seedJob(aibUserId, { section: "video", prompt: "v-1" }),
      seedJob(aibUserId, { section: "video", prompt: "v-2" }),
    ]);

    const all = await app.inject({ method: "GET", url: "/web/gallery", headers });
    expect(all.statusCode).toBe(200);
    expect(galleryListResponseSchema.parse(all.json()).total).toBe(5);

    const video = await app.inject({
      method: "GET",
      url: "/web/gallery?section=video",
      headers,
    });
    expect(video.statusCode).toBe(200);
    const videoBody = galleryListResponseSchema.parse(video.json());
    expect(videoBody.items).toHaveLength(2);
    for (const item of videoBody.items) expect(item.section).toBe("video");
  });

  it("filters by modelId and modelIds (comma-separated)", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    await Promise.all([
      seedJob(aibUserId, { modelId: "model-a", prompt: "a-1" }),
      seedJob(aibUserId, { modelId: "model-a", prompt: "a-2" }),
      seedJob(aibUserId, { modelId: "model-b", prompt: "b-1" }),
      seedJob(aibUserId, { modelId: "model-c", prompt: "c-1" }),
    ]);

    const singleRes = await app.inject({
      method: "GET",
      url: "/web/gallery?modelId=model-a",
      headers,
    });
    const single = galleryListResponseSchema.parse(singleRes.json());
    expect(single.items).toHaveLength(2);
    for (const item of single.items) expect(item.modelId).toBe("model-a");

    const multiRes = await app.inject({
      method: "GET",
      url: "/web/gallery?modelIds=model-a,model-b",
      headers,
    });
    const multi = galleryListResponseSchema.parse(multiRes.json());
    expect(multi.items).toHaveLength(3);
    for (const item of multi.items) expect(["model-a", "model-b"]).toContain(item.modelId);
  });

  it("paginates with page + limit", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    // Разный completedAt — чтобы порядок был детерминированный.
    for (let i = 0; i < 5; i++) {
      await seedJob(aibUserId, {
        prompt: `p-${i}`,
        completedAt: new Date(2026, 0, i + 1),
      });
    }

    const page1Res = await app.inject({
      method: "GET",
      url: "/web/gallery?page=1&limit=2",
      headers,
    });
    expect(page1Res.statusCode).toBe(200);
    const page1 = galleryListResponseSchema.parse(page1Res.json());
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.page).toBe(1);
    expect(page1.limit).toBe(2);

    const page2Res = await app.inject({
      method: "GET",
      url: "/web/gallery?page=2&limit=2",
      headers,
    });
    const page2 = galleryListResponseSchema.parse(page2Res.json());
    expect(page2.items).toHaveLength(2);
    expect(page2.total).toBe(5);

    const overlap = page1.items
      .map((i) => i.id)
      .filter((id) => page2.items.some((p) => p.id === id));
    expect(overlap).toEqual([]);
  });
});

// ── 3. favoritesFirst ordering ─────────────────────────────────────────────

describe("web-gallery: favoritesFirst (always on for web-route)", () => {
  it("places favorite jobs ahead of newer non-favorites", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    // 4 job'а, у каждого свой completedAt. Берём в favorites два *более
    // старых* — favoritesFirst должен поднять их над более свежими.
    const oldFav1 = await seedJob(aibUserId, {
      prompt: "old-fav-1",
      completedAt: new Date(2026, 0, 1),
    });
    const oldFav2 = await seedJob(aibUserId, {
      prompt: "old-fav-2",
      completedAt: new Date(2026, 0, 2),
    });
    const newPlain1 = await seedJob(aibUserId, {
      prompt: "new-plain-1",
      completedAt: new Date(2026, 0, 10),
    });
    const newPlain2 = await seedJob(aibUserId, {
      prompt: "new-plain-2",
      completedAt: new Date(2026, 0, 11),
    });

    const favFolder = await seedFolder(aibUserId, { name: "Избранное", isDefault: true });
    await db.galleryFolderItem.createMany({
      data: [
        { folderId: favFolder.id, jobId: oldFav1.id },
        { folderId: favFolder.id, jobId: oldFav2.id },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/web/gallery", headers });
    expect(res.statusCode).toBe(200);
    const body = galleryListResponseSchema.parse(res.json());
    expect(body.total).toBe(4);
    expect(body.items.map((i) => i.id)).toEqual([
      // фавориты сами в completedAt desc внутри favs-блока
      oldFav2.id,
      oldFav1.id,
      // затем не-фавориты в completedAt desc
      newPlain2.id,
      newPlain1.id,
    ]);
  });

  it("paginates across the favorites/non-favorites boundary", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const favs: PrismaGenerationJob[] = [];
    for (let i = 0; i < 3; i++) {
      favs.push(
        await seedJob(aibUserId, {
          prompt: `fav-${i}`,
          completedAt: new Date(2026, 0, i + 1),
        }),
      );
    }
    const plains: PrismaGenerationJob[] = [];
    for (let i = 0; i < 2; i++) {
      plains.push(
        await seedJob(aibUserId, {
          prompt: `plain-${i}`,
          completedAt: new Date(2026, 1, i + 1),
        }),
      );
    }
    const favFolder = await seedFolder(aibUserId, { name: "Избранное", isDefault: true });
    await db.galleryFolderItem.createMany({
      data: favs.map((j) => ({ folderId: favFolder.id, jobId: j.id })),
    });

    const p1 = galleryListResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: "/web/gallery?page=1&limit=2",
          headers,
        })
      ).json(),
    );
    expect(p1.total).toBe(5);
    expect(p1.items).toHaveLength(2);
    // первая страница целиком в favs — два самых свежих fav'а
    const favIds = new Set(favs.map((f) => f.id));
    for (const item of p1.items) expect(favIds.has(item.id)).toBe(true);

    const p2 = galleryListResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: "/web/gallery?page=2&limit=2",
          headers,
        })
      ).json(),
    );
    expect(p2.total).toBe(5);
    expect(p2.items).toHaveLength(2);
    // вторая страница пересекает границу: 1 last fav + 1 first plain
    const plainIds = new Set(plains.map((p) => p.id));
    const onP2Fav = p2.items.filter((i) => favIds.has(i.id));
    const onP2Plain = p2.items.filter((i) => plainIds.has(i.id));
    expect(onP2Fav).toHaveLength(1);
    expect(onP2Plain).toHaveLength(1);
  });
});

// ── 4. GET /web/gallery/model-counts ───────────────────────────────────────

describe("web-gallery: GET /web/gallery/model-counts", () => {
  it("groups completed jobs by modelId, desc by count", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    await Promise.all([
      seedJob(aibUserId, { modelId: "model-a" }),
      seedJob(aibUserId, { modelId: "model-a" }),
      seedJob(aibUserId, { modelId: "model-a" }),
      seedJob(aibUserId, { modelId: "model-b" }),
      seedJob(aibUserId, { modelId: "model-b" }),
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/web/gallery/model-counts",
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = z.array(galleryModelCountSchema).parse(res.json());
    expect(body).toEqual([
      { modelId: "model-a", count: 3 },
      { modelId: "model-b", count: 2 },
    ]);
  });

  it("respects section + folderId filters", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const imgA = await seedJob(aibUserId, { modelId: "model-a", section: "image" });
    await seedJob(aibUserId, { modelId: "model-a", section: "image" });
    await seedJob(aibUserId, { modelId: "model-a", section: "video" });
    const folder = await seedFolder(aibUserId);
    await db.galleryFolderItem.create({
      data: { folderId: folder.id, jobId: imgA.id },
    });

    const bySection = z.array(galleryModelCountSchema).parse(
      (
        await app.inject({
          method: "GET",
          url: "/web/gallery/model-counts?section=video",
          headers,
        })
      ).json(),
    );
    expect(bySection).toEqual([{ modelId: "model-a", count: 1 }]);

    const byFolder = z.array(galleryModelCountSchema).parse(
      (
        await app.inject({
          method: "GET",
          url: `/web/gallery/model-counts?folderId=${folder.id}`,
          headers,
        })
      ).json(),
    );
    expect(byFolder).toEqual([{ modelId: "model-a", count: 1 }]);
  });
});

// ── 5. GET /web/gallery/jobs/:id ───────────────────────────────────────────

describe("web-gallery: GET /web/gallery/jobs/:id", () => {
  it("returns the job + outputs by id", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const job = await seedJob(aibUserId, {
      prompt: "deep-link",
      outputs: [{ outputUrl: "https://provider.test/a.png" }],
    });

    const res = await app.inject({
      method: "GET",
      url: `/web/gallery/jobs/${job.id}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = galleryJobSchema.parse(res.json());
    expect(body.id).toBe(job.id);
    expect(body.prompt).toBe("deep-link");
    expect(body.outputs).toHaveLength(1);
    expect(body.outputs[0]!.outputUrl).toBe("https://provider.test/a.png");
  });

  it("returns 404 for unknown id", async () => {
    const { headers } = await seedUserAndAuth();
    const res = await app.inject({
      method: "GET",
      url: "/web/gallery/jobs/does-not-exist",
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── 6. GET /web/gallery/:id/preview-url ────────────────────────────────────

describe("web-gallery: GET /web/gallery/:id/preview-url", () => {
  it("returns the outputUrl when s3Key is absent", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const job = await seedJob(aibUserId, {
      outputs: [{ outputUrl: "https://provider.test/preview.png" }],
    });
    const output = await db.generationJobOutput.findFirst({ where: { jobId: job.id } });
    expect(output).not.toBeNull();

    const res = await app.inject({
      method: "GET",
      url: `/web/gallery/${output!.id}/preview-url`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = galleryUrlResponseSchema.parse(res.json());
    expect(body.url).toBe("https://provider.test/preview.png");
  });

  it("returns 404 for an unknown output id", async () => {
    const { headers } = await seedUserAndAuth();
    const res = await app.inject({
      method: "GET",
      url: "/web/gallery/does-not-exist/preview-url",
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── 7. GET /web/gallery/outputs/:id/original-url ───────────────────────────

describe("web-gallery: GET /web/gallery/outputs/:id/original-url", () => {
  it("returns a presigned S3 URL via the mocked getFileUrl", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const job = await seedJob(aibUserId, {
      outputs: [{ s3Key: "prompts/design/orig.png", outputUrl: null }],
    });
    const output = await db.generationJobOutput.findFirst({ where: { jobId: job.id } });
    expect(output).not.toBeNull();

    vi.mocked(getFileUrl).mockClear();
    const res = await app.inject({
      method: "GET",
      url: `/web/gallery/outputs/${output!.id}/original-url`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = galleryUrlResponseSchema.parse(res.json());
    expect(body.url).toBe("https://s3.test/prompts/design/orig.png");
    expect(getFileUrl).toHaveBeenCalledWith("prompts/design/orig.png", "orig.png");
  });

  it("returns 404 for an unknown output id", async () => {
    const { headers } = await seedUserAndAuth();
    const res = await app.inject({
      method: "GET",
      url: "/web/gallery/outputs/does-not-exist/original-url",
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── 8. DELETE /web/gallery/jobs/:id ────────────────────────────────────────

describe("web-gallery: DELETE /web/gallery/jobs/:id", () => {
  it("removes the job, its outputs, and calls deleteFile for each s3 key", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const job = await seedJob(aibUserId, {
      outputs: [
        { s3Key: "out/a.png", thumbnailS3Key: "out/a-thumb.png" },
        { s3Key: "out/b.png", thumbnailS3Key: "out/b-thumb.png" },
      ],
    });

    vi.mocked(deleteFile).mockClear();
    const res = await app.inject({
      method: "DELETE",
      url: `/web/gallery/jobs/${job.id}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const inDb = await db.generationJob.findUnique({ where: { id: job.id } });
    expect(inDb).toBeNull();
    const outputs = await db.generationJobOutput.findMany({ where: { jobId: job.id } });
    expect(outputs).toEqual([]);

    const keysCalled = vi.mocked(deleteFile).mock.calls.map((c) => c[0]);
    expect(new Set(keysCalled)).toEqual(
      new Set(["out/a.png", "out/a-thumb.png", "out/b.png", "out/b-thumb.png"]),
    );
  });

  it("returns 404 for unknown id", async () => {
    const { headers } = await seedUserAndAuth();
    const res = await app.inject({
      method: "DELETE",
      url: "/web/gallery/jobs/does-not-exist",
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── 9. Folders CRUD ────────────────────────────────────────────────────────

describe("web-gallery: folders", () => {
  it("GET /web/gallery/folders returns the user's folders", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    await seedFolder(aibUserId, { name: "Alpha" });
    await seedFolder(aibUserId, { name: "Beta" });

    const res = await app.inject({
      method: "GET",
      url: "/web/gallery/folders",
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = z.array(galleryFolderSchema).parse(res.json());
    expect(body).toHaveLength(2);
    expect(new Set(body.map((f) => f.name))).toEqual(new Set(["Alpha", "Beta"]));
  });

  it("POST /web/gallery/folders creates a new folder", async () => {
    const { headers } = await seedUserAndAuth();
    const res = await app.inject({
      method: "POST",
      url: "/web/gallery/folders",
      headers,
      payload: { name: "My Stuff" },
    });
    expect(res.statusCode).toBe(200);
    const body = galleryFolderSchema.parse(res.json());
    expect(body.name).toBe("My Stuff");
    expect(body.isDefault).toBe(false);
    expect(body.itemCount).toBe(0);

    const inDb = await db.galleryFolder.findUnique({ where: { id: body.id } });
    expect(inDb?.name).toBe("My Stuff");
  });

  it("POST /web/gallery/folders rejects empty name with 400", async () => {
    const { headers } = await seedUserAndAuth();
    const res = await app.inject({
      method: "POST",
      url: "/web/gallery/folders",
      headers,
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH /web/gallery/folders/:id renames and pins a folder", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const folder = await seedFolder(aibUserId, { name: "Old name" });

    const res = await app.inject({
      method: "PATCH",
      url: `/web/gallery/folders/${folder.id}`,
      headers,
      payload: { name: "New name", isPinned: true },
    });
    expect(res.statusCode).toBe(200);
    const body = galleryFolderSchema.parse(res.json());
    expect(body.name).toBe("New name");
    expect(body.isPinned).toBe(true);
    expect(body.pinnedAt).not.toBeNull();
  });

  it("PATCH on default folder with a new name returns 400", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const fav = await seedFolder(aibUserId, { name: "Избранное", isDefault: true });

    const res = await app.inject({
      method: "PATCH",
      url: `/web/gallery/folders/${fav.id}`,
      headers,
      payload: { name: "Renamed" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("DELETE /web/gallery/folders/:id removes a normal folder", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const folder = await seedFolder(aibUserId, { name: "Trashable" });

    const res = await app.inject({
      method: "DELETE",
      url: `/web/gallery/folders/${folder.id}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const inDb = await db.galleryFolder.findUnique({ where: { id: folder.id } });
    expect(inDb).toBeNull();
  });

  it("DELETE on default folder returns 400", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const fav = await seedFolder(aibUserId, { name: "Избранное", isDefault: true });

    const res = await app.inject({
      method: "DELETE",
      url: `/web/gallery/folders/${fav.id}`,
      headers,
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── 10. Folder items ───────────────────────────────────────────────────────

describe("web-gallery: folder items", () => {
  it("POST /web/gallery/folders/:folderId/items adds a job", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const folder = await seedFolder(aibUserId);
    const job = await seedJob(aibUserId);

    const res = await app.inject({
      method: "POST",
      url: `/web/gallery/folders/${folder.id}/items`,
      headers,
      payload: { jobId: job.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const item = await db.galleryFolderItem.findUnique({
      where: { folderId_jobId: { folderId: folder.id, jobId: job.id } },
    });
    expect(item).not.toBeNull();
  });

  it("DELETE /web/gallery/folders/:folderId/items/:jobId removes a job", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const folder = await seedFolder(aibUserId);
    const job = await seedJob(aibUserId);
    await db.galleryFolderItem.create({
      data: { folderId: folder.id, jobId: job.id },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/web/gallery/folders/${folder.id}/items/${job.id}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const item = await db.galleryFolderItem.findUnique({
      where: { folderId_jobId: { folderId: folder.id, jobId: job.id } },
    });
    expect(item).toBeNull();
  });
});

// ── 11. Favorites ──────────────────────────────────────────────────────────

describe("web-gallery: favorites", () => {
  it("POST /web/gallery/favorites auto-creates the default 'Избранное' folder", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const job = await seedJob(aibUserId);

    const res = await app.inject({
      method: "POST",
      url: "/web/gallery/favorites",
      headers,
      payload: { jobId: job.id },
    });
    expect(res.statusCode).toBe(200);
    const body = galleryFavoritesResponseSchema.parse(res.json());
    expect(body.folderId).toBeTruthy();

    const fav = await db.galleryFolder.findUnique({ where: { id: body.folderId } });
    expect(fav).not.toBeNull();
    expect(fav!.isDefault).toBe(true);
    expect(fav!.name).toBe("Избранное");
    expect(fav!.userId).toBe(aibUserId);

    const link = await db.galleryFolderItem.findUnique({
      where: { folderId_jobId: { folderId: body.folderId, jobId: job.id } },
    });
    expect(link).not.toBeNull();
  });

  it("a second POST with the same jobId is idempotent (upsert, same folderId)", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const job = await seedJob(aibUserId);

    const first = galleryFavoritesResponseSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: "/web/gallery/favorites",
          headers,
          payload: { jobId: job.id },
        })
      ).json(),
    );
    const second = galleryFavoritesResponseSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: "/web/gallery/favorites",
          headers,
          payload: { jobId: job.id },
        })
      ).json(),
    );
    expect(second.folderId).toBe(first.folderId);

    // одна и только одна default-папка
    const favCount = await db.galleryFolder.count({
      where: { userId: aibUserId, isDefault: true },
    });
    expect(favCount).toBe(1);
  });

  it("DELETE /web/gallery/favorites/:jobId returns 404 when no favorites folder exists", async () => {
    const { aibUserId, headers } = await seedUserAndAuth();
    const job = await seedJob(aibUserId);

    const res = await app.inject({
      method: "DELETE",
      url: `/web/gallery/favorites/${job.id}`,
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});
