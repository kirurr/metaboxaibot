/**
 * Web-auth endpoints для ai.metabox.global (packages/web).
 *
 * НИКАК не пересекается с /auth/* (Telegram miniapp) — у них свои URL.
 * Все роуты здесь имеют префикс /auth/web-.
 *
 * Flow регистрации (Вариант C):
 *   1. POST /auth/web-signup  → создаёт MetaBox User (через meta-box /api/internal/web-register)
 *      AI Box User НЕ создаётся — будет создан ботом когда юзер сделает /start linkweb_<state>
 *   2. POST /auth/web-login   → валидирует креды через meta-box /api/internal/web-validate-credentials
 *      Если AI Box User с таким metaboxUserId уже есть (был привязан TG ранее) — подтягиваем его
 *   3. Endpoints чата/токенов/галереи требуют привязанного TG (см. webTelegramLinkedPreHandler)
 */

import type { FastifyPluginAsync } from "fastify";
import { logger } from "../logger.js";
import { db } from "../db.js";
import {
  webValidateCredentials,
  webRegister,
  webRequestPasswordReset,
  webConfirmPasswordReset,
  webChangePassword,
  webGetProfile,
  MetaboxApiError,
} from "../services/metabox-bridge.service.js";
import {
  signAccessToken,
  createRefreshSession,
  getRefreshSession,
  touchRefreshSession,
  revokeRefreshSession,
  sessionIdFromRefresh,
  canRequestPasswordReset,
  createLinkTelegramState,
  checkLinkTelegramLinked,
} from "../services/web-session.service.js";
import { extractWebUserFromRequest, webAuthPreHandler } from "../middlewares/web-auth.js";
import { config } from "@metabox/shared";
import { validateEmail } from "../utils/email-validation.js";

const REFRESH_COOKIE_NAME = "aibw_refresh";

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 255;
}

function isStrongPassword(s: string): boolean {
  return typeof s === "string" && s.length >= 8 && s.length <= 128;
}

function cookieOptions(maxAgeSec: number) {
  const secure =
    config.web.cookieSecure === "true"
      ? true
      : config.web.cookieSecure === "false"
        ? false
        : config.env === "production";
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: maxAgeSec,
    domain: config.web.cookieDomain,
  };
}

/**
 * Найти / подтянуть AI Box User по metaboxUserId. Null если не привязан ещё.
 */
async function findAibUser(metaboxUserId: string) {
  return db.user.findFirst({
    where: { metaboxUserId },
    select: {
      id: true,
      username: true,
      firstName: true,
      lastName: true,
      language: true,
      tokenBalance: true,
      subscriptionTokenBalance: true,
      isBlocked: true,
      role: true,
    },
  });
}

/**
 * Собирает user-объект для отдачи на фронт. Смешивает данные из meta-box и AI Box.
 */
async function buildWebUserResponse(args: {
  metaboxUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  telegramOnSite?: { telegramId: string | null; telegramUsername: string | null };
}) {
  const aib = await findAibUser(args.metaboxUserId);

  const telegramId = aib ? aib.id.toString() : (args.telegramOnSite?.telegramId ?? null);
  const telegramUsername = aib?.username ?? args.telegramOnSite?.telegramUsername ?? null;

  return {
    id: aib?.id.toString() ?? null,
    metaboxUserId: args.metaboxUserId,
    email: args.email,
    firstName: aib?.firstName ?? args.firstName,
    lastName: aib?.lastName ?? args.lastName,
    avatar: null as string | null,
    language: (aib?.language as "ru" | "en" | undefined) ?? "ru",
    telegramId,
    telegramUsername,
    isTelegramLinked: !!aib,
    tokenBalance: aib?.tokenBalance.toString() ?? "0",
    subscriptionTokenBalance: aib?.subscriptionTokenBalance.toString() ?? "0",
    role: aib?.role ?? "USER",
    createdAt: new Date().toISOString(),
  };
}

