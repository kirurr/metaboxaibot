import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { paymentService } from "../services/payment.service.js";
import { db } from "../db.js";
import {
  getAiBotCatalog,
  createAiBotInvoice,
  createSubscriptionInvoice,
} from "../services/metabox-bridge.service.js";
import type { AiBotCatalog } from "../services/metabox-bridge.service.js";
import { calcStars } from "../services/exchange-rate.service.js";
import type { SaleUserInfo } from "../services/payment.service.js";
import { config } from "@metabox/shared";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";

// `userId` — внутренний `User.id` (FK). `telegramId` — tgid для recordSale / Telegram API.
type AuthRequest = FastifyRequest & { userId: bigint; telegramId: bigint };

export const paymentsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["payments"]));

  /** POST /payments/invoice — create Telegram Stars invoice for a product or subscription */
  fastify.post<{
    Body: { type: "product" | "subscription"; id: string; period?: string; planId?: string };
  }>(
    "/payments/invoice",
    {
      schema: {
        description: "Create Telegram Stars invoice for payment",
        body: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["product", "subscription"],
              description: "Payment type",
            },
            id: { type: "string", description: "Product or subscription ID" },
            period: { type: "string", description: "Subscription period (M1, M3, M6, M12)" },
            planId: { type: "string", description: "Legacy plan ID" },
          },
          required: ["type", "id"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { invoiceUrl: { type: "string" } },
          },
          400: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
            description: "type and id are required, or invalid type/subscription period",
          },
          404: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
            description: "Product not found or Subscription plan not found",
          },
        },
      },
    },
    async (request, reply) => {
      const { type, id, period, planId: legacyPlanId } = request.body;

      // Legacy support: old format with planId
      if (legacyPlanId && !type) {
        const invoiceUrl = await paymentService.createInvoiceLink(legacyPlanId);
        return { invoiceUrl };
      }

      if (!type || !id) {
        return reply.code(400).send({ error: "type and id are required" });
      }

      const catalog = await getAiBotCatalog().catch((err): AiBotCatalog => {
        console.error("[payments/invoice] Metabox catalog unavailable:", err.message);
        return { subscriptions: [], tokenPackages: [] };
      });

      // RUB-эквивалент одной звезды Telegram — единственная «настраиваемая»
      // ставка для расчёта инвойсов в Stars и записи starRate в Metabox.
      const starRate = config.payments.starPriceRub;

      const isTestMode = false; // Always use real Telegram Stars payments
      const { userId, telegramId } = request as AuthRequest;
      const user = await db.user.findUnique({
        where: { id: userId },
        select: {
          firstName: true,
          lastName: true,
          username: true,
          referredById: true,
          referredBy: { select: { telegramId: true } },
        },
      });
      // referredById — внутренний FK; для Metabox нужен tgid реферрера.
      const referrerTelegramId = user?.referredBy?.telegramId ?? undefined;

      if (type === "product") {
        const product = catalog.tokenPackages.find((p) => p.id === id);
        if (!product) return reply.code(404).send({ error: "Product not found" });

        const stars = calcStars(Number(product.priceRub));

        // Test mode: skip Telegram Invoice, credit directly
        if (isTestMode) {
          const userInfo: SaleUserInfo = {
            firstName: user?.firstName ?? "Test",
            lastName: user?.lastName ?? undefined,
            username: user?.username ?? undefined,
            referrerTelegramId,
            stars,
            starRate,
          };
          await paymentService.creditDynamicPurchase(
            userId,
            telegramId,
            product.tokens,
            product.id,
            Number(product.priceRub),
            "product",
            undefined,
            userInfo,
            product.name,
          );
          return { testMode: true, message: "Тестовая оплата: токены начислены" };
        }

        const invoiceUrl = await paymentService.createDynamicInvoice({
          title: `${product.name} — ${product.tokens} tokens`,
          description: `${product.tokens} AI tokens for use in Metabox`,
          payload: `product:${product.id}:${product.tokens}:${product.priceRub}:${product.name}`,
          stars,
        });
        return { invoiceUrl };
      }

      if (type === "subscription") {
        if (!period || !["M1", "M3", "M6", "M12"].includes(period)) {
          return reply.code(400).send({ error: "Valid period is required (M1/M3/M6/M12)" });
        }

        const sub = catalog.subscriptions.find((s) => s.id === id);
        if (!sub) return reply.code(404).send({ error: "Subscription plan not found" });

        const monthly = Number(sub.priceMonthly);
        const months = period === "M1" ? 1 : period === "M3" ? 3 : period === "M6" ? 6 : 12;
        const discountField =
          period === "M3"
            ? sub.discount3m
            : period === "M6"
              ? sub.discount6m
              : period === "M12"
                ? sub.discount12m
                : "0";
        const totalPrice = monthly * months * (1 - Number(discountField) / 100);
        const tokens = sub.tokens * months;
        const stars = calcStars(totalPrice);

        // Test mode: skip Telegram Invoice, credit directly
        if (isTestMode) {
          const userInfo: SaleUserInfo = {
            firstName: user?.firstName ?? "Test",
            lastName: user?.lastName ?? undefined,
            username: user?.username ?? undefined,
            referrerTelegramId,
            stars,
            starRate,
          };
          await paymentService.creditDynamicPurchase(
            userId,
            telegramId,
            tokens,
            sub.id,
            Math.round(totalPrice),
            "subscription",
            period,
            userInfo,
            sub.name,
          );
          return { testMode: true, message: "Тестовая оплата: подписка активирована" };
        }

        const invoiceUrl = await paymentService.createDynamicInvoice({
          title: `${sub.name} — ${period} (${tokens} tokens)`,
          description: `AI subscription: ${tokens} tokens`,
          payload: `subscription:${sub.id}:${period}:${tokens}:${Math.round(totalPrice)}:${sub.name}`,
          stars,
        });
        return { invoiceUrl };
      }

      return reply.code(400).send({ error: "Invalid type" });
    },
  );

  /** POST /payments/card-invoice — create card payment invoice via Metabox/Lava */
  fastify.post<{
    Body: { type: "product" | "subscription"; id: string; period?: string };
  }>(
    "/payments/card-invoice",
    {
      schema: {
        description: "Create card payment invoice via Metabox",
        body: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["product", "subscription"],
              description: "Payment type",
            },
            id: { type: "string", description: "Product or subscription ID" },
            period: { type: "string", description: "Subscription period (M1, M3, M6, M12)" },
          },
          required: ["type", "id"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { paymentUrl: { type: "string" } },
          },
          400: badRequestResponse,
          409: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
          502: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { userId, telegramId } = request as AuthRequest;
      const { type, id, period } = request.body;

      if (!type || !id) {
        return reply.code(400).send({ error: "type and id are required" });
      }

      const user = await db.user.findUnique({
        where: { id: userId },
        select: { metaboxUserId: true },
      });

      if (!user?.metaboxUserId) {
        return reply.code(409).send({ error: "Metabox account not linked" });
      }

      try {
        if (type === "product") {
          const result = await createAiBotInvoice({
            metaboxUserId: user.metaboxUserId,
            productId: id,
            telegramId,
          });
          return { paymentUrl: result.paymentUrl };
        }

        if (type === "subscription") {
          if (!period || !["M1", "M3", "M6", "M12"].includes(period)) {
            return reply.code(400).send({ error: "Valid period is required" });
          }
          const result = await createSubscriptionInvoice({
            metaboxUserId: user.metaboxUserId,
            planId: id,
            period,
            telegramId,
          });
          return { paymentUrl: result.paymentUrl };
        }

        return reply.code(400).send({ error: "Invalid type" });
      } catch (e) {
        fastify.log.error(e, "[payments/card-invoice]");
        return reply.code(502).send({ error: "Failed to create payment invoice" });
      }
    },
  );
};
