import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { userStateService } from "../services/user-state.service.js";
import { constructOpenAPIonRouteHook, badRequestResponse } from "../utils/openapi.js";

type AuthRequest = FastifyRequest & { userId: bigint };

export const videoSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["video-settings"]),
  );

  /** GET /video-settings — returns { [modelId]: { aspectRatio?, duration? } } */
  fastify.get(
    "/video-settings",
    {
      schema: {
        description: "Get user video settings per model",
        response: {
          200: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                aspectRatio: { type: "string", nullable: true },
                duration: { type: "number", nullable: true },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { userId } = request as AuthRequest;
      return userStateService.getVideoSettings(userId);
    },
  );

  /** PATCH /video-settings — save aspect ratio and/or duration for a model */
  fastify.patch<{ Body: { modelId: string; aspectRatio?: string; duration?: number } }>(
    "/video-settings",
    {
      schema: {
        description: "Update video settings for a model",
        body: {
          type: "object",
          properties: {
            modelId: { type: "string" },
            aspectRatio: { type: "string" },
            duration: { type: "number" },
          },
          required: ["modelId"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              success: { type: "boolean" },
            },
          },
          400: badRequestResponse,
        },
      },
    },
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