/** Единый helper: создать refresh-сессию, выдать access token, поставить cookie. */
async function issueSession(
  reply: any,
  params: {
    metaboxUserId: string;
    aibUserId: string | null;
    email: string;
    firstName: string | null;
    rememberMe: boolean;
    userAgent?: string;
    ip?: string;
  },
) {
  const { refreshToken, csrfToken, session } = await createRefreshSession({
    metaboxUserId: params.metaboxUserId,
    aibUserId: params.aibUserId,
    email: params.email,
    firstName: params.firstName,
    rememberMe: params.rememberMe,
    userAgent: params.userAgent,
    ip: params.ip,
  });

  const { token: accessToken, expiresAt: accessTokenExpiresAt } = signAccessToken({
    sub: params.metaboxUserId,
    aib: params.aibUserId ?? undefined,
    sid: sessionIdFromRefresh(refreshToken),
  });

  const refreshMaxAge = Math.floor((session.expiresAt - Date.now()) / 1000);
  reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, cookieOptions(refreshMaxAge));

  return { accessToken, accessTokenExpiresAt, csrfToken };
}

export const webAuthRoutes: FastifyPluginAsync = async (fastify) => {
  // Fail-fast проверка конфигурации при регистрации плагина.
  // Если секретов нет — web-auth не запускается, но остальной API работает (бот, TG-миниапп).
  if (!config.web.jwtSecret) {
    logger.warn(
      "[web-auth] WEB_JWT_SECRET не задан — /auth/web-* будут возвращать 503. " +
        "Сгенерируйте: openssl rand -hex 32 и положите в .env",
    );
  }
  if (!config.metabox.apiUrl || !config.metabox.internalKey) {
    logger.warn(
      "[web-auth] METABOX_API_URL/INTERNAL_KEY не заданы — login/signup/reset работать не будут.",
    );
  }

  // Middleware: если базовая конфигурация неполная — возвращаем 503 вместо 500.
  fastify.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/auth/web-")) return;
    if (!config.web.jwtSecret) {
      return reply.code(503).send({
        error: "Web auth не настроен на сервере (WEB_JWT_SECRET отсутствует).",
        code: "WEB_AUTH_NOT_CONFIGURED",
      });
    }
  });
  // ── POST /auth/web-signup ────────────────────────────────────────────────
  fastify.post<{
    Body: {
      email?: string;
      password?: string;
      firstName?: string;
      referralCode?: string;
    };
  }>("/auth/web-signup", { schema: { hide: true } as any }, async (request, reply) => {
    try {
      const { email = "", password = "", firstName = "", referralCode } = request.body ?? {};
      const emailNorm = email.toLowerCase().trim();
      const firstNameNorm = firstName.trim();

      if (!isValidEmail(emailNorm)) return reply.code(400).send({ error: "Некорректный email" });
      if (!isStrongPassword(password))
        return reply.code(400).send({ error: "Пароль должен быть не короче 8 символов" });
      if (firstNameNorm.length < 1 || firstNameNorm.length > 100)
        return reply.code(400).send({ error: "Укажите имя" });

      // MX-проверка домена. Опечатки внутри валидных доменов
      // (gmail.co и т.п.) ловит фронт через suggestEmailTypo.
      const emailCheck = await validateEmail(emailNorm);
      if (!emailCheck.ok) {
        return reply.code(400).send({
          error:
            emailCheck.reason === "syntax"
              ? "Некорректный email"
              : "Указан несуществующий email-домен. Проверьте адрес и попробуйте снова.",
        });
      }

      let registered;
      try {
        registered = await webRegister({
          email: emailNorm,
          password,
          firstName: firstNameNorm,
          referralCode,
        });
      } catch (err) {
        if (err instanceof MetaboxApiError) {
          if (err.status === 409)
            return reply.code(409).send({ error: "Email уже зарегистрирован" });
          if (err.status === 400) return reply.code(400).send({ error: err.message });
        }
        logger.error({ err }, "web-signup: metabox register failed");
        return reply.code(502).send({ error: "Не удалось создать аккаунт" });
      }

      const { accessToken, accessTokenExpiresAt, csrfToken } = await issueSession(reply, {
        metaboxUserId: registered.metaboxUserId,
        aibUserId: null, // регистрация на вебе не создаёт AI Box User
        email: registered.email,
        firstName: registered.firstName,
        rememberMe: true,
        userAgent: request.headers["user-agent"],
        ip: request.ip,
      });

      const user = await buildWebUserResponse({
        metaboxUserId: registered.metaboxUserId,
        email: registered.email,
        firstName: registered.firstName,
        lastName: registered.lastName,
      });

      return reply.send({ user, accessToken, accessTokenExpiresAt, csrfToken });
    } catch (err) {
      logger.error({ err, path: "/auth/web-signup" }, "web-signup: uncaught error");
      return reply.code(500).send({ error: "Внутренняя ошибка. Попробуйте позже." });
    }
  });

  // ── POST /auth/web-login ─────────────────────────────────────────────────
  fastify.post<{
    Body: { email?: string; password?: string; rememberMe?: boolean };
  }>("/auth/web-login", { schema: { hide: true } as any }, async (request, reply) => {
    try {
      const { email = "", password = "", rememberMe = true } = request.body ?? {};
      const emailNorm = email.toLowerCase().trim();

      if (!isValidEmail(emailNorm) || !password)
        return reply.code(400).send({ error: "Email и пароль обязательны" });

      let validated;
      try {
        validated = await webValidateCredentials({ email: emailNorm, password });
      } catch (err) {
        if (err instanceof MetaboxApiError) {
          if (err.status === 401)
            return reply.code(401).send({ error: "Неверный email или пароль" });
          if (err.status === 403)
            return reply.code(403).send({ error: err.message || "Вход запрещён" });
        }
        logger.error({ err }, "web-login: metabox validate failed");
        return reply.code(502).send({ error: "Временная ошибка. Попробуйте позже." });
      }

      const aib = await findAibUser(validated.metaboxUserId);

      const { accessToken, accessTokenExpiresAt, csrfToken } = await issueSession(reply, {
        metaboxUserId: validated.metaboxUserId,
        aibUserId: aib?.id.toString() ?? null,
        email: validated.email,
        firstName: validated.firstName,
        rememberMe,
        userAgent: request.headers["user-agent"],
        ip: request.ip,
      });

      const user = await buildWebUserResponse({
        metaboxUserId: validated.metaboxUserId,
        email: validated.email,
        firstName: validated.firstName,
        lastName: validated.lastName,
      });

      return reply.send({ user, accessToken, accessTokenExpiresAt, csrfToken });
    } catch (err) {
      logger.error({ err, path: "/auth/web-login" }, "web-login: uncaught error");
      return reply.code(500).send({ error: "Внутренняя ошибка. Попробуйте позже." });
    }
  });

  // ── POST /auth/web-refresh ───────────────────────────────────────────────
  fastify.post("/auth/web-refresh", { schema: { hide: true } as any }, async (request, reply) => {
    const refreshToken = (request as any).cookies?.[REFRESH_COOKIE_NAME];
    if (!refreshToken) return reply.code(401).send({ error: "No refresh token" });

    const session = await getRefreshSession(refreshToken);
    if (!session) return reply.code(401).send({ error: "Session expired" });

    // Рестартуем: может быть, юзер привязал TG между рефрешами — проверяем
    const aib = await findAibUser(session.metaboxUserId);
    session.aibUserId = aib?.id.toString() ?? null;

    const { csrfToken } = await touchRefreshSession(refreshToken, session);

    const { token: accessToken, expiresAt: accessTokenExpiresAt } = signAccessToken({
      sub: session.metaboxUserId,
      aib: session.aibUserId ?? undefined,
      sid: sessionIdFromRefresh(refreshToken),
    });

    return reply.send({ accessToken, accessTokenExpiresAt, csrfToken });
  });

  // ── POST /auth/web-logout ────────────────────────────────────────────────
  fastify.post("/auth/web-logout", { schema: { hide: true } as any }, async (request, reply) => {
    const refreshToken = (request as any).cookies?.[REFRESH_COOKIE_NAME];
    if (refreshToken) await revokeRefreshSession(refreshToken);
    reply.clearCookie(REFRESH_COOKIE_NAME, {
      path: "/",
      domain: config.web.cookieDomain,
    });
    return reply.send({ ok: true });
  });

  // ── GET /auth/web-me ─────────────────────────────────────────────────────
  fastify.get(
    "/auth/web-me",
    { preHandler: webAuthPreHandler, schema: { hide: true } as any },
    async (request, reply) => {
      const { metaboxUserId } = request.webUser!;

      // Тянем актуальный профиль из meta-box (на случай, если юзер поменял имя и т.п.)
      let profile: Awaited<ReturnType<typeof webGetProfile>> | null = null;
      try {
        profile = await webGetProfile({ metaboxUserId });
      } catch (err) {
        logger.warn({ err, metaboxUserId }, "web-me: metabox profile fetch failed");
      }

      const user = await buildWebUserResponse({
        metaboxUserId,
        email: profile?.email ?? "",
        firstName: profile?.firstName ?? null,
        lastName: profile?.lastName ?? null,
        telegramOnSite: profile
          ? {
              telegramId: profile.telegramId,
              telegramUsername: profile.telegramUsername,
            }
          : undefined,
      });

      // CSRF перевыдаём при каждом /me (ротация)
      const refreshToken = (request as any).cookies?.[REFRESH_COOKIE_NAME];
      let csrfToken = "";
      if (refreshToken) {
        const session = await getRefreshSession(refreshToken);
        if (session) {
          const r = await touchRefreshSession(refreshToken, session);
          csrfToken = r.csrfToken;
        }
      }

      return reply.send({ user, csrfToken });
    },
  );

  // ── POST /auth/web-forgot-password ──────────────────────────────────────
  fastify.post<{ Body: { email?: string } }>(
    "/auth/web-forgot-password",
    { schema: { hide: true } as any },
    async (request, reply) => {
      const email = (request.body?.email ?? "").toLowerCase().trim();
      if (!isValidEmail(email)) {
        // Отвечаем 200 — чтобы нельзя было энумерировать email-ы
        return reply.send({ ok: true });
      }

      const allowed = await canRequestPasswordReset(email);
      if (!allowed) return reply.send({ ok: true }); // тихий throttle

      const frontBase = config.web.frontUrl ?? "https://ai.metabox.global";
      const resetUrlBase = `${frontBase.replace(/\/$/, "")}/reset-password?token=`;

      try {
        await webRequestPasswordReset({ email, resetUrlBase });
      } catch (err) {
        logger.warn({ err, email }, "web-forgot-password: metabox call failed");
        // не раскрываем клиенту
      }
      return reply.send({ ok: true });
    },
  );

  // ── POST /auth/web-reset-password ───────────────────────────────────────
  fastify.post<{ Body: { token?: string; newPassword?: string } }>(
    "/auth/web-reset-password",
    { schema: { hide: true } as any },
    async (request, reply) => {
      const { token = "", newPassword = "" } = request.body ?? {};
      if (!token || !isStrongPassword(newPassword))
        return reply.code(400).send({ error: "Некорректные данные" });

      try {
        await webConfirmPasswordReset({ token, newPassword });
      } catch (err) {
        if (err instanceof MetaboxApiError && (err.status === 400 || err.status === 410)) {
          return reply.code(400).send({ error: err.message || "Токен недействителен" });
        }
        logger.error({ err }, "web-reset-password failed");
        return reply.code(502).send({ error: "Не удалось обновить пароль" });
      }
      return reply.send({ ok: true });
    },
  );

  // ── POST /auth/web-change-password ──────────────────────────────────────
  fastify.post<{ Body: { oldPassword?: string; newPassword?: string } }>(
    "/auth/web-change-password",
    { preHandler: webAuthPreHandler, schema: { hide: true } as any },
    async (request, reply) => {
      const { oldPassword = "", newPassword = "" } = request.body ?? {};
      if (!oldPassword || !isStrongPassword(newPassword))
        return reply.code(400).send({ error: "Некорректные данные" });

      const { metaboxUserId } = request.webUser!;
      try {
        await webChangePassword({ metaboxUserId, oldPassword, newPassword });
      } catch (err) {
        if (err instanceof MetaboxApiError && err.status === 401)
          return reply.code(401).send({ error: "Старый пароль неверен" });
        logger.error({ err }, "web-change-password failed");
        return reply.code(502).send({ error: "Не удалось сменить пароль" });
      }
      return reply.send({ ok: true });
    },
  );

  // ── POST /auth/web-unlink-telegram ──────────────────────────────────────
  fastify.post(
    "/auth/web-unlink-telegram",
    { preHandler: webAuthPreHandler, schema: { hide: true } as any },
    async (request, reply) => {
      const { metaboxUserId } = request.webUser!;
      // На AI Box стороне зачищаем связь. Сам User остаётся — у него есть история.
      await db.user.updateMany({
        where: { metaboxUserId },
        data: { metaboxUserId: null, metaboxReferralCode: null },
      });
      // Сразу рефрешим сессию — JWT при следующем /me/refresh уже не будет иметь aib.
      const refreshToken = (request as any).cookies?.[REFRESH_COOKIE_NAME];
      if (refreshToken) {
        const session = await getRefreshSession(refreshToken);
        if (session) {
          session.aibUserId = null;
          await touchRefreshSession(refreshToken, session);
        }
      }
      return reply.send({ ok: true });
    },
  );

  // ── POST /auth/web-link-telegram/init ───────────────────────────────────
  fastify.post(
    "/auth/web-link-telegram/init",
    { preHandler: webAuthPreHandler, schema: { hide: true } as any },
    async (request, reply) => {
      const { metaboxUserId } = request.webUser!;
      const state = await createLinkTelegramState(metaboxUserId);
      const botUsername =
        process.env.AIBOX_BOT_USERNAME || process.env.BOT_USERNAME || "metabox_ai_bot";
      return reply.send({
        deepLinkUrl: `https://t.me/${botUsername}?start=linkweb_${state}`,
        state,
      });
    },
  );

  // ── POST /auth/web-link-telegram/status ─────────────────────────────────
  fastify.post<{ Body: { state?: string } }>(
    "/auth/web-link-telegram/status",
    { preHandler: webAuthPreHandler, schema: { hide: true } as any },
    async (request, reply) => {
      const state = request.body?.state ?? "";
      if (!state) return reply.code(400).send({ error: "state is required" });
      const result = await checkLinkTelegramLinked(state);
      if (!result) return reply.send({ linked: false, telegramUsername: null });

      // Если привязка прошла — сразу "освежаем" сессию, чтобы на фронте появился aibUserId
      const refreshToken = (request as any).cookies?.[REFRESH_COOKIE_NAME];
      if (refreshToken) {
        const session = await getRefreshSession(refreshToken);
        if (session) {
          const aib = await findAibUser(session.metaboxUserId);
          session.aibUserId = aib?.id.toString() ?? null;
          await touchRefreshSession(refreshToken, session);
        }
      }

      return reply.send({ linked: true, telegramUsername: result.telegramUsername });
    },
  );
};

// Экспортируем имя для /auth/web-* чтобы его нельзя было перепутать с Telegram /auth/verify
export { extractWebUserFromRequest };
