/**
 * Integration tests for GET /web/history from packages/api/src/routes/web-chat.ts.
 *
 * История = объединение двух источников:
 *  - Dialog (kind="dialog") для секции "gpt"
 *  - GenerationJob (kind="job") для image/video/audio
 *
 * Покрывает:
 *  - webTelegramLinkedPreHandler: 401 / 403;
 *  - пустой список для нового юзера;
 *  - объединение dialogs+jobs, сортировка по updatedAt desc;
 *  - section=gpt → только диалоги; section=image → только media-джобы;
 *  - q-фильтр: матч в Dialog.title / Message.content / GenerationJob.prompt,
 *    snippet возвращается для совпавших записей.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers/build-app.js";
import { db } from "./helpers/db.js";
import { bearer, createTestUser } from "./fixtures/users.js";

interface HistoryItem {
  kind: "dialog" | "job";
  id: string;
  section: string;
  modelId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  totalTokens: number;
  snippet: string | null;
  status?: string;
}

async function seedDialog(
  userId: bigint,
  opts: { title?: string; modelId?: string; updatedAt?: Date; messageContent?: string } = {},
): Promise<{ id: string }> {
  const dialog = await db.dialog.create({
    data: {
      userId,
      section: "gpt",
      modelId: opts.modelId ?? "gpt-4o",
      title: opts.title ?? "Test dialog",
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    },
  });
  if (opts.messageContent) {
    await db.message.create({
      data: {
        dialogId: dialog.id,
        role: "user",
        content: opts.messageContent,
        tokensUsed: "5",
      },
    });
  }
  return { id: dialog.id };
}

async function seedJob(
  userId: bigint,
  opts: {
    section?: string;
    modelId?: string;
    prompt?: string;
    status?: string;
    updatedAt?: Date;
  } = {},
): Promise<{ id: string }> {
  return db.generationJob.create({
    data: {
      userId,
      dialogId: "history-test-dialog",
      section: opts.section ?? "image",
      modelId: opts.modelId ?? "midjourney",
      status: opts.status ?? "done",
      prompt: opts.prompt ?? "a unicorn",
      tokensSpent: "10",
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    },
  });
}

describe("GET /web/history", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 401 without Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/web/history" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 TELEGRAM_NOT_LINKED for web-only user", async () => {
    const { accessToken } = await createTestUser({ withTelegram: false });
    const res = await app.inject({
      method: "GET",
      url: "/web/history",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "TELEGRAM_NOT_LINKED" });
  });

  it("returns an empty array for a user with no dialogs and no jobs", async () => {
    const { accessToken } = await createTestUser();
    const res = await app.inject({
      method: "GET",
      url: "/web/history",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("merges dialogs and jobs sorted by updatedAt desc", async () => {
    const { user, accessToken } = await createTestUser();
    const older = new Date("2025-01-01T00:00:00Z");
    const newer = new Date("2025-06-01T00:00:00Z");
    await seedDialog(user.id!, { title: "Older dialog", updatedAt: older });
    await seedJob(user.id!, { prompt: "newer image", updatedAt: newer });

    const res = await app.inject({
      method: "GET",
      url: "/web/history",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json() as HistoryItem[];
    expect(items).toHaveLength(2);
    expect(items[0].kind).toBe("job");
    expect(items[0].title).toBe("newer image");
    expect(items[1].kind).toBe("dialog");
    expect(items[1].title).toBe("Older dialog");
  });

  it("filters to gpt-only when section=gpt", async () => {
    const { user, accessToken } = await createTestUser();
    await seedDialog(user.id!, { title: "Dialog only" });
    await seedJob(user.id!, { prompt: "should be excluded" });

    const res = await app.inject({
      method: "GET",
      url: "/web/history?section=gpt",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json() as HistoryItem[];
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("dialog");
  });

  it("filters to a single media section (image)", async () => {
    const { user, accessToken } = await createTestUser();
    await seedDialog(user.id!, { title: "GPT dialog" });
    await seedJob(user.id!, { section: "image", prompt: "an image" });
    await seedJob(user.id!, { section: "video", prompt: "a video" });

    const res = await app.inject({
      method: "GET",
      url: "/web/history?section=image",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json() as HistoryItem[];
    expect(items).toHaveLength(1);
    expect(items[0].section).toBe("image");
    expect(items[0].title).toBe("an image");
  });

  it("filters by q across dialog messages and job prompts", async () => {
    const { user, accessToken } = await createTestUser();
    await seedDialog(user.id!, {
      title: "Random",
      messageContent: "this mentions DRAGON in message body",
    });
    await seedDialog(user.id!, { title: "Unrelated", messageContent: "nothing matches here" });
    await seedJob(user.id!, { prompt: "a magnificent dragon flying over mountains" });
    await seedJob(user.id!, { prompt: "a quiet meadow" });

    const res = await app.inject({
      method: "GET",
      url: "/web/history?q=dragon",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json() as HistoryItem[];
    // matching dialog + matching job; non-matching ones excluded.
    expect(items).toHaveLength(2);
    const titles = items.map((i) => i.title);
    expect(titles).toContain("Random");
    expect(titles).toContain("a magnificent dragon flying over mountains");
    for (const item of items) {
      expect(item.snippet).toBeTruthy();
      expect(item.snippet!.toLowerCase()).toContain("dragon");
    }
  });
});
