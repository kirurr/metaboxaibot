import type { BotContext } from "../types/context.js";
import { db } from "@metabox/api/db";
import { confirmMerge } from "@metabox/api/services";
import { config } from "@metabox/shared";
import { finalizeStart } from "../commands/start.js";

/**
 * User chose a mentor (Step 1 → Step 2: confirmation).
 * callback_data: "merge:site:{token}" or "merge:bot:{token}"
 */
export async function handleMergeChoice(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const [, choice, token] = data.split(":");
  if (!choice || !token) return;

  const mentorLabel = choice === "site" ? "наставника с сайта" : "наставника из бота";

  await ctx.editMessageText(
    `Вы уверены, что хотите объединить аккаунты и оставить *${mentorLabel}*?\n\nЭто действие необратимо.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Да, объединить",
              callback_data: `merge_confirm:${choice}:${token}`,
            },
          ],
          [{ text: "❌ Отмена", callback_data: "merge:cancel" }],
        ],
      },
    },
  );
}

/**
 * User cancelled merge.
 * callback_data: "merge:cancel"
 *
 * MENTOR_CONFLICT прервал /start ДО finalizeStart — юзер мог остаться без
 * welcome-бонуса, языка, FSM=IDLE и главного меню. После cancel'а гоняем
 * finalizeStart, чтобы он мог использовать бота без повторного /start.
 * Подавляем «Мы нашли ваш аккаунт на Metabox» — связи с Metabox не было.
 */
export async function handleMergeCancel(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Объединение отменено. Ваши аккаунты остались раздельными.");
  await finalizeStart(ctx, { suppressMetaboxLinkedNotification: true });
}

/**
 * User confirmed merge (Step 2 → execute).
 * callback_data: "merge_confirm:site:{token}" or "merge_confirm:bot:{token}"
 */
export async function handleMergeConfirm(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.user || !ctx.user.telegramId) return;

  const [, choice, token] = data.split(":");
  if (!choice || !token) return;

  try {
    const result = await confirmMerge({
      token,
      telegramId: ctx.user.telegramId,
      chosenMentor: choice as "site" | "bot",
    });

    await db.user.update({
      where: { id: ctx.user.id },
      data: {
        metaboxUserId: result.metaboxUserId,
        metaboxReferralCode: result.referralCode,
      },
    });

    await ctx.editMessageText(
      "✅ Аккаунты успешно объединены!\n\nВаши данные перенесены на основной аккаунт.",
    );
  } catch (err) {
    console.error("[merge-confirm] error:", err);
    await ctx.editMessageText(
      `❌ Не удалось объединить аккаунты. Попробуйте ещё раз или обратитесь в поддержку: @${config.supportTg}`,
    );
  }

  // MENTOR_CONFLICT прервал /start ДО finalizeStart — даже после успешного
  // merge юзер остался бы без welcome-бонуса и главного меню. Гоняем хвост
  // здесь. Подавляем «Мы нашли ваш аккаунт на Metabox» — пользователь уже
  // увидел «✅ Аккаунты успешно объединены», дубликат не нужен. При ошибке
  // confirmMerge всё равно вызываем — юзер хотя бы получит бонус и меню.
  await finalizeStart(ctx, { suppressMetaboxLinkedNotification: true });
}
