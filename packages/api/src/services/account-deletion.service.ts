/**
 * Account deletion flow.
 *
 * Запускается из mini-app: пользователь жмёт "Удалить аккаунт" → POST на api,
 * api генерит 6-значный код, кладёт в Redis (TTL 5 мин), ставит state
 * `AWAITING_DELETE_CONFIRMATION` и шлёт сообщение в чат бота.
 *
 * Юзер вводит код → бот вызывает `verifyCode` → при успехе шлёт финальное
 * сообщение с inline-кнопками "Удалить"/"Отменить". Тап "Удалить" →
 * `executeAccountDeletion` (атомарный flow: перенос на metabox → snapshot в
 * `DeletedUser` → cascade-удаление из `users`).
 *
 * Бизнес-правила:
 *  - 3 неверных кода → flow отменяется автоматом.
 *  - Если у юзера привязан metabox-аккаунт И есть что переносить:
 *    `transferOnDeletion` зовётся. На fail (404 от пока не реализованного
 *    эндпоинта, network, 5xx) — НЕ роллбэкаем. Юзер удаляется, в
 *    DeletedUser.pendingMetaboxTransfer=true для последующего reconcile.
 *  - prevState юзера сохраняется в Redis, на cancel — восстанавливается.
 */
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../db.js";
import { getRedis } from "../redis.js";
import { config, getT } from "@metabox/shared";
import type { Language, Section, BotState } from "@metabox/shared";
import { logger } from "../logger.js";
import { userStateService } from "./user-state.service.js";
import { transferOnDeletion as metaboxTransfer } from "./metabox-bridge.service.js";

const CODE_KEY_PREFIX = "account_delete:code:";
const PREV_STATE_KEY_PREFIX = "account_delete:prev_state:";
const TTL_SEC = 5 * 60;
const MAX_ATTEMPTS = 3;

interface CodeRecord {
  code: string;
  attempts: number;
  /** true после успешного `verifyCode`. Гейтит `executeAccountDeletion`. */
  verified: boolean;
}

function codeKey(userId: bigint): string {
  return `${CODE_KEY_PREFIX}${userId.toString()}`;
}

function prevStateKey(userId: bigint): string {
  return `${PREV_STATE_KEY_PREFIX}${userId.toString()}`;
}

function generateCode(): string {
  return randomInt(100000, 1000000).toString();
}

async function getUserLang(userId: bigint): Promise<Language> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { language: true } });
  return ((u?.language as Language | undefined) ?? "en") as Language;
}

async function sendBotMessage(chatId: bigint, text: string, replyMarkup?: object): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${config.bot.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: Number(chatId),
        text,
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
  } catch (err) {
    logger.error({ err, chatId: chatId.toString() }, "[account-deletion] sendBotMessage failed");
  }
}

/**
 * Шаг 1: пользователь нажал "Подтвердить" в mini-app.
 * - Генерим код, сохраняем prev-state, ставим AWAITING_DELETE_CONFIRMATION,
 *   отправляем сообщение с кодом в чат.
 * - Идемпотентно: повторный вызов перезатирает старый код (пользователь
 *   мог "забыть" предыдущий, нажал ещё раз).
 */
export async function initiateAccountDeletion(userId: bigint): Promise<void> {
  const redis = getRedis();
  const lang = await getUserLang(userId);
  const t = getT(lang);

  // Сохраняем prevState ТОЛЬКО если в Redis ещё нет (защита от перезаписи
  // на повторном initiate — иначе вторая инициация затрёт сохранённый IDLE
  // /DESIGN_ACTIVE на AWAITING_DELETE_CONFIRMATION).
  const existingPrev = await redis.get(prevStateKey(userId));
  if (!existingPrev) {
    const current = await userStateService.get(userId);
    const snapshot = current
      ? { state: current.state as BotState, section: (current.section ?? null) as Section | null }
      : { state: "IDLE" as BotState, section: null };
    await redis.set(prevStateKey(userId), JSON.stringify(snapshot), "EX", TTL_SEC);
  } else {
    // Освежаем TTL чтобы не протух пока юзер вводит код
    await redis.expire(prevStateKey(userId), TTL_SEC);
  }

  await userStateService.setState(userId, "AWAITING_DELETE_CONFIRMATION");

  const code = generateCode();
  const record: CodeRecord = { code, attempts: 0, verified: false };
  await redis.set(codeKey(userId), JSON.stringify(record), "EX", TTL_SEC);

  await sendBotMessage(userId, t.accountDelete.codeMessage.replace("{code}", code), {
    inline_keyboard: [
      [{ text: t.accountDelete.cancelButton, callback_data: "account_delete:cancel" }],
    ],
  });

  logger.info({ userId: userId.toString() }, "[account-deletion] initiated");
}

