import { createHmac } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db.js";
import { config, generateWebToken, verifyWebToken, WebTokenError } from "@metabox/shared";

/**
 * Verifies a Telegram Mini App initData string.
 * Returns the parsed user_id if valid, throws otherwise.
 */
export function verifyTelegramInitData(initDataRaw: string): bigint {
  const params = new URLSearchParams(initDataRaw);
  const hash = params.get("hash");
  if (!hash) throw new Error("Missing hash in initData");

  params.delete("hash");

  // Build data_check_string: sorted key=value pairs joined by \n
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  // HMAC-SHA256("WebAppData", botToken) → secret key
  const secretKey = createHmac("sha256", "WebAppData").update(config.bot.token).digest();
  // HMAC-SHA256(dataCheckString, secretKey)
  const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) throw new Error("Invalid initData hash");

  const userRaw = params.get("user");
  if (!userRaw) throw new Error("No user in initData");
  const user = JSON.parse(userRaw) as { id: number };
  return BigInt(user.id);
}

/**
 * Fastify preHandler that verifies Telegram initData from the
 * "Authorization: tma {initDataRaw}" header.
 *
 * Sets:
 *  - `request.telegramId` — tgid из initData (для send-to-Telegram операций).
 *  - `request.userId` — внутренний `User.id` (для FK-запросов в БД).
 *
 * Lookup идёт по `telegramId` — после миграции на surrogate PK `id` и `telegramId`
 * у новых юзеров не совпадают, и нельзя полагаться на `id == tgid`.
 */
export async function telegramAuthHook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader) {
    return reply.code(401).send({ error: "Missing Telegram auth" });
  }

  let telegramId: bigint;
  // Сохраняем материал для rolling-refresh: если auth прошёл, но впереди
  // user-check может зарезать запрос (404/403) — не выписываем свежий wtoken
  // на нелегитимные ответы.
  let wtokenRefreshIat: number | null = null;
  if (authHeader.startsWith("tma ")) {
    try {
      telegramId = verifyTelegramInitData(authHeader.slice(4));
    } catch (err) {
      return reply.code(401).send({ error: "Invalid Telegram auth", detail: String(err) });
    }
  } else if (authHeader.startsWith("wtoken ")) {
    // URL-based HMAC token issued by the bot for KeyboardButtonWebApp launches
    try {
      const result = verifyWebToken(authHeader.slice(7), config.bot.token);
      telegramId = result.userId;
      if (result.needsRefresh) wtokenRefreshIat = result.iat;
    } catch (err) {
      const code =
        err instanceof WebTokenError && err.code === "EXPIRED" ? "TOKEN_EXPIRED" : "TOKEN_INVALID";
      return reply.code(401).send({ error: "Invalid web token", code, detail: String(err) });
    }
  } else {
    return reply.code(401).send({ error: "Unsupported auth scheme" });
  }

  // Lookup по telegramId — id у новых web-only юзеров перестанет совпадать с tgid.
  const user = await db.user.findUnique({ where: { telegramId } });
  if (!user) return reply.code(404).send({ error: "User not found" });
  if (user.isBlocked) return reply.code(403).send({ error: "User is blocked" });

  if (wtokenRefreshIat !== null) {
    // Rolling refresh: токен прошёл середину TTL — выписываем свежий с тем же
    // `iat` (сохраняем absolute cap) и отдаём в response-header. Webapp client
    // его подхватит и продолжит ходить уже с новым.
    reply.header(
      "X-Refresh-Wtoken",
      generateWebToken(telegramId, config.bot.token, wtokenRefreshIat),
    );
  }

  (
    request as FastifyRequest & {
      userId: bigint;
      telegramId: bigint;
      user: {
        id: bigint;
        telegramId: bigint | null;
        username: string | null;
        firstName: string | null;
        lastName: string | null;
        language: string;
        isNew: boolean;
        isBlocked: boolean;
        referredById: bigint | null;
        metaboxUserId: string | null;
        metaboxReferralCode: string | null;
        createdAt: Date;
        updatedAt: Date;
      };
    }
  ).user = user;
  (request as FastifyRequest & { userId: bigint; telegramId: bigint }).userId = user.id;
  (request as FastifyRequest & { userId: bigint; telegramId: bigint }).telegramId = telegramId;
}
