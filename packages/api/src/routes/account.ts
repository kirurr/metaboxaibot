import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { initiateAccountDeletion } from "../services/account-deletion.service.js";
import { logger } from "../logger.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

type AuthRequest = FastifyRequest & { userId: bigint };

/**
 * Routes для self-service удаления аккаунта.
 * Запускается из mini-app: пользователь нажал "Подтвердить" в модалке "Удалить аккаунт".
 * Backend генерит код, отправляет его в чат бота, ставит state AWAITING_DELETE_CONFIRMATION.
 * Дальнейшие шаги (ввод кода, финальный confirm, execute) — внутри бота.
 */
export const accountRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["admin"]));

  fastify.post(
    "/account/delete-initiate",
    {
      schema: {
        description: "Initiate account deletion process",
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
          },
          500: {
            type: "object",
            additionalProperties: true,
            properties: {
              error: { type: "string" },
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
