import { InlineKeyboard } from "grammy";
import type { BotContext } from "../types/context.js";
import {
  verifyDeletionCode,
  executeAccountDeletion,
  cancelAccountDeletion,
  isFlowVerified,
} from "@metabox/api/services";
import { logger } from "../logger.js";

/**
 * Хендлеры flow удаления аккаунта на стороне бота.
 *
 * Цепочка:
 *   1. Mini-app POST /account/delete-initiate → api генерит код, ставит state
 *      AWAITING_DELETE_CONFIRMATION, шлёт юзеру сообщение с кодом + cancel-кнопка.
 *   2. Юзер шлёт код в чат → handleDeleteCodeInput → verifyDeletionCode →
 *      на success шлём финальное confirm-сообщение с inline-кнопками.
 *   3. Тап "Удалить" → handleDeleteConfirm → executeAccountDeletion (cascade).
 *      Тап "Отмена" → handleDeleteCancel → restore prev state.
 */

/**
 * Текстовое сообщение от юзера в state AWAITING_DELETE_CONFIRMATION.
 * Trim + убираем пробелы, чтобы юзер мог вставить с пробелом без проблем.
 */
export async function handleDeleteCodeInput(ctx: BotContext): Promise<void> {
  if (!ctx.user || !ctx.message?.text) return;

  const userId = ctx.user.id;
  const input = ctx.message.text.trim().replace(/\s+/g, "");
  const t = ctx.t;

  const { result, attemptsLeft } = await verifyDeletionCode(userId, input);

  if (result === "expired") {
    // Сервис уже мог удалить ключи; явно cancel'им чтобы prev-state восстановился.
    await cancelAccountDeletion(userId, "expired").catch(() => void 0);
    return;
  }
  if (result === "too_many_attempts") {
    // cancelAccountDeletion уже отослал текст пользователю.
    return;
  }
  if (result === "wrong") {
    await ctx
      .reply(t.accountDelete.codeWrong.replace("{left}", String(attemptsLeft ?? 0)))
      .catch(() => void 0);
    return;
  }

  // result === "ok" — показываем финальное confirm-сообщение
  const kb = new InlineKeyboard()
    .text(t.accountDelete.finalConfirmButton, "account_delete:confirm")
    .row()
    .text(t.accountDelete.finalCancelButton, "account_delete:cancel");
  await ctx.reply(t.accountDelete.codeAccepted, { reply_markup: kb }).catch(() => void 0);
}

/**
 * Callback "account_delete:confirm" — финальный шаг.
 * Гейт: verified=true в Redis. Если флага нет (юзер тапнул кнопку без ввода
 * кода — теоретически невозможно, но защищаемся) — ругаемся.
 */
export async function handleDeleteConfirm(ctx: BotContext): Promise<void> {
  if (!ctx.user) {
    await ctx.answerCallbackQuery().catch(() => void 0);
    return;
  }
  const userId = ctx.user.id;
  const t = ctx.t;

  const verified = await isFlowVerified(userId);
  if (!verified) {
    await ctx.answerCallbackQuery({ text: t.accountDelete.needCodeFirst }).catch(() => void 0);
    return;
  }

  await ctx.answerCallbackQuery().catch(() => void 0);
  // Убираем кнопки чтобы юзер не тапнул дважды.
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => void 0);

  try {
    await executeAccountDeletion(userId);
  } catch (err) {
    logger.error({ err, userId: userId.toString() }, "[account-delete] execute failed");
    // Если упало — flow остаётся в Redis, юзер может попробовать ещё раз.
    await ctx.reply(t.errors.unexpected).catch(() => void 0);
  }
}

/**
 * Callback "account_delete:cancel" — отмена на любом шаге.
 */
export async function handleDeleteCancel(ctx: BotContext): Promise<void> {
  if (!ctx.user) {
    await ctx.answerCallbackQuery().catch(() => void 0);
    return;
  }
  await ctx.answerCallbackQuery().catch(() => void 0);
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => void 0);
  await cancelAccountDeletion(ctx.user.id, "user_cancel").catch(() => void 0);
}
