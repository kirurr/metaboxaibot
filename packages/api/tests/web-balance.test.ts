/**
 * Integration test for GET /web/balance from packages/api/src/routes/web-chat.ts.
 *
 * Покрывает:
 *  - webTelegramLinkedPreHandler: 401 без Bearer, 403 для web-only юзера;
 *  - 200 с дефолтным User.tokenBalance=0 и subscription=null;
 *  - 200 с ненулевым балансом и активной LocalSubscription (вся подписка
 *    мапится в ответ — planName / period / endDate / tokensGranted).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers/build-app.js";
import { db } from "./helpers/db.js";
import { bearer, createTestUser } from "./fixtures/users.js";

interface BalanceResponse {
  tokenBalance: string;
  subscriptionTokenBalance: string;
  subscription: {
    planName: string;
    period: string;
    endDate: string;
    tokensGranted: number;
  } | null;
}

describe("GET /web/balance", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 401 without Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/web/balance" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 TELEGRAM_NOT_LINKED for web-only user", async () => {
    const { accessToken } = await createTestUser({ withTelegram: false });
    const res = await app.inject({
      method: "GET",
      url: "/web/balance",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "TELEGRAM_NOT_LINKED" });
  });

  it("returns zero balances and null subscription for a fresh user", async () => {
    const { accessToken } = await createTestUser();
    const res = await app.inject({
      method: "GET",
      url: "/web/balance",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json() as BalanceResponse).toEqual({
      tokenBalance: "0",
      subscriptionTokenBalance: "0",
      subscription: null,
    });
  });

  it("returns balances + active subscription details when set", async () => {
    const { user, accessToken } = await createTestUser();
    const endDate = new Date("2030-01-01T00:00:00Z");
    await db.user.update({
      where: { id: user.id! },
      data: { tokenBalance: "250.5", subscriptionTokenBalance: "1000" },
    });
    await db.localSubscription.create({
      data: {
        userId: user.id!,
        planName: "Pro",
        period: "M3",
        tokensGranted: 9000,
        startDate: new Date("2025-01-01T00:00:00Z"),
        endDate,
        isActive: true,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/web/balance",
      headers: bearer(accessToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BalanceResponse;
    // Prisma Decimal сериализуется в строку — формат "250.5" / "1000" приходит as-is.
    expect(body.tokenBalance).toBe("250.5");
    expect(body.subscriptionTokenBalance).toBe("1000");
    expect(body.subscription).toEqual({
      planName: "Pro",
      period: "M3",
      endDate: endDate.toISOString(),
      tokensGranted: 9000,
    });
  });
});
