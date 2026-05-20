/**
 * Internal routes called by Metabox (server-to-server).
 * Protected by X-Internal-Key header matching METABOX_INTERNAL_KEY env var.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { config } from "@metabox/shared";
import { expireSubscription, grantMetaboxSubscription } from "../services/payment.service.js";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";

function checkKey(request: FastifyRequest): boolean {
  const key = config.metabox.internalKey;
  return !!key && request.headers["x-internal-key"] === key;
}

export const internalRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRoute", (param) => constructOpenAPIonRouteHook(param, ["internal"]));
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
        description: "Link Metabox user to AI Box user via Telegram",
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "Telegram user ID" },
            metaboxUserId: { type: "string", description: "Metabox user ID" },
          },
          required: ["telegramId", "metaboxUserId"],
        },
        response: {
          200: {
            additionalProperties: true,
            type: "object",
            properties: { ok: { type: "boolean" } },
          },
          400: badRequestResponse,
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
        where: { telegramId: BigInt(telegramId) },
        data: { metaboxUserId },
      });

      return { ok: true };
    },
  );

  /**
   * POST /internal/grant-tokens
   * Called by Metabox when an AI bot token package or subscription is purchased on the Metabox site.
   * grantType "subscription": credits to subscriptionTokenBalance + sets endDate / planName.
   * grantType "tokens" (default): credits to regular tokenBalance.
   */
  fastify.post(
    "/grant-tokens",
    {
      schema: {
        description: "Grant tokens to user from Metabox",
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string", description: "Telegram user ID" },
            aiboxUserId: {
              type: "string",
              description: "AI Box User.id (fallback when user has no telegramId — web-only)",
            },
            tokens: { type: "number", description: "Number of tokens to grant" },
            description: { type: "string", description: "Description for transaction" },
            grantType: {
              type: "string",
              enum: ["subscription", "tokens"],
              description: "Type of grant",
            },
            endDate: { type: "string", description: "Subscription end date (ISO 8601)" },
            planName: { type: "string", description: "Subscription plan name" },
            subscriptionId: {
              type: "string",
              description: "Metabox subscription ID for idempotency",
            },
            orderId: { type: "string", description: "Order ID for idempotency on token grants" },
          },
        },
        response: {
          200: {
            additionalProperties: true,
            type: "object",
            properties: { ok: { type: "boolean" }, granted: { type: "boolean" } },
          },
          400: badRequestResponse,
          404: {
            additionalProperties: true,
            type: "object",
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const {
        telegramId,
        aiboxUserId,
        tokens,
        description,
        grantType,
        endDate,
        planName,
        subscriptionId,
        orderId,
      } = request.body as {
        telegramId?: string;
        /** Альтернативный id для web-only юзеров без telegramId. Один из
         *  (telegramId, aiboxUserId) обязателен. */
        aiboxUserId?: string;
        tokens: number;
        description?: string;
        grantType?: "subscription" | "tokens";
        endDate?: string;
        planName?: string;
        /** AiBoxSubscription.id from Metabox — used for idempotency */
        subscriptionId?: string;
        /** AiBotOrder.id from Metabox — used for idempotency on token-pack grants.
         *  Optional для обратной совместимости со старыми вызовами (без orderId
         *  работает по-старому, без dedup'а). */
        orderId?: string;
      };

      if ((!telegramId && !aiboxUserId) || typeof tokens !== "number" || tokens === 0) {
        return reply
          .code(400)
          .send({ error: "telegramId or aiboxUserId and non-zero tokens are required" });
      }

      // Резолвим юзера: aiboxUserId имеет приоритет (точная связь).
      const user = aiboxUserId
        ? await db.user.findUnique({ where: { id: BigInt(aiboxUserId) } })
        : await db.user.findUnique({ where: { telegramId: BigInt(telegramId!) } });
      if (!user) {
        return reply.code(404).send({ error: "User not found" });
      }
      const userId = user.id;
      // tgid для записи в GrantedMetaboxOrder (может быть null для web-only).
      const tgid = user.telegramId ?? null;

      if (grantType === "subscription") {
        const resolvedEndDate = endDate ? new Date(endDate) : new Date();
        console.log(
          `[grant-tokens] subscription grant: userId=${userId}, tgid=${tgid}, tokens=${tokens}, endDate=${resolvedEndDate.toISOString()}, planName=${planName}, subscriptionId=${subscriptionId}`,
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
        // Идемпотентность по orderId — если запись уже есть в GrantedMetaboxOrder,
        // токены ранее зачислены, повторный вызов от metabox (ретрай / сетевой
        // повтор / параллельный pull-flow syncMetaboxGrants) → no-op.
        if (orderId) {
          const existing = await db.grantedMetaboxOrder.findUnique({
            where: { orderId },
          });
          if (existing) {
            console.log(
              `[grant-tokens] order ${orderId} already granted — idempotent skip (no double-credit)`,
            );
            return { ok: true, alreadyGranted: true };
          }
        }

        // Insert в GrantedMetaboxOrder идёт в той же транзакции. При гонке
        // (например, syncMetaboxGrants уже зачислил с тем же orderId) сработает
        // unique-violation на pkey и весь батч откатится — двойного зачисления
        // не будет.
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
          ...(orderId
            ? [
                db.grantedMetaboxOrder.create({
                  data: {
                    orderId,
                    // null для web-only юзеров (колонка nullable, дедуп по orderId).
                    telegramId: tgid,
                    tokens,
                    description: description || null,
                  },
                }),
              ]
            : []),
        ]);
      }

      return { ok: true };
    },
  );

  /**
   * POST /internal/sync-subscription
   * Mirrors subscription state from Metabox site to bot.
   * SETS token balances on User + upserts LocalSubscription.
   * No TokenTransaction created. Used when reconnecting site to bot.
   */
  fastify.post(
    "/sync-subscription",
    {
      schema: {
        description: "Sync subscription state from Metabox to AI Box",
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string" },
            aiboxUserId: { type: "string" },
            subscriptionTokenBalance: { type: "number" },
            tokenBalance: { type: "number" },
            orderGrants: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  orderId: { type: "string" },
                  tokens: { type: "number" },
                  description: { type: "string" },
                },
                required: ["orderId", "tokens"],
              },
            },
            endDate: { type: "string" },
            planName: { type: "string" },
            period: { type: "string" },
            startDate: { type: "string" },
            tokensGranted: { type: "number" },
            metaboxSubscriptionId: { type: "string" },
          },
        },
        response: {
          200: {
            additionalProperties: true,
            type: "object",
            properties: { ok: { type: "boolean" } },
          },
          400: badRequestResponse,
          404: {
            additionalProperties: true,
            type: "object",
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const {
        telegramId,
        aiboxUserId,
        subscriptionTokenBalance,
        tokenBalance,
        orderGrants,
        // LocalSubscription fields
        endDate,
        planName,
        period,
        startDate,
        tokensGranted,
        metaboxSubscriptionId,
      } = request.body as {
        telegramId?: string;
        /** Альтернативный идентификатор AI Box.User.id (для web-only юзеров
         *  без telegramId). Metabox-сторона хранит его в `User.aiboxUserId`,
         *  пушит сюда при админ-грантах. Один из (telegramId, aiboxUserId)
         *  должен быть передан. */
        aiboxUserId?: string;
        subscriptionTokenBalance?: number;
        tokenBalance?: number;
        /** Per-order разрез pendingBotTokens — каждая запись идёт через dedup
         *  по GrantedMetaboxOrder. Когда передано, `tokenBalance` игнорируется
         *  (эффективная сумма считается из не-выданных orderGrants). Без поля
         *  работает как раньше (увеличение на `tokenBalance` без dedup'а). */
        orderGrants?: Array<{ orderId: string; tokens: number; description?: string }>;
        endDate?: string;
        planName?: string;
        period?: string;
        startDate?: string;
        tokensGranted?: number;
        metaboxSubscriptionId?: string;
      };

      if (!telegramId && !aiboxUserId) {
        return reply.code(400).send({ error: "telegramId or aiboxUserId is required" });
      }

      // Резолвим юзера: aiboxUserId имеет приоритет (точная связь). Иначе
      // ищем по telegramId как раньше.
      const user = aiboxUserId
        ? await db.user.findUnique({ where: { id: BigInt(aiboxUserId) } })
        : await db.user.findUnique({ where: { telegramId: BigInt(telegramId!) } });
      if (!user) {
        return reply.code(404).send({ error: "User not found" });
      }
      const userId = user.id;
      // tgid используется ниже для записи в GrantedMetaboxOrder. Для web-only
      // юзеров может быть null — таблица теперь допускает это.
      const tgid = user.telegramId ?? null;

      // Idempotency check 1: subscriptionTokenBalance дедуплицируется по
      // metaboxSubscriptionId. Если LocalSubscription с этим metaboxSubscriptionId
      // уже существует и активна — токены этой подписки были начислены ранее.
      // Параллель с `grantMetaboxSubscription` (см. payment.service.ts:283-292).
      let shouldApplySubscriptionTokens =
        subscriptionTokenBalance !== undefined && subscriptionTokenBalance > 0;
      if (shouldApplySubscriptionTokens && metaboxSubscriptionId) {
        const linkedSub = await db.localSubscription.findUnique({
          where: { metaboxSubscriptionId },
        });
        if (linkedSub && linkedSub.isActive) {
          console.log(
            `[sync-subscription] skip subTokens: metaboxSubscriptionId=${metaboxSubscriptionId} already linked + active`,
          );
          shouldApplySubscriptionTokens = false;
        }
      }

      // Idempotency check 2: token-pack credit по orderGrants.
      // Если передан per-order список — фильтруем уже выданные через
      // GrantedMetaboxOrder, считаем сумму только новых orderId'ов и
      // создаём записи в той же транзакции. Без orderGrants работаем
      // по-старому (legacy `tokenBalance` инкремент без dedup'а).
      let effectiveTokenBalance = tokenBalance !== undefined && tokenBalance > 0 ? tokenBalance : 0;
      const newOrderInserts: Array<{
        orderId: string;
        telegramId: bigint | null;
        tokens: number;
        description: string | null;
      }> = [];
      if (orderGrants && orderGrants.length > 0) {
        const existing = await db.grantedMetaboxOrder.findMany({
          where: { orderId: { in: orderGrants.map((g) => g.orderId) } },
          select: { orderId: true },
        });
        const grantedSet = new Set(existing.map((e) => e.orderId));
        const newGrants = orderGrants.filter((g) => !grantedSet.has(g.orderId));
        // Override legacy `tokenBalance` суммой новых orderGrants — источник
        // истины смещается на AiBotOrder list, чтобы pendingBotTokens-расхождения
        // (если есть) не мешали корректному зачислению.
        effectiveTokenBalance = newGrants.reduce((sum, g) => sum + g.tokens, 0);
        for (const grant of newGrants) {
          newOrderInserts.push({
            orderId: grant.orderId,
            // tgid может быть null для web-only юзеров; колонка теперь
            // допускает NULL (см. миграцию granted_metabox_order_telegram_nullable).
            telegramId: tgid,
            tokens: grant.tokens,
            description: grant.description ?? null,
          });
        }
        if (newGrants.length < orderGrants.length) {
          console.log(
            `[sync-subscription] dedup: ${orderGrants.length - newGrants.length}/${orderGrants.length} orders уже в GrantedMetaboxOrder, скипаем`,
          );
        }
      }

      // Apply user updates + GrantedMetaboxOrder inserts атомарно.
      const userData: Record<string, unknown> = {};
      if (shouldApplySubscriptionTokens) {
        userData.subscriptionTokenBalance = { increment: subscriptionTokenBalance! };
      }
      if (effectiveTokenBalance > 0) {
        userData.tokenBalance = { increment: effectiveTokenBalance };
      }

      const ops: Array<
        ReturnType<typeof db.user.update> | ReturnType<typeof db.grantedMetaboxOrder.create>
      > = [];
      if (Object.keys(userData).length > 0) {
        ops.push(db.user.update({ where: { id: userId }, data: userData }));
      }
      for (const insert of newOrderInserts) {
        ops.push(db.grantedMetaboxOrder.create({ data: insert }));
      }
      if (ops.length > 0) {
        await db.$transaction(ops);
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
    },
  );

  /**
   * POST /internal/unlink-subscription
   * Clears metaboxSubscriptionId on LocalSubscription (used by disconnect "keep in bot").
   */
  fastify.post(
    "/unlink-subscription",
    {
      schema: {
        description: "Unlink Metabox subscription from AI Box",
        body: {
          type: "object",
          properties: { telegramId: { type: "string" } },
          required: ["telegramId"],
        },
        response: {
          200: {
            additionalProperties: true,
            type: "object",
            properties: { ok: { type: "boolean" } },
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

      const tgid = BigInt(telegramId);
      const user = await db.user.findUnique({
        where: { telegramId: tgid },
        select: { id: true },
      });
      if (user) {
        await db.localSubscription
          .update({
            where: { userId: user.id },
            data: { metaboxSubscriptionId: null },
          })
          .catch(() => {
            /* no subscription to unlink — that's ok */
          });
      }

      return { ok: true };
    },
  );

  /**
   * POST /internal/revoke-tokens
   * Called by Metabox when a subscription expires or is revoked on the site.
   * Zeroes subscription balance, clears endDate/planName, deactivates local subscription record.
   * Body: { telegramId: string }
   */
  fastify.post(
    "/revoke-tokens",
    {
      schema: {
        description: "Revoke subscription tokens from user",
        body: {
          type: "object",
          properties: { telegramId: { type: "string" } },
          required: ["telegramId"],
        },
        response: {
          200: {
            additionalProperties: true,
            type: "object",
            properties: { ok: { type: "boolean" } },
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
        where: { telegramId: BigInt(telegramId) },
        select: { id: true },
      });
      if (!user) {
        return { ok: true }; // user not in bot — nothing to revoke
      }

      await expireSubscription(user.id);

      return { ok: true };
    },
  );

  /**
   * POST /internal/decrement-tokens
   * Called by Metabox admin when rolling back a token-pack purchase
   * (AiBotOrder / Order with token-pack). Decrements regular tokenBalance
   * by `tokens`, FLOORED at 0 (если юзер уже потратил часть пачки —
   * списываем сколько есть, в минус не уходим).
   *
   * НЕ трогает subscriptionTokenBalance и LocalSubscription — для
   * подписок отдельный путь /revoke-tokens.
   *
   * Body: { telegramId: string, tokens: number, description?: string }
   */
  fastify.post(
    "/decrement-tokens",
    {
      schema: {
        description: "Decrement user's token balance (rollback)",
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string" },
            tokens: { type: "number" },
            description: { type: "string" },
          },
          required: ["telegramId", "tokens"],
        },
        response: {
          200: {
            additionalProperties: true,
            type: "object",
            properties: {
              ok: { type: "boolean" },
              deducted: { type: "number" },
              newBalance: { type: "number" },
            },
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

      const user = await db.user.findUnique({
        where: { telegramId: BigInt(telegramId) },
      });
      if (!user) {
        return { ok: true, deducted: 0, newBalance: 0 };
      }
      const userId = user.id;

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
    },
  );

  /**
   * POST /internal/decrement-subscription-tokens
   * Called by Metabox admin when rolling back a bundle purchase that had
   * a granted bonus subscription. Decrements subscriptionTokenBalance by
   * `tokens`, FLOORED at 0.
   *
   * Если передан `metaboxSubscriptionId` — также УДАЛЯЕТ LocalSubscription,
   * у которой metaboxSubscriptionId совпадает. Это нужно при откате
   * бандла — бонус-подписка пропадает целиком, а не висит «пустым»
   * рекордом без токенов. Если у юзера в LocalSubscription другой
   * metaboxSubscriptionId [реальная подписка после бонуса] — она НЕ
   * трогается.
   *
   * Body: {
   *   telegramId: string,
   *   tokens: number,
   *   description?: string,
   *   metaboxSubscriptionId?: string,
   * }
   */
  fastify.post(
    "/decrement-subscription-tokens",
    {
      schema: {
        description: "Decrement subscription token balance (rollback)",
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string" },
            tokens: { type: "number" },
            description: { type: "string" },
            metaboxSubscriptionId: { type: "string" },
          },
          required: ["telegramId", "tokens"],
        },
        response: {
          200: {
            additionalProperties: true,
            type: "object",
            properties: {
              ok: { type: "boolean" },
              deducted: { type: "number" },
              newBalance: { type: "number" },
              localSubscriptionDeleted: { type: "boolean" },
            },
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

      const user = await db.user.findUnique({
        where: { telegramId: BigInt(telegramId) },
      });
      if (!user) {
        return { ok: true, deducted: 0, newBalance: 0, localSubscriptionDeleted: false };
      }
      const userId = user.id;

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
    },
  );

  /**
   * POST /internal/reset-token-balance
   * Sets user token balance to exactly 0. Used when admin disconnects TG
   * and transfers all tokens to site. More reliable than decrement.
   * Body: { telegramId: string }
   */
  fastify.post(
    "/reset-token-balance",
    {
      schema: {
        description: "Reset user's token balance to zero",
        body: {
          type: "object",
          properties: { telegramId: { type: "string" } },
          required: ["telegramId"],
        },
        response: {
          200: {
            additionalProperties: true,
            type: "object",
            properties: { ok: { type: "boolean" }, previousBalance: { type: "number" } },
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
        where: { telegramId: BigInt(telegramId) },
      });
      if (!user) return { ok: true };

      await db.user.update({
        where: { id: user.id },
        data: { tokenBalance: 0 },
      });

      return { ok: true, previousBalance: Number(user.tokenBalance) };
    },
  );

  /**
   * POST /internal/set-referrer
   * Called by Metabox admin when a user's mentor is changed on the site.
   *
   * Both mentee and new mentor are identified by Metabox User.id (UUID) —
   * the stable cross-system identifier. Bot looks them up via the
   * metaboxUserId column.
   */
  fastify.post(
    "/set-referrer",
    {
      schema: {
        description: "Set referrer for user",
        body: {
          type: "object",
          properties: {
            metaboxUserId: { type: "string" },
            newMentorMetaboxUserId: { type: "string", nullable: true },
          },
          required: ["metaboxUserId"],
        },
        response: {
          200: {
            additionalProperties: true,
            type: "object",
            properties: {
              ok: { type: "boolean" },
              applied: { type: "boolean" },
              referredById: { type: "string", nullable: true },
              reason: { type: "string" },
            },
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { metaboxUserId, newMentorMetaboxUserId } = request.body as {
        metaboxUserId?: string;
        newMentorMetaboxUserId?: string | null;
      };

      if (!metaboxUserId) {
        return reply.code(400).send({ error: "metaboxUserId is required" });
      }

      const mentee = await db.user.findFirst({
        where: { metaboxUserId },
        select: { id: true },
      });

      if (!mentee) {
        // User never started the bot — nothing to mirror.
        return { ok: true, applied: false, reason: "mentee_not_in_bot" };
      }

      let newReferredById: bigint | null = null;
      if (newMentorMetaboxUserId) {
        const mentor = await db.user.findFirst({
          where: { metaboxUserId: newMentorMetaboxUserId },
          select: { id: true },
        });
        // Если ментора в боте нет — пишем null. Сайт всё равно видит верную
        // структуру через свою БД, бот «дозаполнится» сам когда ментор начнёт
        // использовать бота (сейчас этого никто не делает, и это by design).
        newReferredById = mentor?.id ?? null;
      }

      await db.user.update({
        where: { id: mentee.id },
        data: { referredById: newReferredById },
      });

      return {
        ok: true,
        applied: true,
        referredById: newReferredById?.toString() ?? null,
      };
    },
  );

  /**
   * POST /internal/unlink-metabox
   * Called by Metabox admin when an admin disconnects a user's Telegram account.
   * Clears metaboxUserId and metaboxReferralCode from the AI Box user record.
   */
  fastify.post(
    "/unlink-metabox",
    {
      schema: {
        description: "Unlink Metabox from user account",
        body: {
          type: "object",
          properties: { telegramId: { type: "string" } },
          required: ["telegramId"],
        },
        response: {
          200: {
            additionalProperties: true,
            type: "object",
            properties: { ok: { type: "boolean" } },
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
        where: { telegramId: BigInt(telegramId) },
        select: { id: true },
      });

      if (!user) {
        return { ok: true }; // user never started the bot — nothing to unlink
      }

      await db.user.update({
        where: { id: user.id },
        data: { metaboxUserId: null, metaboxReferralCode: null },
      });

      return { ok: true };
    },
  );

  /**
   * GET /internal/user-balance?telegramId=<id>
   * Called by Metabox to get the current token balance of a bot user.
   * Returns { tokens: number } or 404 if user not found.
   */
  fastify.get<{ Querystring: { telegramId?: string } }>(
    "/user-balance",
    {
      schema: {
        description: "Get user's token balance",
        querystring: {
          type: "object",
          properties: { telegramId: { type: "string" } },
          required: ["telegramId"],
        },
        response: {
          200: {
            additionalProperties: true,
            type: "object",
            properties: { tokens: { type: "number" } },
          },
          400: badRequestResponse,
          404: {
            additionalProperties: true,
            type: "object",
            properties: { error: { type: "string" } },
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
        where: { telegramId: BigInt(telegramId) },
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
    },
  );

  /**
   * GET /internal/check-bot-user?telegramId=<id>
   * Called by Metabox to check whether a user has ever started the AI Box bot.
   * Returns { activated: true } if the user exists in the bot DB, { activated: false } otherwise.
   */
  fastify.get<{ Querystring: { telegramId?: string } }>(
    "/check-bot-user",
    {
      schema: {
        description: "Check if user has started the bot",
        querystring: {
          type: "object",
          properties: { telegramId: { type: "string" } },
          required: ["telegramId"],
        },
        response: {
          200: {
            additionalProperties: true,
            type: "object",
            properties: { activated: { type: "boolean" } },
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
        where: { telegramId: BigInt(telegramId) },
        select: { id: true },
      });
      return { activated: !!user };
    },
  );

  /**
   * POST /internal/save-subscription
   * Called by Metabox when admin disconnects TG and chooses "keep in bot".
   * Saves subscription data locally so bot can check it independently.
   * Body: { telegramId, planName, period, tokensGranted, endDate, startDate }
   */
  fastify.post(
    "/save-subscription",
    {
      schema: {
        description: "Save subscription data to AI Box",
        body: {
          type: "object",
          properties: {
            telegramId: { type: "string" },
            planName: { type: "string" },
            period: { type: "string" },
            tokensGranted: { type: "number" },
            endDate: { type: "string" },
            startDate: { type: "string" },
          },
          required: ["telegramId", "planName", "endDate"],
        },
        response: {
          200: {
            additionalProperties: true,
            type: "object",
            properties: { ok: { type: "boolean" } },
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

      const user = await db.user.findUnique({
        where: { telegramId: BigInt(telegramId) },
        select: { id: true },
      });
      if (!user) return { ok: true };

      await db.localSubscription.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
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
    },
  );

  /**
   * GET /internal/get-local-subscription?telegramId=<id>
   * GET /internal/get-local-subscription?aiboxUserId=<id>
   * Returns local subscription data if exists and active.
   */
  fastify.get<{ Querystring: { telegramId?: string; aiboxUserId?: string } }>(
    "/get-local-subscription",
    {
      schema: {
        description: "Get user's local subscription data",
        querystring: {
          type: "object",
          properties: {
            telegramId: { type: "string" },
            aiboxUserId: { type: "string" },
          },
        },
        response: {
          200: {
            additionalProperties: true,

            type: "object",
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { telegramId, aiboxUserId } = request.query;
      if (!telegramId && !aiboxUserId) {
        return reply.code(400).send({ error: "telegramId or aiboxUserId is required" });
      }

      // Резолвим юзера по любому из двух идентификаторов (приоритет — aiboxUserId).
      const user = aiboxUserId
        ? await db.user.findUnique({ where: { id: BigInt(aiboxUserId) }, select: { id: true } })
        : await db.user.findUnique({
            where: { telegramId: BigInt(telegramId!) },
            select: { id: true },
          });
      const sub = user
        ? await db.localSubscription.findUnique({ where: { userId: user.id } })
        : null;

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
   * POST /internal/consume-local-subscription
   * Called by Metabox when bot reconnects to a new site account.
   * Returns and deletes the local subscription data.
   * Body: { telegramId }
   */
  fastify.post(
    "/consume-local-subscription",
    {
      schema: {
        description: "Consume and delete local subscription data",
        body: {
          type: "object",
          properties: { telegramId: { type: "string" } },
          required: ["telegramId"],
        },
        response: {
          200: {
            additionalProperties: true,
            type: "object",
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
        where: { telegramId: BigInt(telegramId) },
        select: { id: true },
      });
      const sub = user
        ? await db.localSubscription.findUnique({ where: { userId: user.id } })
        : null;

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
    },
  );
};
