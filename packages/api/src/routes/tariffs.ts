import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { db } from "../db.js";
import { config } from "@metabox/shared";
import { getAiBotCatalog } from "../services/metabox-bridge.service.js";
import { calcStars } from "../services/exchange-rate.service.js";
import type { AiBotCatalog } from "../services/metabox-bridge.service.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

type AuthRequest = FastifyRequest & { userId: bigint };

/** Empty catalog when Metabox API is unavailable — no fallback to hardcoded plans */
function emptyCatalog(): AiBotCatalog {
  return { subscriptions: [], tokenPackages: [] };
}

export const tariffsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["tariffs"]),
  );

  /**
   * GET /tariffs/catalog
   * Returns unified catalog of subscriptions + token packages with Stars prices.
   * Returns empty catalog if Metabox API is unavailable.
   */
  fastify.get(
    "/tariffs/catalog",
    {
      schema: {
        description:
          "Returns unified catalog of subscriptions and token packages with Stars prices. Returns empty catalog if Metabox API is unavailable.",
        response: {
          200: {
            type: "object",
            properties: {
              subscriptions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    tokens: { type: "string" },
                    periods: {
                      type: "object",
                      additionalProperties: {
                        type: "object",
                        properties: {
                          priceRub: { type: "string" },
                          stars: { type: "number" },
                        },
                      },
                    },
                  },
                },
              },
              tokenPackages: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    tokens: { type: "string" },
                    priceRub: { type: "string" },
                    stars: { type: "number" },
                    badge: { type: "string" },
                  },
                },
              },
              canPayByCard: { type: "boolean" },
              hasPaidSubscription: { type: "boolean" },
              starPriceRub: { type: "number" },
              metaboxUrl: { type: "string" },
            },
          },
        },
      },
    },
    async (request) => {
      const { userId } = request as AuthRequest;

      // Fetch catalog from Metabox (with fallback) + user + sub.
      // Курс USDT/RUB больше не нужен — звёзды считаем напрямую из priceRub
      // через config.payments.starPriceRub.
      const [catalog, user, localSub] = await Promise.all([
        getAiBotCatalog().catch((err) => {
          console.error("[tariffs/catalog] Metabox catalog unavailable:", err.message);
          return emptyCatalog();
        }),
        db.user.findUnique({
          where: { id: userId },
          select: { metaboxUserId: true, role: true },
        }),
        db.localSubscription.findUnique({
          where: { userId },
          select: { planName: true, isActive: true, endDate: true },
        }),
      ]);

      // Триал НЕ считается платной подпиской — для гейта покупки пакетов токенов.
      const hasPaidSubscription =
        user?.role === "ADMIN" ||
        !!(
          localSub &&
          localSub.isActive &&
          localSub.endDate > new Date() &&
          localSub.planName !== "Trial"
        );

      // Enrich subscriptions with Stars prices — only include available periods
      const subscriptions = catalog.subscriptions.map((sub) => {
        const monthly = Number(sub.priceMonthly);
        const d3 = Number(sub.discount3m);
        const d6 = Number(sub.discount6m);
        const d12 = Number(sub.discount12m);

        // M1 is always available; other periods only if discount > 0
        const periods: Record<string, { priceRub: string; stars: number }> = {};

        const priceM1 = Math.round(monthly);
        periods.M1 = { priceRub: priceM1.toFixed(2), stars: calcStars(priceM1) };

        if (d3 > 0) {
          const priceM3 = Math.round(monthly * 3 * (1 - d3 / 100));
          periods.M3 = { priceRub: priceM3.toFixed(2), stars: calcStars(priceM3) };
        }
        if (d6 > 0) {
          const priceM6 = Math.round(monthly * 6 * (1 - d6 / 100));
          periods.M6 = { priceRub: priceM6.toFixed(2), stars: calcStars(priceM6) };
        }
        if (d12 > 0) {
          const priceM12 = Math.round(monthly * 12 * (1 - d12 / 100));
          periods.M12 = { priceRub: priceM12.toFixed(2), stars: calcStars(priceM12) };
        }

        return {
          id: sub.id,
          name: sub.name,
          tokens: sub.tokens,
          periods,
        };
      });

      // Enrich token packages with Stars prices
      const tokenPackages = catalog.tokenPackages.map((pkg) => ({
        id: pkg.id,
        name: pkg.name,
        tokens: pkg.tokens,
        priceRub: pkg.priceRub,
        stars: calcStars(Number(pkg.priceRub)),
        badge: pkg.badge,
      }));

      return {
        subscriptions,
        tokenPackages,
        canPayByCard: !!user?.metaboxUserId,
        hasPaidSubscription,
        starPriceRub: config.payments.starPriceRub,
        metaboxUrl: config.metabox.apiUrl || "https://app.meta-box.ru",
      };
    },
  );
};
