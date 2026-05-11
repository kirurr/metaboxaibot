import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { userStateService } from "../services/user-state.service.js";

type AuthRequest = FastifyRequest & { userId: bigint };

export const videoSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);

  /** GET /video-settings — returns { [modelId]: { aspectRatio?, duration? } } */
  fastify.get("/video-settings", async (request) => {
    const { userId } = request as AuthRequest;
    return userStateService.getVideoSettings(userId);
  });

  /** PATCH /video-settings — save aspect ratio and/or duration for a model */
  fastify.patch<{ Body: { modelId: string; aspectRatio?: string; duration?: number } }>(
    "/video-settings",
    async (request) => {
      const { userId } = request as AuthRequest;
      const { modelId, aspectRatio, duration } = request.body;
      if (!modelId) {
        throw { statusCode: 400, message: "modelId is required" };
      }
      if (aspectRatio === undefined && duration === undefined) {
        throw { statusCode: 400, message: "aspectRatio or duration is required" };
      }
      await userStateService.setVideoSetting(userId, modelId, { aspectRatio, duration });
      return { success: true };
    },
  );
};
