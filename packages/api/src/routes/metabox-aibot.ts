/**
 * Routes for buying AI tokens via Metabox (card payment).
 * Only available to users who have linked their Metabox account.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { db } from "../db.js";
import { getAiBotProducts, createAiBotInvoice } from "../services/metabox-bridge.service.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

type AuthRequest = FastifyRequest & { userId: bigint };

export const metaboxAibotRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["metabox-aibot"]),
  );

  /**
   * GET /metabox-aibot/products
   * Returns the list of AI token packages available for purchase via Metabox (Lava.top).
   */
  fastify.get(
    "/metabox-aibot/products",
    {
      schema: {
        response: {
          200: {
            type: "array",
            description: "List of AI token packages available for purchase",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Product ID" },
                name: { type: "string", description: "Product name" },
                tokens: { type: "number", description: "Number of tokens included" },
                price: { type: "number", description: "Price in RUB" },
                description: { type: "string", nullable: true, description: "Product description" },
              },
              required: ["id", "name", "tokens", "price"],
            },
          },
          503: {
            description: "Metabox products unavailable",
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
        const products = await getAiBotProducts();
        return products;
      } catch (e) {
        fastify.log.error(e, "[metabox-aibot/products]");
        return reply.code(503).send({ error: "Metabox products unavailable" });
      }
    },
  );

  /**
   * POST /metabox-aibot/buy
   * Creates an AiBotOrder on Metabox and returns a Lava payment URL.
   * Body: { productId: string }
   * Returns: { paymentUrl: string }
   */
  fastify.post(
    "/metabox-aibot/buy",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            productId: {
              type: "string",
              description: "ID of the product to purchase",
            },
          },
          required: ["productId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              paymentUrl: {
                type: "string",
                description: "URL for completing the payment via Lava.top",
              },
            },
            required: ["paymentUrl"],
          },
          400: {
            description: "Missing productId",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
          409: {
            description: "Metabox account not linked",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
          502: {
            description: "Failed to create payment invoice",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { userId } = request as AuthRequest;
      const { productId } = request.body as { productId?: string };

      if (!productId) {
        return reply.code(400).send({ error: "productId is required" });
      }

      const user = await db.user.findUnique({
        where: { id: userId },
        select: { metaboxUserId: true },
      });

      if (!user?.metaboxUserId) {
        return reply.code(409).send({ error: "Metabox account not linked" });
      }

      try {
        const result = await createAiBotInvoice({
          metaboxUserId: user.metaboxUserId,
          productId,
          telegramId: userId,
        });
        return { paymentUrl: result.paymentUrl };
      } catch (e) {
        fastify.log.error(e, "[metabox-aibot/buy]");
        return reply.code(502).send({ error: "Failed to create payment invoice" });
      }
    },
  );
};
