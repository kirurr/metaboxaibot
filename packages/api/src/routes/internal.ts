/**
 * Internal routes called by Metabox (server-to-server).
 * Protected by X-Internal-Key header matching METABOX_INTERNAL_KEY env var.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { config } from "@metabox/shared";
import { expireSubscription, grantMetaboxSubscription } from "../services/payment.service.js";
import {
  constructOpenAPIonRouteHook,
  badRequestResponse,
} from "../utils/openapi.js";

function checkKey(request: FastifyRequest): boolean {
  const key = config.metabox.internalKey;
  return !!key && request.headers["x-internal-key"] === key;
}

export const internalRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["internal"]),
  );

  fastify.addHook("preHandler", async (request, reply) => {
    if (!checkKey(request)) {
      await reply.code(401).send({ error: "Unauthorized" });
    }
  });

  /**
   * POST /link-metabox
   * Called by Metabox after a user links their Telegram via deep link.
   * Updates AI Box user.metaboxUserId.
   */
  fastify.post(
    "/link-metabox",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "User's Telegram ID" },
            metaboxUserId: { type: "string", description: "Metabox user ID to link" },
          },
          required: ["telegramId", "metaboxUserId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
          },
          400: badRequestResponse,
          401: {
            type: "object",
            properties: { error: { type: "string", description: "Unauthorized - invalid internal key" } },
          },
        },
      },
    },
    async (request, reply) => {
    const { telegramId, metaboxUserId } = request.body as {
      telegramId: string;
      metaboxUserId: string;
    };

    if (!telegramId || !metaboxUserId) {
      return reply.code(400).send({ error: "telegramId and metaboxUserId are required" });
    }

    await db.user.update({
      where: { id: BigInt(telegramId) },
      data: { metaboxUserId },
    });

    return { ok: true };
  });

  /**
   * POST /grant-tokens
   * Called by Metabox when an AI bot token package or subscription is purchased on the Metabox site.
   * grantType "subscription": credits to subscriptionTokenBalance + sets endDate / planName.
   * grantType "tokens" (default): credits to regular tokenBalance.
   */
  fastify.post(
    "/grant-tokens",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "User's Telegram ID" },
            tokens: { type: "number", description: "Amount of tokens to grant" },
            description: { type: "string", description: "Optional description" },
            grantType: { type: "string", enum: ["subscription", "tokens"], description: "Type of grant" },
            endDate: { type: "string", description: "Subscription end date (ISO string)" },
            planName: { type: "string", description: "Subscription plan name" },
            subscriptionId: { type: "string", description: "Metabox subscription ID for idempotency" },
          },
          required: ["telegramId", "tokens"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
          },
          400: badRequestResponse,
          404: {
            description: "User not found",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
    const { telegramId, tokens, description, grantType, endDate, planName, subscriptionId } =
      request.body as {
        telegramId: string;
        tokens: number;
        description?: string;
        grantType?: "subscription" | "tokens";
        endDate?: string;
        planName?: string;
        /** AiBoxSubscription.id from Metabox — used for idempotency */
        subscriptionId?: string;
      };

    if (!telegramId || typeof tokens !== "number" || tokens === 0) {
      return reply.code(400).send({ error: "telegramId and non-zero tokens are required" });
    }

    const userId = BigInt(telegramId);
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    if (grantType === "subscription") {
      const resolvedEndDate = endDate ? new Date(endDate) : new Date();
      console.log(
        `[grant-tokens] subscription grant: userId=${userId}, tokens=${tokens}, endDate=${resolvedEndDate.toISOString()}, planName=${planName}, subscriptionId=${subscriptionId}`,
      );
      const granted = await grantMetaboxSubscription({
        userId,
        tokens,
        endDate: resolvedEndDate,
        planName,
        metaboxSubscriptionId: subscriptionId,
        description,
      });
      console.log(
        `[grant-tokens] grantMetaboxSubscription result: ${granted ? "GRANTED" : "ALREADY_GRANTED (skipped)"}`,
      );
      // alreadyGranted (false) is a no-op — idempotent, always return ok
    } else {
      await db.$transaction([
        db.user.update({
          where: { id: userId },
          data: { tokenBalance: { increment: tokens } },
        }),
        db.tokenTransaction.create({
          data: {
            userId,
            amount: tokens,
            type: tokens > 0 ? "credit" : "debit",
            reason: "metabox_purchase",
            description: description || null,
          },
        }),
      ]);
    }

    return { ok: true };
  });

  /**
   * POST /sync-subscription
   * Mirrors subscription state from Metabox site to bot.
   * SETS token balances on User + upserts LocalSubscription.
   * No TokenTransaction created. Used when reconnecting site to bot.
   */
  fastify.post(
    "/sync-subscription",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "User's Telegram ID" },
            subscriptionTokenBalance: { type: "number", description: "Tokens to add to subscription balance" },
            tokenBalance: { type: "number", description: "Tokens to add to regular balance" },
            endDate: { type: "string", description: "Subscription end date (ISO string)" },
            planName: { type: "string", description: "Plan name" },
            period: { type: "string", description: "Billing period (e.g., M1)" },
            startDate: { type: "string", description: "Subscription start date (ISO string)" },
            tokensGranted: { type: "number", description: "Total tokens granted with this subscription" },
            metaboxSubscriptionId: { type: "string", description: "Metabox subscription ID" },
          },
          required: ["telegramId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
          },
          400: badRequestResponse,
          404: {
            description: "User not found",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
    const {
      telegramId,
      subscriptionTokenBalance,
      tokenBalance,
      // LocalSubscription fields
      endDate,
      planName,
      period,
      startDate,
      tokensGranted,
      metaboxSubscriptionId,
    } = request.body as {
      telegramId: string;
      subscriptionTokenBalance?: number;
      tokenBalance?: number;
      endDate?: string;
      planName?: string;
      period?: string;
      startDate?: string;
      tokensGranted?: number;
      metaboxSubscriptionId?: string;
    };

    if (!telegramId) {
      return reply.code(400).send({ error: "telegramId is required" });
    }

    const userId = BigInt(telegramId);
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    // Update User token balances (INCREMENT pending tokens onto existing balance)
    const userData: Record<string, unknown> = {};
    if (subscriptionTokenBalance !== undefined && subscriptionTokenBalance > 0)
      userData.subscriptionTokenBalance = { increment: subscriptionTokenBalance };
    if (tokenBalance !== undefined && tokenBalance > 0)
      userData.tokenBalance = { increment: tokenBalance };

    if (Object.keys(userData).length > 0) {
      await db.user.update({ where: { id: userId }, data: userData });
    }

    // Upsert LocalSubscription (single source of truth for subscription state).
    //
    // Edge case: если у юзера активный триал с endDate ПОЗЖЕ чем metabox-sub
    // endDate (например metabox прислал короткую/почти истёкшую подписку, а
    // триал ещё на 3 недели), переписывая endDate с триала на metabox мы бы
    // юзера лишили оставшегося триала. Берём max(triale, metaboxe) когда
    // current = Trial — триал сохраняется как минимум до своего конца.
    if (endDate) {
      const resolvedEndDate = new Date(endDate);
      const existing = await db.localSubscription.findUnique({ where: { userId } });
      const finalEndDate =
        existing?.planName === "Trial" && existing.endDate > resolvedEndDate
          ? existing.endDate
          : resolvedEndDate;
      await db.localSubscription.upsert({
        where: { userId },
        create: {
          userId,
          planName: planName ?? "Subscription",
          period: period ?? "M1",
          tokensGranted: tokensGranted ?? 0,
          startDate: startDate ? new Date(startDate) : new Date(),
          endDate: finalEndDate,
          isActive: finalEndDate > new Date(),
          metaboxSubscriptionId: metaboxSubscriptionId ?? null,
        },
        update: {
          planName: planName ?? "Subscription",
          ...(period ? { period } : {}),
          ...(tokensGranted !== undefined ? { tokensGranted } : {}),
          ...(startDate ? { startDate: new Date(startDate) } : {}),
          endDate: finalEndDate,
          isActive: finalEndDate > new Date(),
          ...(metaboxSubscriptionId !== undefined ? { metaboxSubscriptionId } : {}),
        },
      });
    }

    console.log(`[sync-subscription] userId=${userId}, user:`, userData, `sub endDate:`, endDate);

    return { ok: true };
  });

  /**
   * POST /unlink-subscription
   * Clears metaboxSubscriptionId on LocalSubscription (used by disconnect "keep in bot").
   */
  fastify.post(
    "/unlink-subscription",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "User's Telegram ID" },
          },
          required: ["telegramId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
    const { telegramId } = request.body as { telegramId: string };
    if (!telegramId) {
      return reply.code(400).send({ error: "telegramId is required" });
    }

    const userId = BigInt(telegramId);
    await db.localSubscription
      .update({
        where: { userId },
        data: { metaboxSubscriptionId: null },
      })
      .catch(() => {
        /* no subscription to unlink — that's ok */
      });

    return { ok: true };
  });

  /**
   * POST /revoke-tokens
   * Called by Metabox when a subscription expires or is revoked on the site.
   * Zeroes subscription balance, clears endDate/planName, deactivates local subscription record.
   */
  fastify.post(
    "/revoke-tokens",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "User's Telegram ID" },
          },
          required: ["telegramId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
    const { telegramId } = request.body as { telegramId: string };

    if (!telegramId) {
      return reply.code(400).send({ error: "telegramId is required" });
    }

    const user = await db.user.findUnique({ where: { id: BigInt(telegramId) } });
    if (!user) {
      return { ok: true }; // user not in bot — nothing to revoke
    }

    await expireSubscription(BigInt(telegramId));

    return { ok: true };
  });

  /**
   * POST /decrement-tokens
   * Called by Metabox admin when rolling back a token-pack purchase.
   * Decrements regular tokenBalance by `tokens`, FLOORED at 0.
   */
  fastify.post(
    "/decrement-tokens",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "User's Telegram ID" },
            tokens: { type: "number", description: "Amount of tokens to deduct" },
            description: { type: "string", description: "Optional description for the transaction" },
          },
          required: ["telegramId", "tokens"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              deducted: { type: "number", description: "Actual amount deducted" },
              newBalance: { type: "number", description: "New token balance" },
            },
            required: ["ok", "deducted", "newBalance"],
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
    const { telegramId, tokens, description } = request.body as {
      telegramId: string;
      tokens: number;
      description?: string;
    };

    if (!telegramId || typeof tokens !== "number" || tokens <= 0) {
      return reply.code(400).send({ error: "telegramId and positive tokens are required" });
    }

    const userId = BigInt(telegramId);
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) {
      return { ok: true, deducted: 0, newBalance: 0 };
    }

    const currentBalance = Number(user.tokenBalance);
    const actualDeduct = Math.min(currentBalance, tokens);

    if (actualDeduct === 0) {
      return { ok: true, deducted: 0, newBalance: currentBalance };
    }

    await db.$transaction([
      db.user.update({
        where: { id: userId },
        data: { tokenBalance: { decrement: actualDeduct } },
      }),
      db.tokenTransaction.create({
        data: {
          userId,
          amount: -actualDeduct,
          type: "debit",
          reason: "metabox_rollback",
          description: description || null,
        },
      }),
    ]);

    return {
      ok: true,
      deducted: actualDeduct,
      newBalance: currentBalance - actualDeduct,
    };
  });

  /**
   * POST /decrement-subscription-tokens
   * Called by Metabox admin when rolling back a bundle purchase with bonus subscription.
   * Decrements subscriptionTokenBalance by `tokens`, FLOORED at 0.
   * If metaboxSubscriptionId provided, also deletes matching LocalSubscription.
   */
  fastify.post(
    "/decrement-subscription-tokens",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "User's Telegram ID" },
            tokens: { type: "number", description: "Amount of subscription tokens to deduct" },
            description: { type: "string", description: "Optional description" },
            metaboxSubscriptionId: { type: "string", description: "Metabox subscription ID to delete if matches" },
          },
          required: ["telegramId", "tokens"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              deducted: { type: "number", description: "Actual amount deducted" },
              newBalance: { type: "number", description: "New subscription token balance" },
              localSubscriptionDeleted: { type: "boolean", description: "Whether local subscription was deleted" },
            },
            required: ["ok", "deducted", "newBalance", "localSubscriptionDeleted"],
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
    const { telegramId, tokens, description, metaboxSubscriptionId } = request.body as {
      telegramId: string;
      tokens: number;
      description?: string;
      metaboxSubscriptionId?: string;
    };

    if (!telegramId || typeof tokens !== "number" || tokens <= 0) {
      return reply.code(400).send({ error: "telegramId and positive tokens are required" });
    }

    const userId = BigInt(telegramId);
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) {
      return { ok: true, deducted: 0, newBalance: 0, localSubscriptionDeleted: false };
    }

    const currentBalance = Number(user.subscriptionTokenBalance);
    const actualDeduct = Math.min(currentBalance, tokens);

    let localSubscriptionDeleted = false;
    if (metaboxSubscriptionId) {
      // Удаляем LocalSubscription только если её metaboxSubscriptionId
      // совпадает с откатываемой. Иначе [например юзер успел купить
      // другую подписку поверх бонуса] — не трогаем.
      const deleteResult = await db.localSubscription.deleteMany({
        where: { userId, metaboxSubscriptionId },
      });
      localSubscriptionDeleted = deleteResult.count > 0;
    }

    if (actualDeduct === 0) {
      return {
        ok: true,
        deducted: 0,
        newBalance: currentBalance,
        localSubscriptionDeleted,
      };
    }

    await db.$transaction([
      db.user.update({
        where: { id: userId },
        data: { subscriptionTokenBalance: { decrement: actualDeduct } },
      }),
      db.tokenTransaction.create({
        data: {
          userId,
          amount: -actualDeduct,
          type: "debit",
          reason: "metabox_bundle_rollback",
          description: description || null,
        },
      }),
    ]);

    return {
      ok: true,
      deducted: actualDeduct,
      newBalance: currentBalance - actualDeduct,
      localSubscriptionDeleted,
    };
  });

  /**
   * POST /reset-token-balance
   * Sets user token balance to exactly 0. Used when admin disconnects TG
   * and transfers all tokens to site.
   */
  fastify.post(
    "/reset-token-balance",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "User's Telegram ID" },
          },
          required: ["telegramId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              previousBalance: { type: "number", description: "Previous token balance before reset" },
            },
            required: ["ok", "previousBalance"],
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
    const { telegramId } = request.body as { telegramId: string };
    if (!telegramId) {
      return reply.code(400).send({ error: "telegramId is required" });
    }

    const user = await db.user.findUnique({ where: { id: BigInt(telegramId) } });
    if (!user) return { ok: true };

    await db.user.update({
      where: { id: BigInt(telegramId) },
      data: { tokenBalance: 0 },
    });

    return { ok: true, previousBalance: Number(user.tokenBalance) };
  });

  /**
   * POST /unlink-metabox
   * Called by Metabox admin when disconnecting a user's Telegram account.
   * Clears metaboxUserId and metaboxReferralCode.
   */
  fastify.post(
    "/unlink-metabox",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "User's Telegram ID" },
          },
          required: ["telegramId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
    const { telegramId } = request.body as { telegramId: string };

    if (!telegramId) {
      return reply.code(400).send({ error: "telegramId is required" });
    }

    const user = await db.user.findUnique({
      where: { id: BigInt(telegramId) },
      select: { id: true },
    });

    if (!user) {
      return { ok: true }; // user never started the bot — nothing to unlink
    }

    await db.user.update({
      where: { id: BigInt(telegramId) },
      data: { metaboxUserId: null, metaboxReferralCode: null },
    });

    return { ok: true };
  });

  /**
   * GET /user-balance?telegramId=<id>
   * Called by Metabox to get the current token balance of a bot user.
   */
  fastify.get<{ Querystring: { telegramId?: string } }>(
    "/user-balance",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "User's Telegram ID" },
          },
          required: ["telegramId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              tokens: { type: "number", description: "Total tokens (regular + subscription)" },
              tokenBalance: { type: "number", description: "Regular token balance" },
              subscriptionTokenBalance: { type: "number", description: "Subscription token balance" },
            },
            required: ["tokens", "tokenBalance", "subscriptionTokenBalance"],
          },
          400: badRequestResponse,
          404: {
            description: "User not found",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
    const { telegramId } = request.query;
    if (!telegramId) {
      return reply.code(400).send({ error: "telegramId is required" });
    }
    const user = await db.user.findUnique({
      where: { id: BigInt(telegramId) },
      select: { tokenBalance: true, subscriptionTokenBalance: true },
    });
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }
    return {
      tokens: Number(user.tokenBalance) + Number(user.subscriptionTokenBalance),
      tokenBalance: Number(user.tokenBalance),
      subscriptionTokenBalance: Number(user.subscriptionTokenBalance),
    };
  });

  /**
   * GET /check-bot-user?telegramId=<id>
   * Called by Metabox to check whether a user has ever started the AI Box bot.
   */
  fastify.get<{ Querystring: { telegramId?: string } }>(
    "/check-bot-user",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "User's Telegram ID" },
          },
          required: ["telegramId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              activated: { type: "boolean", description: "Whether user has started the bot" },
            },
            required: ["activated"],
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { telegramId } = request.query;
      if (!telegramId) {
        return reply.code(400).send({ error: "telegramId is required" });
      }
      const user = await db.user.findUnique({
        where: { id: BigInt(telegramId) },
        select: { id: true },
      });
      return { activated: !!user };
    },
  );

  /**
   * POST /save-subscription
   * Called by Metabox when admin disconnects TG and chooses "keep in bot".
   * Saves subscription data locally so bot can check it independently.
   */
  fastify.post(
    "/save-subscription",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "User's Telegram ID" },
            planName: { type: "string", description: "Subscription plan name" },
            period: { type: "string", description: "Billing period (e.g., M1)" },
            tokensGranted: { type: "number", description: "Tokens granted with this subscription" },
            endDate: { type: "string", description: "Subscription end date (ISO string)" },
            startDate: { type: "string", description: "Subscription start date (ISO string)" },
          },
          required: ["telegramId", "planName", "endDate"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
    const { telegramId, planName, period, tokensGranted, endDate, startDate } = request.body as {
      telegramId: string;
      planName: string;
      period: string;
      tokensGranted: number;
      endDate: string;
      startDate: string;
    };

    if (!telegramId || !planName || !endDate) {
      return reply.code(400).send({ error: "telegramId, planName, endDate required" });
    }

    const user = await db.user.findUnique({ where: { id: BigInt(telegramId) } });
    if (!user) return { ok: true };

    await db.localSubscription.upsert({
      where: { userId: BigInt(telegramId) },
      create: {
        userId: BigInt(telegramId),
        planName,
        period: period || "M1",
        tokensGranted: tokensGranted || 0,
        endDate: new Date(endDate),
        startDate: new Date(startDate || Date.now()),
        isActive: new Date(endDate) > new Date(),
      },
      update: {
        planName,
        period: period || "M1",
        tokensGranted: tokensGranted || 0,
        endDate: new Date(endDate),
        startDate: new Date(startDate || Date.now()),
        isActive: new Date(endDate) > new Date(),
      },
    });

    return { ok: true };
  });

  /**
   * GET /get-local-subscription?telegramId=<id>
   * Returns local subscription data if exists and active.
   */
  fastify.get<{ Querystring: { telegramId?: string } }>(
    "/get-local-subscription",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "User's Telegram ID" },
          },
          required: ["telegramId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              subscription: {
                type: "object",
                nullable: true,
                properties: {
                  planName: { type: "string", description: "Plan name" },
                  period: { type: "string", description: "Billing period" },
                  tokensGranted: { type: "number", description: "Tokens granted" },
                  endDate: { type: "string", description: "End date (ISO string)" },
                  startDate: { type: "string", description: "Start date (ISO string)" },
                  daysLeft: { type: "number", description: "Days remaining" },
                  metaboxSubscriptionId: { type: "string", description: "Metabox subscription ID" },
                },
              },
            },
            required: ["subscription"],
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { telegramId } = request.query;
      if (!telegramId) {
        return reply.code(400).send({ error: "telegramId is required" });
      }

      const sub = await db.localSubscription.findUnique({
        where: { userId: BigInt(telegramId) },
      });

      if (!sub || !sub.isActive || new Date(sub.endDate) <= new Date()) {
        return { subscription: null };
      }

      return {
        subscription: {
          planName: sub.planName,
          period: sub.period,
          tokensGranted: sub.tokensGranted,
          endDate: sub.endDate.toISOString(),
          startDate: sub.startDate.toISOString(),
          daysLeft: Math.max(0, Math.ceil((sub.endDate.getTime() - Date.now()) / 86400000)),
          metaboxSubscriptionId: sub.metaboxSubscriptionId ?? undefined,
        },
      };
    },
  );

  /**
   * POST /consume-local-subscription
   * Called by Metabox when bot reconnects to a new site account.
   * Returns and deletes the local subscription data.
   */
  fastify.post(
    "/consume-local-subscription",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "User's Telegram ID" },
          },
          required: ["telegramId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              subscription: {
                type: "object",
                nullable: true,
                properties: {
                  planName: { type: "string", description: "Plan name" },
                  period: { type: "string", description: "Billing period" },
                  tokensGranted: { type: "number", description: "Tokens granted" },
                  endDate: { type: "string", description: "End date (ISO string)" },
                  startDate: { type: "string", description: "Start date (ISO string)" },
                },
              },
            },
            required: ["subscription"],
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
    const { telegramId } = request.body as { telegramId: string };
    if (!telegramId) {
      return reply.code(400).send({ error: "telegramId is required" });
    }

    const sub = await db.localSubscription.findUnique({
      where: { userId: BigInt(telegramId) },
    });

    if (!sub || !sub.isActive || new Date(sub.endDate) <= new Date()) {
      return { subscription: null };
    }

    // Delete after consuming
    await db.localSubscription.delete({ where: { id: sub.id } });

    return {
      subscription: {
        planName: sub.planName,
        period: sub.period,
        tokensGranted: sub.tokensGranted,
        endDate: sub.endDate.toISOString(),
        startDate: sub.startDate.toISOString(),
      },
    };
  });
};
