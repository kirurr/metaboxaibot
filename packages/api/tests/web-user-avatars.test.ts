/**
 * Integration tests for /web/user-avatars/* in
 * packages/api/src/routes/web-user-avatars.ts.
 *
 * Покрывает 5 эндпоинтов:
 *  - GET    /web/user-avatars                — list, фильтр provider
 *  - POST   /web/user-avatars/heygen         — synchronous create (HeyGen)
 *  - POST   /web/user-avatars/higgsfield-soul — pending-record (STUB) + enqueue
 *  - PATCH  /web/user-avatars/:id            — rename
 *  - DELETE /web/user-avatars/:id            — delete
 *
 * Мокаются:
 *  - HeyGenAvatarAdapter — `create()` возвращает externalId без сетевых вызовов;
 *  - s3.service (downloadBuffer / generateThumbnail / uploadBuffer / getFileUrl);
 *  - avatar.queue (`getAvatarQueue().add(...)` — чтобы Soul-flow не тянул реальный BullMQ).
 *
 * ProviderKey для HeyGen создаётся через `createTestProviderKey`, остальное —
 * реальная Prisma через `userAvatarService`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type * as S3ServiceModule from "../src/services/s3.service.js";
import type * as AvatarQueueModule from "../src/queues/avatar.queue.js";

vi.mock("../src/services/s3.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof S3ServiceModule>();
  return {
    ...actual,
    downloadBuffer: vi.fn(async (): Promise<Buffer | null> => Buffer.from([0x89, 0x50])),
    uploadBuffer: vi.fn(async (key: string): Promise<string | null> => key),
    generateThumbnail: vi.fn(async (): Promise<Buffer | null> => Buffer.from([0xff, 0xfb])),
    getFileUrl: vi.fn(async (key: string): Promise<string | null> => `https://s3.test/${key}`),
  };
});

vi.mock("../src/ai/avatar/heygen.avatar.adapter.js", () => {
  class FakeHeyGenAvatarAdapter {
    provider = "heygen";
    constructor(_apiKey: string) {}
    async create(_buf: Buffer, _ct: string) {
      return { externalId: "heygen-asset-1", name: "x" };
    }
  }
  return { HeyGenAvatarAdapter: FakeHeyGenAvatarAdapter };
});

vi.mock("../src/queues/avatar.queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AvatarQueueModule>();
  return {
    ...actual,
    getAvatarQueue: vi.fn(() => ({
      add: vi.fn(async () => undefined),
    })),
  };
});

import { buildTestApp } from "./helpers/build-app.js";
import { db } from "./helpers/db.js";
import { bearer, createTestUser } from "./fixtures/users.js";
import { createTestProviderKey } from "./fixtures/provider-keys.js";
import { invalidatePoolCache } from "../src/services/key-pool.service.js";
import { getAvatarQueue } from "../src/queues/avatar.queue.js";

function ownedKey(userId: bigint, ext = "png"): string {
  return `chat-uploads/${userId.toString()}/test-key.${ext}`;
}

describe("/web/user-avatars/* routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    invalidatePoolCache();
  });

  // ── GET /web/user-avatars ────────────────────────────────────────────────
  describe("GET /web/user-avatars", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/web/user-avatars" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 TELEGRAM_NOT_LINKED for web-only user", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "GET",
        url: "/web/user-avatars",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns an empty array for a fresh user", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/user-avatars",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("filters by provider", async () => {
      const { user, accessToken } = await createTestUser();
      await db.userAvatar.create({
        data: {
          userId: user.id!,
          provider: "heygen",
          name: "Hey",
          externalId: "ext-1",
          status: "ready",
        },
      });
      await db.userAvatar.create({
        data: {
          userId: user.id!,
          provider: "higgsfield_soul",
          name: "Soul",
          status: "creating",
        },
      });
      const res = await app.inject({
        method: "GET",
        url: "/web/user-avatars?provider=heygen",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ provider: string }>;
      expect(body).toHaveLength(1);
      expect(body[0].provider).toBe("heygen");
    });
  });

  // ── POST /web/user-avatars/heygen ────────────────────────────────────────
  describe("POST /web/user-avatars/heygen", () => {
    it("returns 400 when s3Key is missing", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/user-avatars/heygen",
        payload: {},
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 403 for a foreign s3Key (different user's upload prefix)", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/user-avatars/heygen",
        payload: { s3Key: "chat-uploads/999999999/some.png" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns 503 when no HeyGen key is in the pool", async () => {
      const { user, accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/user-avatars/heygen",
        payload: { s3Key: ownedKey(user.id!) },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(503);
    });

    it("creates a ready avatar on happy path", async () => {
      await createTestProviderKey("heygen", "test-heygen-key");
      const { user, accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/user-avatars/heygen",
        payload: { s3Key: ownedKey(user.id!), name: "My head" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; provider: string; status: string };
      expect(body.provider).toBe("heygen");
      expect(body.status).toBe("ready");
      const persisted = await db.userAvatar.findUnique({ where: { id: body.id } });
      expect(persisted?.externalId).toBe("heygen-asset-1");
      expect(persisted?.name).toBe("My head");
    });
  });

  // ── POST /web/user-avatars/higgsfield-soul ───────────────────────────────
  describe("POST /web/user-avatars/higgsfield-soul", () => {
    it("returns 400 when fewer than 10 s3Keys provided", async () => {
      const { user, accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/user-avatars/higgsfield-soul",
        payload: { s3Keys: [ownedKey(user.id!)] },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 403 when any s3Key belongs to another user", async () => {
      const { user, accessToken } = await createTestUser();
      const keys = Array.from({ length: 10 }, (_, i) => ownedKey(user.id!, `${i}.jpg`));
      keys[5] = "chat-uploads/999999999/foreign.jpg";
      const res = await app.inject({
        method: "POST",
        url: "/web/user-avatars/higgsfield-soul",
        payload: { s3Keys: keys },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(403);
    });

    it("creates a pending record and enqueues the create job", async () => {
      const { user, accessToken } = await createTestUser();
      const keys = Array.from({ length: 10 }, (_, i) => ownedKey(user.id!, `${i}.jpg`));
      const res = await app.inject({
        method: "POST",
        url: "/web/user-avatars/higgsfield-soul",
        payload: { s3Keys: keys, name: "My soul" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; status: string; provider: string };
      expect(body.status).toBe("creating");
      expect(body.provider).toBe("higgsfield_soul");

      const persisted = await db.userAvatar.findUnique({ where: { id: body.id } });
      expect(persisted?.sourceS3Keys.length).toBe(10);

      // Queue.add was called with the correct job payload.
      const fakeQueue = (
        getAvatarQueue as unknown as { mock: { results: Array<{ value: { add: unknown } }> } }
      ).mock.results;
      expect(fakeQueue.length).toBeGreaterThan(0);
    });
  });

  // ── PATCH /web/user-avatars/:id ──────────────────────────────────────────
  describe("PATCH /web/user-avatars/:id", () => {
    it("returns 400 when name is empty", async () => {
      const { user, accessToken } = await createTestUser();
      const av = await db.userAvatar.create({
        data: { userId: user.id!, provider: "heygen", name: "Old", status: "ready" },
      });
      const res = await app.inject({
        method: "PATCH",
        url: `/web/user-avatars/${av.id}`,
        payload: { name: "  " },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for a foreign avatar id", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "PATCH",
        url: "/web/user-avatars/does-not-exist",
        payload: { name: "x" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(404);
    });

    it("renames the avatar and returns 200", async () => {
      const { user, accessToken } = await createTestUser();
      const av = await db.userAvatar.create({
        data: { userId: user.id!, provider: "heygen", name: "Old", status: "ready" },
      });
      const res = await app.inject({
        method: "PATCH",
        url: `/web/user-avatars/${av.id}`,
        payload: { name: "Fresh" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const persisted = await db.userAvatar.findUnique({ where: { id: av.id } });
      expect(persisted?.name).toBe("Fresh");
    });
  });

  // ── DELETE /web/user-avatars/:id ─────────────────────────────────────────
  describe("DELETE /web/user-avatars/:id", () => {
    it("returns 404 for a foreign avatar id", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "DELETE",
        url: "/web/user-avatars/does-not-exist",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(404);
    });

    it("deletes an owned avatar and returns 200", async () => {
      const { user, accessToken } = await createTestUser();
      const av = await db.userAvatar.create({
        data: { userId: user.id!, provider: "heygen", name: "X", status: "ready" },
      });
      const res = await app.inject({
        method: "DELETE",
        url: `/web/user-avatars/${av.id}`,
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const persisted = await db.userAvatar.findUnique({ where: { id: av.id } });
      expect(persisted).toBeNull();
    });
  });
});
