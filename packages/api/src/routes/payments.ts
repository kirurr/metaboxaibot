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
import { getRate, calcStars, STAR_PRICE_USD } from "../services/exchange-rate.service.js";
import type { SaleUserInfo } from "../services/payment.service.js";
import { constructOpenAPIonRouteHook, badRequestResponse } from "../utils/openapi.js";

type AuthRequest = FastifyRequest & { userId: bigint };

export const paymentsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["payments"]),
  );

  /** POST /payments/invoice — create Telegram Stars invoice for a product or subscription */
  fastify.post<{
    Body: { type: "product" | "subscription"; id: string; period?: string; planId?: string };
  }>(
    "/payments/invoice",
    {
      schema: {
        description: "Create Telegram Stars invoice for product or subscription",
        body: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["product", "subscription"],
              description: "Type of purchase: product or subscription",
            },
            id: {
              type: "string",
              description: "Product ID or subscription plan ID from catalog",
            },
            period: {
              type: "string",
              description: "Subscription period (M1, M3, M6, M12) - required for subscriptions",
            },
            planId: {
              type: "string",
              description: "Legacy field for backward compatibility - use either type+id or planId",
            },
          },
          required: ["type", "id"],
        },
        response: {
          200: {
            oneOf: [
              {
                type: "object",
                properties: {
                  invoiceUrl: { type: "string", description: "Telegram Stars invoice URL" },
                },
                required: ["invoiceUrl"],
              },
              {
                type: "object",
                properties: {
                  testMode: { type: "boolean", description: "Indicates test mode was used" },
                  message: { type: "string", description: "Test mode completion message" },
                },
                required: ["testMode", "message"],
              },
            ],
          },
          400: badRequestResponse,
          404: {
            type: "object",
            properties: { error: { type: "string", description: "Product or subscription not found" } },
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
    const rate = await getRate();

    const isTestMode = false; // Always use real Telegram Stars payments
    const { userId } = request as AuthRequest;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, username: true, referredById: true },
    });

    if (type === "product") {
      const product = catalog.tokenPackages.find((p) => p.id === id);
      if (!product) return reply.code(404).send({ error: "Product not found" });

      const stars = calcStars(Number(product.priceRub), rate);
      const starRate = rate * STAR_PRICE_USD;

      // Test mode: skip Telegram Invoice, credit directly
      if (isTestMode) {
        const userInfo: SaleUserInfo = {
          firstName: user?.firstName ?? "Test",
          lastName: user?.lastName ?? undefined,
          username: user?.username ?? undefined,
          referrerTelegramId: user?.referredById ?? undefined,
          stars,
          starRate,
        };
        await paymentService.creditDynamicPurchase(
          userId,
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
      const stars = calcStars(totalPrice, rate);
      const starRate = rate * STAR_PRICE_USD;

      // Test mode: skip Telegram Invoice, credit directly
      if (isTestMode) {
        const userInfo: SaleUserInfo = {
          firstName: user?.firstName ?? "Test",
          lastName: user?.lastName ?? undefined,
          username: user?.username ?? undefined,
          referrerTelegramId: user?.referredById ?? undefined,
          stars,
          starRate,
        };
        await paymentService.creditDynamicPurchase(
          userId,
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
  });

  /** POST /payments/card-invoice — create card payment invoice via Metabox/Lava */
  fastify.post<{
    Body: { type: "product" | "subscription"; id: string; period?: string };
  }>(
    "/payments/card-invoice",
    {
      schema: {
        description: "Create card payment invoice via Metabox/Lava",
        body: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["product", "subscription"],
              description: "Type of purchase: product or subscription",
            },
            id: {
              type: "string",
              description: "Product ID or subscription plan ID from catalog",
            },
            period: {
              type: "string",
              description: "Subscription period (M1, M3, M6, M12) - required for subscriptions",
            },
          },
          required: ["type", "id"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              paymentUrl: { type: "string", description: "Card payment URL" },
            },
            required: ["paymentUrl"],
          },
          400: badRequestResponse,
          409: {
            type: "object",
            properties: { error: { type: "string", description: "Metabox account not linked" } },
          },
          502: {
            type: "object",
            properties: { error: { type: "string", description: "Failed to create payment invoice" } },
          },
        },
      },
    },
    async (request, reply) => {
    const { userId } = request as AuthRequest;
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
          telegramId: userId,
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
          telegramId: userId,
        });
        return { paymentUrl: result.paymentUrl };
      }

      return reply.code(400).send({ error: "Invalid type" });
    } catch (e) {
      fastify.log.error(e, "[payments/card-invoice]");
      return reply.code(502).send({ error: "Failed to create payment invoice" });
    }
  });
};
