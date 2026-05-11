/**
 * /web/billing/* endpoints для ai.metabox.global.
 *
 * Работают через те же meta-box internal endpoints, что использует бот
 * (`subscription-invoice`, `aibot-invoice`). На вебе **не** используются
 * Telegram Stars (они работают только в miniapp).
 */

import type { FastifyPluginAsync } from "fastify";
import { webTelegramLinkedPreHandler } from "../middlewares/web-auth.js";
import {
  getAiBotCatalog,
  createSubscriptionInvoice,
  createAiBotInvoice,
  MetaboxApiError,
} from "../services/metabox-bridge.service.js";
import { logger } from "../logger.js";
import { constructOpenAPIonRouteHook, badRequestResponse } from "../utils/openapi.js";

export const webBillingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", webTelegramLinkedPreHandler);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["web-billing"]),
  );

  // ── GET /web/billing/catalog ────────────────────────────────────────────
  /**
   * Получение каталога подписок и токен-пакетов для покупки на вебе.
   */
  fastify.get(
    "/web/billing/catalog",
    {
      schema: {
        description: "Catalog of subscriptions and token packages for purchase",
        response: {
          200: {
            type: "object",
            properties: {
              subscriptions: {
                type: "array",
                description: "Available subscriptions",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Subscription ID" },
                    name: { type: "string", description: "Subscription name" },
                    tokens: { type: "number", description: "Monthly token allowance" },
                    periods: {
                      type: "object",
                      description: "Available billing periods with prices",
                      additionalProperties: {
                        type: "object",
                        properties: {
                          priceRub: { type: "string", description: "Price in RUB" },
                          discountPct: { type: "number", description: "Discount percentage" },
                        },
                      },
                    },
                  },
                  required: ["id", "name", "tokens", "periods"],
                },
              },
              tokenPackages: {
                type: "array",
                description: "Available token packages",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Package ID" },
                    name: { type: "string", description: "Package name" },
                    tokens: { type: "number", description: "Number of tokens" },
                    priceRub: { type: "string", description: "Price in RUB" },
                    badge: { type: "string", nullable: true, description: "Badge (e.g., 'Popular')" },
                  },
                  required: ["id", "name", "tokens", "priceRub"],
                },
              },
            },
            required: ["subscriptions", "tokenPackages"],
          },
          502: {
            description: "Catalog temporarily unavailable",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      try {
        const catalog = await getAiBotCatalog();

        // Нормализуем подписки: M1 всегда есть, M3/M6/M12 — по скидкам
        const subscriptions = catalog.subscriptions.map((sub) => {
          const monthly = Number(sub.priceMonthly);
          const d3 = Number(sub.discount3m);
          const d6 = Number(sub.discount6m);
          const d12 = Number(sub.discount12m);

          const periods: Record<string, { priceRub: string; discountPct: number }> = {};
          periods.M1 = { priceRub: Math.round(monthly).toFixed(2), discountPct: 0 };
          if (d3 > 0)
            periods.M3 = {
              priceRub: Math.round(monthly * 3 * (1 - d3 / 100)).toFixed(2),
              discountPct: d3,
            };
          if (d6 > 0)
            periods.M6 = {
              priceRub: Math.round(monthly * 6 * (1 - d6 / 100)).toFixed(2),
              discountPct: d6,
            };
          if (d12 > 0)
            periods.M12 = {
              priceRub: Math.round(monthly * 12 * (1 - d12 / 100)).toFixed(2),
              discountPct: d12,
            };

          return {
            id: sub.id,
            name: sub.name,
            tokens: sub.tokens,
            periods,
          };
        });

        const tokenPackages = catalog.tokenPackages.map((p) => ({
          id: p.id,
          name: p.name,
          tokens: p.tokens,
          priceRub: p.priceRub,
          badge: p.badge,
        }));

        return { subscriptions, tokenPackages };
      } catch (err) {
        logger.error({ err }, "web/billing/catalog: metabox unavailable");
        return reply.code(502).send({ error: "Каталог временно недоступен" });
      }
    },
  );

  // ── POST /web/billing/subscription-invoice ──────────────────────────────
  /**
   * Создание заказа на подписку. Возвращает URL для оплаты.
   */
  fastify.post<{ Body: { planId?: string; period?: string } }>(
    "/web/billing/subscription-invoice",
    {
      schema: {
        description: "Create subscription order",
        body: {
          type: "object",
          properties: {
            planId: { type: "string", description: "Subscription ID from catalog" },
            period: { type: "string", description: "Subscription period (M1, M3, M6, M12)" },
          },
          required: ["planId", "period"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              orderId: { type: "string", description: "Created order ID" },
              paymentUrl: { type: "string", description: "Payment URL" },
            },
            required: ["orderId", "paymentUrl"],
          },
          400: badRequestResponse,
          502: {
            description: "Failed to create order",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { aibUserId, metaboxUserId } = request.webUser!;
      const { planId, period } = request.body ?? {};
      if (!planId || !period) return reply.code(400).send({ error: "planId и period обязательны" });
      if (!["M1", "M3", "M6", "M12"].includes(period))
        return reply.code(400).send({ error: "Некорректный period" });

      try {
        const result = await createSubscriptionInvoice({
          metaboxUserId,
          planId,
          period,
          telegramId: aibUserId!,
        });
        return reply.send({
          orderId: result.subscriptionId,
          paymentUrl: result.paymentUrl,
        });
      } catch (err) {
        if (err instanceof MetaboxApiError) {
          return reply.code(err.status >= 500 ? 502 : err.status).send({ error: err.message });
        }
        logger.error({ err }, "web/billing/subscription-invoice failed");
        return reply.code(502).send({ error: "Не удалось создать заказ" });
      }
    },
  );

  // ── POST /web/billing/tokens-invoice ────────────────────────────────────
  /**
   * Создание заказа на токен-пакет. Возвращает URL для оплаты.
   */
  fastify.post<{ Body: { productId?: string } }>(
    "/web/billing/tokens-invoice",
    {
      schema: {
        description: "Create token package order",
        body: {
          type: "object",
          properties: {
            productId: { type: "string", description: "Token package ID from catalog" },
          },
          required: ["productId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              orderId: { type: "string", description: "Created order ID" },
              paymentUrl: { type: "string", description: "Payment URL" },
            },
            required: ["orderId", "paymentUrl"],
          },
          400: badRequestResponse,
          502: {
            description: "Failed to create order",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { aibUserId, metaboxUserId } = request.webUser!;
      const { productId } = request.body ?? {};
      if (!productId) return reply.code(400).send({ error: "productId обязателен" });

      try {
        const result = await createAiBotInvoice({
          metaboxUserId,
          productId,
          telegramId: aibUserId!,
        });
        return reply.send({
          orderId: result.orderId,
          paymentUrl: result.paymentUrl,
        });
      } catch (err) {
        if (err instanceof MetaboxApiError) {
          return reply.code(err.status >= 500 ? 502 : err.status).send({ error: err.message });
        }
        logger.error({ err }, "web/billing/tokens-invoice failed");
        return reply.code(502).send({ error: "Не удалось создать заказ" });
      }
    },
  );

  // ── GET /web/billing/order/:id/status ───────────────────────────────────
  /**
   * Получение статуса заказа. Прокси в meta-box API.
   * Используется для polling со страницы ожидания оплаты.
   */
  fastify.get<{ Params: { id: string } }>(
    "/web/billing/order/:id/status",
    {
      schema: {
        description: "Get order status",
        params: {
          type: "object",
          properties: {
            id: { type: "string", description: "Order ID" },
          },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", description: "Order status (PENDING etc.)" },
            },
            required: ["status"],
          },
          502: {
            description: "Failed to get status",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { config } = await import("@metabox/shared");
      const url = `${config.metabox.apiUrl}/api/internal/alt-order-status?orderId=${encodeURIComponent(id)}`;
      try {
        const res = await fetch(url, {
          headers: { "X-Internal-Key": config.metabox.internalKey ?? "" },
        });
        if (!res.ok) {
          return reply.code(res.status).send({ error: await res.text() });
        }
        const data = (await res.json()) as { status?: string };
        return reply.send({ status: data.status ?? "PENDING" });
      } catch (err) {
        logger.error({ err }, "order status proxy failed");
        return reply.code(502).send({ error: "Не удалось получить статус" });
      }
    },
  );
};
