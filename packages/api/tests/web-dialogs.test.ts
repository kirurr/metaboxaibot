/**
 * Integration tests for /web/dialogs/* in packages/api/src/routes/web-chat.ts.
 *
 * Покрывает 6 эндпоинтов:
 *  - GET /web/dialogs                — list user dialogs (с/без q/withStats)
 *  - POST /web/dialogs               — create
 *  - PATCH /web/dialogs/:id          — rename (403 чужой, 404 missing, 400 нет title)
 *  - DELETE /web/dialogs/:id         — soft-delete
 *  - GET /web/dialogs/:id/messages   — список сообщений
 *  - POST /web/dialogs/:id/send      — SSE smoke (статус + text/event-stream header)
 *
 * SSE-роут пишет напрямую в `reply.raw`, поэтому `chatService.sendMessageStream`
 * мокается так, чтобы немедленно вернуть один chunk + done. Реальный provider
 * call не запускается.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type * as ChatServiceModule from "../src/services/chat.service.js";

vi.mock("../src/services/chat.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ChatServiceModule>();
  // Mock as async generator that yields one chunk and returns a final
  // SendMessageResult-shaped object — same contract the SSE route expects.
  async function* fakeStream() {
    yield "Hello";
    return {
      tokensUsed: 5,
      inputTokens: 2,
      outputTokens: 3,
      tokenBalance: "100",
      subscriptionTokenBalance: "500",
    };
  }
  return {
    ...actual,
    chatService: {
      ...actual.chatService,
      sendMessageStream: vi.fn(() => fakeStream()),
    },
  };
});

import { buildTestApp } from "./helpers/build-app.js";
import { db } from "./helpers/db.js";
import { bearer, createTestUser } from "./fixtures/users.js";

const IMAGE_MODEL = "flux";
const GPT_MODEL = "claude-sonnet";

async function seedDialog(
  userId: bigint,
  opts: { section?: string; modelId?: string; title?: string } = {},
): Promise<{ id: string }> {
  return db.dialog.create({
    data: {
      userId,
      section: opts.section ?? "gpt",
      modelId: opts.modelId ?? GPT_MODEL,
      title: opts.title ?? "Test dialog",
    },
  });
}

describe("/web/dialogs/* routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── GET /web/dialogs ─────────────────────────────────────────────────────
  describe("GET /web/dialogs", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/web/dialogs" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 TELEGRAM_NOT_LINKED for web-only user", async () => {
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "GET",
        url: "/web/dialogs",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(403);
    });

    it("returns an empty list for a fresh user", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/dialogs",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("returns dialogs filtered by section", async () => {
      const { user, accessToken } = await createTestUser();
      await seedDialog(user.id!, { section: "gpt", title: "GPT one" });
      await seedDialog(user.id!, { section: "image", title: "Image one", modelId: IMAGE_MODEL });
      const res = await app.inject({
        method: "GET",
        url: "/web/dialogs?section=gpt",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ section: string; title: string }>;
      expect(body).toHaveLength(1);
      expect(body[0].section).toBe("gpt");
    });
  });

  // ── POST /web/dialogs ────────────────────────────────────────────────────
  describe("POST /web/dialogs", () => {
    it("returns 400 when section or modelId is missing", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/dialogs",
        payload: { section: "gpt" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for an unknown modelId", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/dialogs",
        payload: { section: "gpt", modelId: "no-such-model" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("creates a dialog and returns its DTO", async () => {
      const { user, accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/dialogs",
        payload: { section: "gpt", modelId: GPT_MODEL, title: "Fresh chat" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { id: string; title: string };
      expect(body.title).toBe("Fresh chat");
      const stored = await db.dialog.findUnique({ where: { id: body.id } });
      expect(stored?.userId).toBe(user.id);
    });
  });

  // ── PATCH /web/dialogs/:id ───────────────────────────────────────────────
  describe("PATCH /web/dialogs/:id", () => {
    it("returns 400 when title is missing", async () => {
      const { user, accessToken } = await createTestUser();
      const dialog = await seedDialog(user.id!);
      const res = await app.inject({
        method: "PATCH",
        url: `/web/dialogs/${dialog.id}`,
        payload: {},
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for an unknown dialog id", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "PATCH",
        url: "/web/dialogs/does-not-exist",
        payload: { title: "x" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 403 when the dialog belongs to another user", async () => {
      const owner = await createTestUser();
      const dialog = await seedDialog(owner.user.id!);
      const intruder = await createTestUser();
      const res = await app.inject({
        method: "PATCH",
        url: `/web/dialogs/${dialog.id}`,
        payload: { title: "hijack" },
        headers: bearer(intruder.accessToken),
      });
      expect(res.statusCode).toBe(403);
    });

    it("renames the dialog and returns 200", async () => {
      const { user, accessToken } = await createTestUser();
      const dialog = await seedDialog(user.id!, { title: "Old title" });
      const res = await app.inject({
        method: "PATCH",
        url: `/web/dialogs/${dialog.id}`,
        payload: { title: "New title" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const fresh = await db.dialog.findUnique({ where: { id: dialog.id } });
      expect(fresh?.title).toBe("New title");
    });
  });

  // ── DELETE /web/dialogs/:id ──────────────────────────────────────────────
  describe("DELETE /web/dialogs/:id", () => {
    it("returns 404 for an unknown dialog id", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "DELETE",
        url: "/web/dialogs/does-not-exist",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 403 when the dialog belongs to another user", async () => {
      const owner = await createTestUser();
      const dialog = await seedDialog(owner.user.id!);
      const intruder = await createTestUser();
      const res = await app.inject({
        method: "DELETE",
        url: `/web/dialogs/${dialog.id}`,
        headers: bearer(intruder.accessToken),
      });
      expect(res.statusCode).toBe(403);
    });

    it("soft-deletes the dialog (isDeleted=true) and returns success", async () => {
      const { user, accessToken } = await createTestUser();
      const dialog = await seedDialog(user.id!);
      const res = await app.inject({
        method: "DELETE",
        url: `/web/dialogs/${dialog.id}`,
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
      const fresh = await db.dialog.findUnique({ where: { id: dialog.id } });
      expect(fresh?.isDeleted).toBe(true);
    });
  });

  // ── GET /web/dialogs/:id/messages ────────────────────────────────────────
  describe("GET /web/dialogs/:id/messages", () => {
    it("returns 404 for an unknown dialog id", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/dialogs/does-not-exist/messages",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns the message list for an owned dialog", async () => {
      const { user, accessToken } = await createTestUser();
      const dialog = await seedDialog(user.id!);
      await db.message.create({
        data: { dialogId: dialog.id, role: "user", content: "hello" },
      });
      const res = await app.inject({
        method: "GET",
        url: `/web/dialogs/${dialog.id}/messages`,
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ role: string; content: string }>;
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ role: "user", content: "hello" });
    });
  });

  // ── POST /web/dialogs/:id/send (SSE smoke) ───────────────────────────────
  describe("POST /web/dialogs/:id/send", () => {
    it("returns 400 when content + attachments are all empty", async () => {
      const { user, accessToken } = await createTestUser();
      const dialog = await seedDialog(user.id!);
      const res = await app.inject({
        method: "POST",
        url: `/web/dialogs/${dialog.id}/send`,
        payload: { content: "" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for an unknown dialog id", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/dialogs/does-not-exist/send",
        payload: { content: "hi" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 200 with text/event-stream and an SSE body containing 'done'", async () => {
      const { user, accessToken } = await createTestUser();
      const dialog = await seedDialog(user.id!);
      const res = await app.inject({
        method: "POST",
        url: `/web/dialogs/${dialog.id}/send`,
        payload: { content: "ping" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers["content-type"] ?? "")).toContain("text/event-stream");
      // Body contains the SSE chunk + done events from the mocked stream.
      expect(res.body).toContain("event: chunk");
      expect(res.body).toContain("event: done");
    });
  });
});
