import type { FastifyPluginAsync } from "fastify";
import { verifyTelegramInitData } from "../middlewares/telegram-auth.js";
import { db } from "../db.js";
import { verifyWebToken, config } from "@metabox/shared";

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /auth/verify
   * Verifies Telegram initData and returns the user's public profile.
   * Used by the Mini App on startup to confirm auth and load user data.
   */
  fastify.post<{ Body: { initData: string } }>("/auth/verify", async (request, reply) => {
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
  });

  /**
   * POST /auth/webtoken
   * Validates a URL-based HMAC token issued by the bot for KeyboardButtonWebApp launches,
   * where Telegram's requestSimpleWebView intentionally does not inject initData.
   */
  fastify.post<{ Body: { token: string } }>("/auth/webtoken", async (request, reply) => {
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
  });
};
