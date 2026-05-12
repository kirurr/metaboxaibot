import type { FastifyPluginAsync } from "fastify";
import { verifyTelegramInitData } from "../middlewares/telegram-auth.js";
import { db } from "../db.js";
import { verifyWebToken, config } from "@metabox/shared";
import { badRequestResponse, userIsBlockedResponse } from "../utils/openapi.js";

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /auth/verify
   * Verifies Telegram initData and returns the user's public profile.
   * Used by the Mini App on startup to confirm auth and load user data.
   */
  fastify.post<{ Body: { initData: string } }>(
    "/auth/verify",
    {
      schema: {
        description: "Verify Telegram initData and return user profile",
        security: [],
        body: {
          type: "object",
          properties: {
            initData: { type: "string", description: "Telegram WebApp initData string" },
          },
          required: ["initData"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              id: { type: "string", description: "User ID" },
              username: { type: "string", nullable: true, description: "Telegram username" },
              firstName: { type: "string", nullable: true, description: "User first name" },
              language: { type: "string", description: "User language code" },
              tokenBalance: { type: "string", description: "User token balance" },
              referredById: { type: "string", nullable: true, description: "Referrer user ID" },
            },
          },
          400: badRequestResponse,
          401: {
            type: "object",
            additionalProperties: true,
            description: "Invalid initData hash or timing validation failed",
            properties: { error: { type: "string" } },
          },
          403: userIsBlockedResponse,
          404: {
            type: "object",
            additionalProperties: true,
            description: "User not found — open the bot first",
            properties: {
              error: { type: "string" },
              code: { type: "string", enum: ["USER_NOT_FOUND"] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { initData } = request.body;
      if (!initData) return reply.code(400).send({ error: "initData is required" });

      let userId: bigint;
      try {
        userId = verifyTelegramInitData(initData);
      } catch {
        return reply.code(401).send({ error: "Invalid initData" });
      }

      const user = await db.user.findUnique({ where: { id: userId } });
      if (!user) {
        return reply
          .code(404)
          .send({ error: "User not found — open the bot first", code: "USER_NOT_FOUND" });
      }
      if (user.isBlocked) return reply.code(403).send({ error: "User is blocked" });

      return {
        id: user.id.toString(),
        username: user.username ?? null,
        firstName: user.firstName ?? null,
        language: user.language,
        tokenBalance: user.tokenBalance.toString(),
        referredById: user.referredById?.toString() ?? null,
      };
    },
  );

  /**
   * POST /auth/webtoken
   * Validates a URL-based HMAC token issued by the bot for KeyboardButtonWebApp launches,
   * where Telegram's requestSimpleWebView intentionally does not inject initData.
   */
  fastify.post<{ Body: { token: string } }>(
    "/auth/webtoken",
    {
      schema: {
        description: "Validate URL-based HMAC token for webview launches",
        security: [],
        body: {
          type: "object",
          properties: {
            token: { type: "string", description: "HMAC token from bot" },
          },
          required: ["token"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              id: { type: "string", description: "User ID" },
              username: { type: "string", nullable: true, description: "Telegram username" },
              firstName: { type: "string", nullable: true, description: "User first name" },
              language: { type: "string", description: "User language code" },
              tokenBalance: { type: "string", description: "User token balance" },
              referredById: { type: "string", nullable: true, description: "Referrer user ID" },
            },
          },
          400: badRequestResponse,
          401: {
            type: "object",
            additionalProperties: true,
            description: "Invalid or expired token",
            properties: { error: { type: "string" } },
          },
          403: userIsBlockedResponse,
          404: {
            type: "object",
            additionalProperties: true,
            description: "User not found — open the bot first",
            properties: {
              error: { type: "string" },
              code: { type: "string", enum: ["USER_NOT_FOUND"] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { token } = request.body;
      if (!token) return reply.code(400).send({ error: "token is required" });

      let userId: bigint;
      try {
        userId = verifyWebToken(token, config.bot.token);
      } catch {
        return reply.code(401).send({ error: "Invalid or expired token" });
      }

      const user = await db.user.findUnique({ where: { id: userId } });
      if (!user) {
        return reply
          .code(404)
          .send({ error: "User not found — open the bot first", code: "USER_NOT_FOUND" });
      }
      if (user.isBlocked) return reply.code(403).send({ error: "User is blocked" });

      return {
        id: user.id.toString(),
        username: user.username ?? null,
        firstName: user.firstName ?? null,
        language: user.language,
        tokenBalance: user.tokenBalance.toString(),
        referredById: user.referredById?.toString() ?? null,
      };
    },
  );
};
