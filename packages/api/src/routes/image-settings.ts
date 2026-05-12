import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { userStateService } from "../services/user-state.service.js";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";
type AuthRequest = FastifyRequest & { userId: bigint };

export const imageSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["settings"]));

  /** GET /image-settings — returns { [modelId]: { aspectRatio } } */
  fastify.get("/image-settings", async (request) => {
    const { userId } = request as AuthRequest;
    const settings = await userStateService.getImageSettings(userId);
    return settings;
  });

  /** PATCH /image-settings — save aspect ratio for a model */
  fastify.patch<{ Body: { modelId: string; aspectRatio: string } }>(
    "/image-settings",
    {
      schema: {
        description: "Save aspect ratio preference for a model",
        body: {
          type: "object",
          properties: {
            modelId: { type: "string", description: "Model ID" },
            aspectRatio: { type: "string", description: "Aspect ratio (e.g., 1:1, 16:9)" },
          },
          required: ["modelId", "aspectRatio"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { success: { type: "boolean" } },
          },
          400: badRequestResponse,
        },
      },
    },
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
