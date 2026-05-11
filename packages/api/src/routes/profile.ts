import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { db } from "../db.js";
import {
  issueSsoToken,
  issueSsoTokenRemote,
  MetaboxApiError,
} from "../services/metabox-bridge.service.js";
import { config } from "@metabox/shared";
import { validateEmail } from "../utils/email-validation.js";

type AuthRequest = FastifyRequest & {
  userId: bigint;
  user: {
    id: bigint;
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
};

// ── Rate limit для metabox-resend-verification ────────────────────────────
// Хранится в памяти процесса. При рестарте бота сбрасывается — это OK.
const RESEND_MAX_ATTEMPTS = 3;
const RESEND_COOLDOWN_SEC = 60;
const RESEND_WINDOW_MS = 60 * 60 * 1000; // окно учёта 1 час

interface ResendState {
  attempts: number;
  lastAttemptAt: number;
  windowStartedAt: number;
}
const resendState = new Map<string, ResendState>();

function getResendAttempts(userId: bigint): number {
  return resendState.get(userId.toString())?.attempts ?? 0;
}

function checkResendLimit(userId: bigint): {
  allowed: boolean;
  reason?: string;
  retryAfterSec?: number;
  attemptsLeft?: number;
} {
  const key = userId.toString();
  const now = Date.now();
  const state = resendState.get(key);

  if (!state) {
    return { allowed: true, attemptsLeft: RESEND_MAX_ATTEMPTS };
  }

  // Окно протекло — лимит сбрасывается при следующей попытке.
  if (now - state.windowStartedAt > RESEND_WINDOW_MS) {
    return { allowed: true, attemptsLeft: RESEND_MAX_ATTEMPTS };
  }

  // Превышен общий лимит в окне.
  if (state.attempts >= RESEND_MAX_ATTEMPTS) {
    const retryAfterMs = RESEND_WINDOW_MS - (now - state.windowStartedAt);
    return {
      allowed: false,
      reason: "Превышен лимит повторных отправок. Попробуйте позже.",
      retryAfterSec: Math.ceil(retryAfterMs / 1000),
      attemptsLeft: 0,
    };
  }

  // Cooldown между отправками.
  const sinceLast = now - state.lastAttemptAt;
  if (sinceLast < RESEND_COOLDOWN_SEC * 1000) {
    return {
      allowed: false,
      reason: "Подождите перед повторной отправкой.",
      retryAfterSec: Math.ceil((RESEND_COOLDOWN_SEC * 1000 - sinceLast) / 1000),
      attemptsLeft: RESEND_MAX_ATTEMPTS - state.attempts,
    };
  }

  return { allowed: true, attemptsLeft: RESEND_MAX_ATTEMPTS - state.attempts };
}

function recordResendAttempt(userId: bigint): void {
  const key = userId.toString();
  const now = Date.now();
  const state = resendState.get(key);

  if (!state || now - state.windowStartedAt > RESEND_WINDOW_MS) {
    resendState.set(key, {
      attempts: 1,
      lastAttemptAt: now,
      windowStartedAt: now,
    });
    return;
  }

  state.attempts += 1;
  state.lastAttemptAt = now;
}

function resetResendLimit(userId: bigint): void {
  resendState.delete(userId.toString());
}

export const profileRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);

  /** GET /profile — balance + last 20 transactions */
  fastify.get("/profile", async (request) => {
    const { userId } = request as AuthRequest;

    const [user, transactions] = await Promise.all([
      db.user.findUnique({ where: { id: userId } }),
      db.tokenTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);

    // Referral count from Metabox (includes site referrals, not just bot)
    let referralCount = 0;
    try {
      const { getPartnerBalance } = await import("../services/metabox-bridge.service.js");
      const partnerData = await getPartnerBalance(userId);
      referralCount = partnerData?.referralCount ?? 0;
    } catch {
      // Fallback to local count
      referralCount = await db.user.count({ where: { referredById: userId } });
    }

    if (!user) throw new Error("User not found");

    // Subscription info from LocalSubscription (single source of truth)
    let subscription: {
      planName: string;
      period: string;
      daysLeft: number;
      totalDays: number;
      endDate: string;
    } | null = null;

    const localSub = await db.localSubscription.findUnique({ where: { userId } });
    if (localSub && localSub.isActive && localSub.endDate > new Date()) {
      const daysLeft = Math.max(0, Math.ceil((localSub.endDate.getTime() - Date.now()) / 86400000));
      const totalDays = Math.max(
        1,
        Math.ceil((localSub.endDate.getTime() - localSub.startDate.getTime()) / 86400000),
      );
      subscription = {
        planName: localSub.planName,
        period: localSub.period,
        daysLeft,
        totalDays,
        endDate: localSub.endDate.toISOString(),
      };
    }

    return {
      id: user.id.toString(),
      username: user.username ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      language: user.language,
      role: user.role,
      metaboxUserId: user.metaboxUserId ?? null,
      metaboxReferralCode: user.metaboxReferralCode ?? null,
      finishedOnboarding: user.finishedOnboarding,
      confirmBeforeGenerate: user.confirmBeforeGenerate,
      tokenBalance: (Number(user.tokenBalance) + Number(user.subscriptionTokenBalance)).toString(),
      purchasedTokenBalance: Number(user.tokenBalance).toString(),
      subscriptionTokenBalance: Number(user.subscriptionTokenBalance).toString(),
      referralCount,
      createdAt: user.createdAt.toISOString(),
      subscription,
      transactions: transactions.map((t) => ({
        id: t.id,
        amount: t.amount.toString(),
        type: t.type,
        reason: t.reason,
        description: t.description ?? null,
        modelId: t.modelId ?? null,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  });

  /** PATCH /profile/preferences — update per-user UX flags (low-iq mode toggle, …) */
  fastify.patch<{ Body: { confirmBeforeGenerate?: boolean } }>(
    "/profile/preferences",
    async (request, reply) => {
      const { userId } = request as AuthRequest;
      const body = request.body ?? {};
      const data: { confirmBeforeGenerate?: boolean } = {};
      if (typeof body.confirmBeforeGenerate === "boolean") {
        data.confirmBeforeGenerate = body.confirmBeforeGenerate;
      }
      if (Object.keys(data).length === 0) {
        return reply.code(400).send({ error: "No supported fields in body" });
      }
      const user = await db.user.update({
        where: { id: userId },
        data,
        select: { confirmBeforeGenerate: true },
      });
      return { ok: true, confirmBeforeGenerate: user.confirmBeforeGenerate };
    },
  );

  /** GET /profile/partner-balance — Metabox partner balance for "Партнёрка" tab */
  fastify.get("/profile/partner-balance", async (request) => {
    const { userId } = request as AuthRequest;
    try {
      const { url, key } = (() => {
        const u = config.metabox.apiUrl;
        const k = config.metabox.internalKey;
        if (!u || !k) throw new Error("METABOX not configured");
        return { url: u, key: k };
      })();
      const res = await fetch(
        `${url}/api/internal/partner-balance?telegramId=${userId.toString()}`,
        { headers: { "X-Internal-Key": key } },
      );
      if (!res.ok)
        return {
          balance: 0,
          totalEarned: 0,
          totalWithdrawn: 0,
          userStatus: "REGISTERED",
          referralCode: null,
        };
      return res.json();
    } catch {
      return {
        balance: 0,
        totalEarned: 0,
        totalWithdrawn: 0,
        userStatus: "REGISTERED",
        referralCode: null,
      };
    }
  });

  /**
   * GET /profile/metabox-sso — get SSO redirect URL for linked Metabox account.
   *
   * Если аккаунт привязан, но email НЕ подтверждён — возвращаем
   * { requiresVerification: true, email } вместо ssoUrl. UI покажет
   * pending-экран с кнопками «Отправить повторно» / «Изменить почту»
   * вместо попытки авто-логина [который всё равно отвалится из-за
   * проверки emailVerified в SSO-провайдере metabox].
   */
  fastify.get("/profile/metabox-sso", async (request, reply) => {
    const { userId } = request as AuthRequest;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { metaboxUserId: true },
    });
    if (!user?.metaboxUserId) {
      return reply.code(409).send({ error: "Metabox account not linked" });
    }

    const { getMetaboxUserStatus } = await import("../services/metabox-bridge.service.js");
    try {
      const status = await getMetaboxUserStatus(user.metaboxUserId);
      if (!status.emailVerified) {
        return {
          requiresVerification: true,
          email: status.email,
        };
      }
    } catch (err) {
      // Если статус вытащить не удалось — продолжим как раньше [SSO
      // провайдер metabox сам отрежет невалидированных].
      console.error("[metabox-sso] failed to check user status:", err);
    }

    const metaboxUrl = config.metabox.apiUrl ?? "https://app.meta-box.ru";
    let ssoToken: string;
    if (config.metabox.ssoSecret) {
      ssoToken = issueSsoToken(user.metaboxUserId);
    } else {
      const result = await issueSsoTokenRemote(user.metaboxUserId);
      ssoToken = result.ssoToken;
    }
    return { ssoUrl: `${metaboxUrl}/auth/sso?token=${ssoToken}` };
  });

  /**
   * GET /profile/metabox-status — статус metabox-аккаунта юзера.
   * Используется UI чтобы понять — показывать pending-экран или открывать
   * полный профиль.
   */
  fastify.get("/profile/metabox-status", async (request, reply) => {
    const { userId } = request as AuthRequest;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { metaboxUserId: true },
    });
    if (!user?.metaboxUserId) {
      return { linked: false };
    }
    const { getMetaboxUserStatus } = await import("../services/metabox-bridge.service.js");
    try {
      const status = await getMetaboxUserStatus(user.metaboxUserId);
      return {
        linked: true,
        emailVerified: status.emailVerified,
        email: status.email,
      };
    } catch (err) {
      console.error("[metabox-status] failed:", err);
      return reply.code(502).send({ error: "Failed to fetch status" });
    }
  });

  /**
   * POST /profile/metabox-resend-verification — заново отправить
   * verification-email на текущий адрес.
   *
   * Rate limit: максимум RESEND_MAX_ATTEMPTS отправок в час, между
   * отправками минимум RESEND_COOLDOWN_SEC секунд. Защита от спама
   * на стороне бота — иначе юзер мог бы задрачить кнопку и завалить
   * SMTP-провайдера / попасть в спам-листы.
   */
  fastify.post("/profile/metabox-resend-verification", async (request, reply) => {
    const { userId } = request as AuthRequest;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { metaboxUserId: true },
    });
    if (!user?.metaboxUserId) {
      return reply.code(409).send({ error: "Metabox account not linked" });
    }

    const check = checkResendLimit(userId);
    if (!check.allowed) {
      return reply.code(429).send({
        code: "RATE_LIMITED",
        error: check.reason,
        retryAfterSec: check.retryAfterSec,
        attemptsLeft: check.attemptsLeft,
      });
    }

    const { resendMetaboxVerification } = await import("../services/metabox-bridge.service.js");
    try {
      const result = await resendMetaboxVerification(user.metaboxUserId);
      // Если main-app сказал что email уже подтверждён — лимит не списываем.
      if (!result.alreadyVerified) {
        recordResendAttempt(userId);
      }
      return {
        ...result,
        attemptsLeft: result.alreadyVerified
          ? RESEND_MAX_ATTEMPTS
          : Math.max(0, RESEND_MAX_ATTEMPTS - getResendAttempts(userId)),
        cooldownSec: RESEND_COOLDOWN_SEC,
      };
    } catch (err) {
      if (err instanceof MetaboxApiError) {
        return reply.code(err.status).send({ error: err.body, code: err.code });
      }
      throw err;
    }
  });

  /**
   * POST /profile/metabox-change-email — поменять email на pending-аккаунте
   * [когда юзер ошибся при регистрации] и переотправить верификацию.
   * Body: { newEmail: string }
   */
  fastify.post("/profile/metabox-change-email", async (request, reply) => {
    const { userId } = request as AuthRequest;
    const { newEmail } = request.body as { newEmail?: string };
    if (!newEmail) {
      return reply.code(400).send({ error: "newEmail is required" });
    }
    const emailCheck = await validateEmail(newEmail);
    if (!emailCheck.ok) {
      return reply.code(400).send({
        code: emailCheck.reason === "syntax" ? "INVALID_EMAIL" : "EMAIL_DOMAIN_INVALID",
        error:
          emailCheck.reason === "syntax"
            ? "Некорректный формат email"
            : "Указан несуществующий email-домен",
      });
    }
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { metaboxUserId: true },
    });
    if (!user?.metaboxUserId) {
      return reply.code(409).send({ error: "Metabox account not linked" });
    }
    const { changeMetaboxEmailPending } = await import("../services/metabox-bridge.service.js");
    try {
      const result = await changeMetaboxEmailPending(user.metaboxUserId, newEmail);
      // Сбрасываем resend-лимит — у юзера новый адрес, начинаем счётчик
      // заново [иначе он бы сразу упёрся в потолок старых попыток].
      resetResendLimit(userId);
      return result;
    } catch (err) {
      if (err instanceof MetaboxApiError) {
        return reply.code(err.status).send({ error: err.body, code: err.code });
      }
      throw err;
    }
  });

  /**
   * POST /profile/metabox-register — register a new Metabox account from the bot mini-app.
   * Body: { email, password, firstName? }
   */
  fastify.post("/profile/metabox-register", async (request, reply) => {
    const { userId } = request as AuthRequest;
    const { email, password, firstName, lastName, username } = request.body as {
      email: string;
      password: string;
      firstName?: string;
      lastName?: string;
      username?: string;
    };
    if (!email || !password) {
      return reply.code(400).send({ error: "email and password are required" });
    }
    const emailCheck = await validateEmail(email);
    if (!emailCheck.ok) {
      return reply.code(400).send({
        code: emailCheck.reason === "syntax" ? "INVALID_EMAIL" : "EMAIL_DOMAIN_INVALID",
        error:
          emailCheck.reason === "syntax" ? "Invalid email format" : "Email domain does not exist",
      });
    }
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { metaboxUserId: true, referredById: true },
    });
    if (user?.metaboxUserId) {
      return reply.code(409).send({ error: "Metabox account already linked" });
    }
    const { registerFromBot } = await import("../services/metabox-bridge.service.js");
    try {
      const result = await registerFromBot({
        email,
        password,
        telegramId: userId,
        firstName,
        lastName,
        username,
        referrerTelegramId: user?.referredById ?? undefined,
      });
      await db.user.update({
        where: { id: userId },
        data: { metaboxUserId: result.metaboxUserId, metaboxReferralCode: result.referralCode },
      });

      // Если на сайте email НЕ подтверждён — не выдаём ssoUrl. Юзер
      // должен сначала кликнуть по верификационной ссылке в письме и
      // затем войти на сайте вручную. Иначе любой, кто получил bot-
      // session, сразу логинился бы в metabox без верификации почты.
      if (result.requiresVerification) {
        return {
          requiresVerification: true,
          email: result.email ?? email,
        };
      }

      const metaboxUrl = config.metabox.apiUrl ?? "https://app.meta-box.ru";
      return { ssoUrl: `${metaboxUrl}/auth/sso?token=${result.ssoToken}` };
    } catch (err) {
      if (err instanceof MetaboxApiError) {
        return reply.code(err.status).send({ error: err.body, code: err.code });
      }
      throw err;
    }
  });

  /**
   * POST /profile/metabox-login — link existing Metabox account to the bot.
   * Body: { email, password }
   */
  fastify.post("/profile/metabox-login", async (request, reply) => {
    const { userId, user } = request as AuthRequest;
    const { email, password } = request.body as { email: string; password: string };
    if (!email || !password) {
      return reply.code(400).send({ error: "email and password are required" });
    }
    const { loginAndLink } = await import("../services/metabox-bridge.service.js");
    try {
      const botPurchase = await db.tokenTransaction.findFirst({
        where: { userId, type: "credit", reason: "purchase" },
        select: { id: true },
      });
      const result = await loginAndLink({
        email,
        password,
        telegramId: userId,
        telegramUsername: user.username,
        firstName: user.firstName ?? undefined,
        lastName: user.lastName ?? undefined,
        referrerTelegramId: user.referredById,
        botHasPurchase: !!botPurchase,
        botCreatedAt: user.createdAt,
      });
      await db.user.update({
        where: { id: userId },
        data: { metaboxUserId: result.metaboxUserId, metaboxReferralCode: result.referralCode },
      });
      const metaboxUrl = config.metabox.apiUrl ?? "https://app.meta-box.ru";
      return {
        ssoUrl: `${metaboxUrl}/auth/sso?token=${result.ssoToken}`,
        mergedFrom: result.mergedFrom ?? null,
      };
    } catch (err) {
      if (err instanceof MetaboxApiError) {
        // Parse JSON body for rich error info (e.g. TELEGRAM_LINKED with linkedTo)
        const responseData = err.data ?? {};
        return reply
          .code(err.status)
          .send({ ...responseData, code: err.code ?? responseData.code });
      }
      throw err;
    }
  });
};
