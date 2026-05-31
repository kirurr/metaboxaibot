/**
 * Integration test for GET /web/usage-daily from packages/api/src/routes/web-stats.ts.
 *
 * Покрывает:
 *  - webAuthPreHandler: 401 без Bearer;
 *  - web-only юзер (нет aibUserId) → 200 { data: [] };
 *  - свежий юзер → 28 элементов, все spent === "0";
 *  - суммирование дробных списаний без округления, исключение credit'ов,
 *    zero-fill дней без операций, длина 28 и порядок старый→новый.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers/build-app.js";
import { db } from "./helpers/db.js";
import { bearer, createTestUser } from "./fixtures/users.js";

interface UsageResponse {
  data: { date: string; spent: string }[];
}

/** Та же логика дня, что и в роуте (Europe/Moscow, формат YYYY-MM-DD). */
const moscowDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function moscowDay(d: Date): string {
  return moscowDayFmt.format(d);
}

describe("GET /web/usage-daily", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 401 without Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/web/usage-daily" });
    expect(res.statusCode).toBe(401);
  });

  it("returns empty data for a web-only user (no Telegram linked)", async () => {
    const { accessToken } = await createTestUser({ withTelegram: false });
    const res = await app.inject({
      method: "GET",
      url: "/web/usage-daily",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as UsageResponse).toEqual({ data: [] });
  });

  it("returns 28 zero-filled days for a fresh user", async () => {
    const { accessToken } = await createTestUser();
    const res = await app.inject({
      method: "GET",
      url: "/web/usage-daily",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UsageResponse;
    expect(body.data).toHaveLength(28);
    expect(body.data.every((d) => d.spent === "0")).toBe(true);
    // Порядок старый→новый, последний день — сегодня (по Москве).
    expect(body.data[27].date).toBe(moscowDay(new Date()));
    const dates = body.data.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("sums fractional debits per day, ignores credits, zero-fills gaps", async () => {
    const { user, accessToken } = await createTestUser();
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000);

    await db.tokenTransaction.createMany({
      data: [
        // Два дробных списания сегодня → 12.34 + 5.66 = 18 (без округления и без .00).
        { userId: user.id!, amount: "-12.34", type: "debit", reason: "ai_usage", createdAt: now },
        { userId: user.id!, amount: "-5.66", type: "debit", reason: "ai_usage", createdAt: now },
        // Пополнение сегодня — НЕ должно попасть в spent.
        { userId: user.id!, amount: "100", type: "credit", reason: "purchase", createdAt: now },
        // Дробное списание три дня назад → 0.5.
        {
          userId: user.id!,
          amount: "-0.5",
          type: "debit",
          reason: "ai_usage",
          createdAt: threeDaysAgo,
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: "/web/usage-daily",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as UsageResponse;
    expect(data).toHaveLength(28);

    const byDate = new Map(data.map((d) => [d.date, d.spent]));
    expect(byDate.get(moscowDay(now))).toBe("18");
    expect(byDate.get(moscowDay(threeDaysAgo))).toBe("0.5");

    // Всё остальное — нули; суммарный расход = 18 + 0.5 = 18.5.
    const total = data.reduce((acc, d) => acc + Number(d.spent), 0);
    expect(total).toBeCloseTo(18.5, 4);
  });
});
