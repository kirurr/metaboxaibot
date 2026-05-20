/**
 * Middleware для packages/web endpoints.
 * Проверяет Authorization: Bearer <access_token>, возвращает User.id.
 *
 * Не пересекается с telegram-auth.ts — там своя логика для miniapp/бота.
 */

import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from "fastify";
import { verifyAccessToken, type AccessTokenClaims } from "../services/web-session.service.js";
import { db } from "../db.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Выставляется `webAuthPreHandler` после проверки JWT.
     * aibUserId === null означает: юзер зарегистрирован на вебе,
     * но ещё не привязал Telegram — доступ к чатам/токенам/галерее запрещён.
     *
     * telegramId — tgid для вызовов Metabox API, которые ключуются по tgid
     * (subscription-invoice, aibot-invoice, partner-balance). null когда
     * aibUserId есть, но `User.telegramId` не выставлен (web-only без TG).
     */
    webUser?: {
      metaboxUserId: string;
      aibUserId: bigint | null;
      telegramId: bigint | null;
      sessionId: string;
    };
  }
}

export async function extractWebUserFromRequest(
  request: FastifyRequest,
): Promise<FastifyRequest["webUser"] | null> {
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return null;

  let claims: AccessTokenClaims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    return null;
  }

  let aibUserId: bigint | null = null;
  let telegramId: bigint | null = null;
  if (claims.aib) {
    const user = await db.user.findUnique({
      where: { id: BigInt(claims.aib) },
      select: { id: true, telegramId: true, isBlocked: true },
    });
    if (!user) return null;
    if (user.isBlocked) return null;
    aibUserId = user.id;
    telegramId = user.telegramId;
  }

  return {
    metaboxUserId: claims.sub,
    aibUserId,
    telegramId,
    sessionId: claims.sid,
  };
}

/** preHandler — пропускает авторизованных на веб; TG может быть не привязан. */
export const webAuthPreHandler: preHandlerHookHandler = async (request, reply) => {
  const user = await extractWebUserFromRequest(request);
  if (!user) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  request.webUser = user;
};

/**
 * Pre-handler для endpoints, которые требуют привязанного Telegram.
 * Возвращает 403 `TELEGRAM_NOT_LINKED` если юзер ещё не связал бота.
 * Фронт показывает модалку «Привяжите Telegram» по этому коду.
 */
export const webTelegramLinkedPreHandler: preHandlerHookHandler = async (request, reply) => {
  const user = await extractWebUserFromRequest(request);
  if (!user) return reply.code(401).send({ error: "Unauthorized" });
  if (user.aibUserId === null) {
    return reply.code(403).send({ error: "Telegram is not linked", code: "TELEGRAM_NOT_LINKED" });
  }
  request.webUser = user;
};

/**
 * Проверяет CSRF-token для мутирующих запросов.
 * Для GET не требуется. Применяется после webAuthPreHandler.
 */
export function requireCsrf(
  request: FastifyRequest,
  reply: FastifyReply,
  expected: string,
): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const given = request.headers["x-csrf-token"];
  if (!given || given !== expected) {
    reply.code(403).send({ error: "Invalid CSRF token" });
    return false;
  }
  return true;
}