export type VerifyResult = "ok" | "wrong" | "expired" | "too_many_attempts";

/**
 * Шаг 2: юзер прислал код в чат.
 * - При совпадении — ставим verified=true, возвращаем "ok". TTL не сбрасываем.
 * - На N-й неверный → cancel, "too_many_attempts".
 */
export async function verifyDeletionCode(
  userId: bigint,
  inputCode: string,
): Promise<{ result: VerifyResult; attemptsLeft?: number }> {
  const redis = getRedis();
  const raw = await redis.get(codeKey(userId));
  if (!raw) return { result: "expired" };

  let record: CodeRecord;
  try {
    record = JSON.parse(raw) as CodeRecord;
  } catch {
    return { result: "expired" };
  }

  if (record.code === inputCode.trim()) {
    record.verified = true;
    // Сохраняем оставшийся TTL — расчёт через PTTL/SET с KEEPTTL.
    await redis.set(codeKey(userId), JSON.stringify(record), "KEEPTTL");
    return { result: "ok" };
  }

  record.attempts += 1;
  if (record.attempts >= MAX_ATTEMPTS) {
    await cancelAccountDeletion(userId, "too_many_attempts");
    return { result: "too_many_attempts" };
  }
  await redis.set(codeKey(userId), JSON.stringify(record), "KEEPTTL");
  return { result: "wrong", attemptsLeft: MAX_ATTEMPTS - record.attempts };
}

/**
 * Шаг 3 (final confirm): юзер тапнул "Удалить" на финальном сообщении.
 * - Гейт: verified=true в Redis (иначе нужно сначала ввести код).
 * - Перенос на metabox (best-effort), snapshot в DeletedUser, cascade-delete,
 *   cleanup Redis, финальное сообщение в чат.
 */
