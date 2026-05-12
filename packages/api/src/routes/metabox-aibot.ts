/**
 * Routes for buying AI tokens via Metabox (card payment).
 * Only available to users who have linked their Metabox account.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { db } from "../db.js";
import { getAiBotProducts, createAiBotInvoice } from "../services/metabox-bridge.service.js";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";

type AuthRequest = FastifyRequest & { userId: bigint };

export const metaboxAibotRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["metabox"]));

  /**
   * GET /metabox-aibot/products
   * Returns the list of AI token packages available for purchase via Metabox (Lava.top).
   */
  fastify.get(
    "/metabox-aibot/products",
    {
      schema: {
        description: "Get available token packages for purchase",
        response: {
          200: { type: "array", items: { type: "object", additionalProperties: true } },
          503: {
            type: "object",
            additionalProperties: true,
            properties: { error: { type: "string" } },
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
        description: "Create payment invoice for token package",
        body: {
          type: "object",
          properties: { productId: { type: "string", description: "Product ID" } },
          required: ["productId"],
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
