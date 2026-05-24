import { describe, test, expect } from "vitest";
import { AlibabaVideoAdapter } from "./alibaba.adapter.js";
import type { VideoInput } from "./base.adapter.js";
import { UserFacingError } from "@metabox/shared";

const baseInput = (overrides: Partial<VideoInput> = {}): VideoInput => ({
  prompt: "test prompt",
  ...overrides,
});

/** Мок fetch, отвечающий заданным телом/статусом на createTask. */
function mockFetch(status: number, body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

describe("AlibabaVideoAdapter — Arrearage handling", () => {
  test("400 + code:'Arrearage' → UserFacingError balance/dedup, не Error", async () => {
    // Реальный ответ DashScope при просрочке аккаунта (видели 2026-05-23 в проде).
    const fetchFn = mockFetch(400, {
      code: "Arrearage",
      message: "Access denied, please make sure your account is in good standing.",
      request_id: "test-req-id",
    });
    const adapter = new AlibabaVideoAdapter("wan", "test-key", fetchFn);
    const err = await adapter.submit(baseInput()).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(UserFacingError);
    const ufe = err as UserFacingError;
    expect(ufe.key).toBe("modelTemporarilyUnavailable");
    expect(ufe.section).toBe("video");
    expect(ufe.notifyOps).toBe(true);
    expect(ufe.opsAlertChannel).toBe("balance");
    expect(ufe.opsAlertDedupKey).toBe("alibaba-arrearage");
  });

  test("200 body с code:'Arrearage' (DashScope иногда отдаёт в 200) → UserFacingError", async () => {
    // Альтернативная ветка адаптера: HTTP 200 + body.code !== null.
    const fetchFn = mockFetch(200, {
      code: "Arrearage",
      message: "Access denied, please make sure your account is in good standing.",
    });
    const adapter = new AlibabaVideoAdapter("wan", "test-key", fetchFn);
    const err = await adapter.submit(baseInput()).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as UserFacingError).opsAlertChannel).toBe("balance");
  });

  test("400 с другим code → обычный Error (НЕ UserFacingError, BullMQ retry'ит)", async () => {
    // Защита от over-match: только Arrearage спецобрабатываем.
    const fetchFn = mockFetch(400, {
      code: "InvalidParameter",
      message: "bad payload",
    });
    const adapter = new AlibabaVideoAdapter("wan", "test-key", fetchFn);
    const err = await adapter.submit(baseInput()).then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UserFacingError);
  });

  test("poll() с 400 Arrearage → UserFacingError balance/dedup", async () => {
    // Аккаунт может уйти в Arrearage между submit'ом и poll'ом (wan async,
    // поллим часами). Без этой ветки 400+Arrearage летел бы как generic 5xx,
    // BullMQ ретраил бы, алерт уходил бы не в balance, юзер ждал бы 3 ретрая.
    const fetchFn = mockFetch(400, {
      code: "Arrearage",
      message: "Access denied, please make sure your account is in good standing.",
    });
    const adapter = new AlibabaVideoAdapter("wan", "test-key", fetchFn);
    const err = await adapter.poll("task-id-abc").then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(UserFacingError);
    const ufe = err as UserFacingError;
    expect(ufe.key).toBe("modelTemporarilyUnavailable");
    expect(ufe.opsAlertChannel).toBe("balance");
    expect(ufe.opsAlertDedupKey).toBe("alibaba-arrearage");
  });
});
