import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { initiateAccountDeletion } from "../services/account-deletion.service.js";
import { logger } from "../logger.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

type AuthRequest = FastifyRequest & { userId: bigint };

/**
 * Routes for self-service account deletion.
 * Initiated from mini-app: user clicks "Confirm" in "Delete account" modal.
 * Backend generates code, sends it to bot chat, sets state AWAITING_DELETE_CONFIRMATION.
 * Further steps (code input, final confirm, execute) happen in the bot.
 */
export const accountRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["account"]),
  );

  /**
   * Initiate account deletion process. Sends confirmation code to user's bot chat.
   */
  fastify.post(
    "/account/delete-initiate",
    {
      schema: {
        description: "Initiate account deletion process",
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean", description: "Whether the initiation was successful" },
            },
            required: ["ok"],
          },
          500: {
            type: "object",
            properties: {
              error: { type: "string", description: "Failed to initiate account deletion" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { userId } = request as AuthRequest;
      try {
        await initiateAccountDeletion(userId);
        return { ok: true };
      } catch (err) {
        logger.error({ err, userId: userId.toString() }, "[/account/delete-initiate] failed");
        return reply.status(500).send({ error: "Failed to initiate account deletion" });
      }
    },
  );
};
