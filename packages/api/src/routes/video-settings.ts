import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { userStateService } from "../services/user-state.service.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

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
        response: {
          200: {
            type: "object",
            description: "Video settings per model",
            additionalProperties: {
              type: "object",
              properties: {
                aspectRatio: {
                  type: "string",
                  nullable: true,
                  description: "Selected aspect ratio",
                },
                duration: {
                  type: "number",
                  nullable: true,
                  description: "Selected duration in seconds",
                },
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
        body: {
          type: "object",
          properties: {
            modelId: { type: "string", description: "Model identifier" },
            aspectRatio: { type: "string", description: "Aspect ratio (e.g., 16:9, 9:16)" },
            duration: { type: "number", description: "Duration in seconds" },
          },
          required: ["modelId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
            },
            required: ["success"],
          },
          400: {
            description: "Bad request",
            type: "object",
            properties: {
              statusCode: { type: "number" },
              message: { type: "string" },
            },
          },
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
