import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { userStateService } from "../services/user-state.service.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

type AuthRequest = FastifyRequest & { userId: bigint };

export const imageSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["image-settings"]),
  );

  /** GET /image-settings — returns { [modelId]: { aspectRatio } } */
  fastify.get(
    "/image-settings",
    {
      schema: {
        response: {
          200: {
						examples: [
							{
								"gpt-4": {
									"aspectRatio": "16:9"
								}
							}
						],
            type: "object",
            description: "Map of model IDs to their image settings (aspect ratio)",
            additionalProperties: {
              type: "object",
              properties: {
                aspectRatio: {
                  type: "string",
                  description: "The selected aspect ratio for this model (e.g., '16:9', '1:1', '9:16')",
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { userId } = request as AuthRequest;
      const settings = await userStateService.getImageSettings(userId);
      return settings;
    },
  );

  /** PATCH /image-settings — save aspect ratio for a model */
  fastify.patch<{ Body: { modelId: string; aspectRatio: string } }>(
    "/image-settings",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            modelId: {
              type: "string",
              description: "ID of the model to set aspect ratio for",
            },
            aspectRatio: {
              type: "string",
              description: "Aspect ratio to set (e.g., '16:9', '1:1', '9:16')",
            },
          },
          required: ["modelId", "aspectRatio"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: {
                type: "boolean",
                description: "Whether the setting was saved successfully",
              },
            },
            required: ["success"],
          },
          400: {
            type: "object",
            description: "Invalid request - missing required fields",
            properties: {
              statusCode: {
                type: "number",
              },
              message: {
                type: "string",
              },
            },
          },
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