export async function executeAccountDeletion(userId: bigint): Promise<{ ok: true }> {
  const redis = getRedis();
  const raw = await redis.get(codeKey(userId));
  if (!raw) throw new Error("delete flow expired");
  let record: CodeRecord;
  try {
    record = JSON.parse(raw) as CodeRecord;
  } catch {
    throw new Error("delete flow corrupted");
  }
  if (!record.verified) throw new Error("code not verified");

  const user = await db.user.findUnique({
    where: { id: userId },
    include: { localSubscription: true },
  });
  if (!user) {
    // Гонка: уже удалён? Чистим Redis и тихо выходим.
    await redis.del(codeKey(userId), prevStateKey(userId));
    return { ok: true };
  }

  // ── 1. Перенос остатков на metabox (best-effort) ────────────────────────
  const tokenBalance = Number(user.tokenBalance);
  const subBalance = Number(user.subscriptionTokenBalance);
  const totalTokens = tokenBalance + subBalance;
  const localSub = user.localSubscription;
  const subToTransfer =
    localSub && localSub.metaboxSubscriptionId === null
      ? {
          planName: localSub.planName,
          period: localSub.period,
          tokensGranted: localSub.tokensGranted,
          endDate: localSub.endDate.toISOString(),
          startDate: localSub.startDate.toISOString(),
        }
      : undefined;

  let pendingMetaboxTransfer = false;
  let transferError: string | null = null;
  const shouldTransfer = !!user.metaboxUserId && (totalTokens > 0 || !!subToTransfer);

  if (shouldTransfer) {
    try {
      await metaboxTransfer({
        metaboxUserId: user.metaboxUserId!,
        telegramId: user.id,
        tokens: totalTokens,
        subscription: subToTransfer,
      });
      logger.info(
        {
          userId: userId.toString(),
          metaboxUserId: user.metaboxUserId,
          tokens: totalTokens,
          hasSubscription: !!subToTransfer,
        },
        "[account-deletion] metabox transfer ok",
      );
    } catch (err) {
      pendingMetaboxTransfer = true;
      transferError = err instanceof Error ? err.message : String(err);
      logger.warn(
        { userId: userId.toString(), err },
        "[account-deletion] metabox transfer failed — will mark pending",
      );
    }
  }

  // ── 2. Snapshot + cascade-delete атомарно ───────────────────────────────
  const snapshot = {
    telegramId: user.id,
    username: user.username ?? null,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    language: user.language,
    metaboxUserId: user.metaboxUserId ?? null,
    metaboxReferralCode: user.metaboxReferralCode ?? null,
    tokenBalance: user.tokenBalance,
    subscriptionTokenBalance: user.subscriptionTokenBalance,
    hadLocalSubscription: !!localSub,
    localSubscriptionSnapshot: localSub
      ? (JSON.parse(
          JSON.stringify(localSub, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
        ) as Prisma.InputJsonValue)
      : Prisma.JsonNull,
    pendingMetaboxTransfer,
    transferError,
    originalCreatedAt: user.createdAt,
  };

  await db.$transaction([
    db.deletedUser.create({ data: snapshot }),
    db.user.delete({ where: { id: userId } }),
  ]);

  // ── 3. Cleanup Redis + финальное сообщение ──────────────────────────────
  await redis.del(codeKey(userId), prevStateKey(userId));

  const lang = (user.language as Language) ?? "en";
  const t = getT(lang);
  await sendBotMessage(userId, t.accountDelete.success);

  logger.info(
    {
      userId: userId.toString(),
      pendingMetaboxTransfer,
      hadLocalSubscription: !!localSub,
    },
    "[account-deletion] completed",
  );
  return { ok: true };
}

/**
 * Откат flow: восстановить prev-state, удалить Redis-ключи, послать уведомление.
 * Вызывается из:
 *  - callback "account_delete:cancel" (юзер передумал)
 *  - 3+ неверных кода
 *  - истекший Redis-ключ (когда хотим явно почистить)
 */
export async function cancelAccountDeletion(
  userId: bigint,
  reason: "user_cancel" | "too_many_attempts" | "expired",
): Promise<void> {
  const redis = getRedis();
  const prevRaw = await redis.get(prevStateKey(userId));
  let prev: { state: BotState; section: Section | null } | null = null;
  if (prevRaw) {
    try {
      prev = JSON.parse(prevRaw) as { state: BotState; section: Section | null };
    } catch {
      prev = null;
    }
  }

  if (prev) {
    await userStateService.setState(userId, prev.state, prev.section);
  } else {
    await userStateService.setState(userId, "IDLE");
  }

  await redis.del(codeKey(userId), prevStateKey(userId));

  const lang = await getUserLang(userId);
  const t = getT(lang);
  let text: string;
  switch (reason) {
    case "too_many_attempts":
      text = t.accountDelete.tooManyAttempts;
      break;
    case "expired":
      text = t.accountDelete.codeExpired;
      break;
    default:
      text = t.accountDelete.cancelled;
  }
  await sendBotMessage(userId, text);

  logger.info({ userId: userId.toString(), reason }, "[account-deletion] cancelled");
}

/** Проверить, есть ли активный flow в Redis (для гейта на финальном confirm). */
export async function isFlowVerified(userId: bigint): Promise<boolean> {
  const raw = await getRedis().get(codeKey(userId));
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as CodeRecord).verified === true;
  } catch {
    return false;
  }
}
