import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { userStateService } from "../services/user-state.service.js";

type AuthRequest = FastifyRequest & { userId: bigint };

export const imageSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);

  /** GET /image-settings — returns { [modelId]: { aspectRatio } } */
  fastify.get("/image-settings", async (request) => {
    const { userId } = request as AuthRequest;
    const settings = await userStateService.getImageSettings(userId);
    return settings;
  });

  /** PATCH /image-settings — save aspect ratio for a model */
  fastify.patch<{ Body: { modelId: string; aspectRatio: string } }>(
    "/image-settings",
    async (request) => {
      const { userId } = request as AuthRequest;
      const { modelId, aspectRatio } = request.body;
      if (!modelId || !aspectRatio) {
        throw { statusCode: 400, message: "modelId and aspectRatio are required" };
      }
      await userStateService.setImageAspectRatio(userId, modelId, aspectRatio);
      return { success: true };
    },
  );
};
