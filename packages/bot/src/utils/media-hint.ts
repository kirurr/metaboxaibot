import type { BotContext } from "../types/context.js";
import { mediaHintService, userStateService } from "@metabox/api/services";
import { getActiveModelSlots } from "./media-input-state.js";

type Section = "design" | "video";

/** Удалить ранее отправленный hint (если есть) и забыть его id. */
export async function consumeMediaHint(ctx: BotContext, section: Section): Promise<void> {
  if (!ctx.user) return;
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const messageId = await mediaHintService.get(ctx.user.id, section);
  if (!messageId) return;
  await ctx.api.deleteMessage(chatId, messageId).catch(() => void 0);
  await mediaHintService.clear(ctx.user.id, section);
}

/**
 * Идемпотентно синхронизирует hint-сообщение с текущим состоянием слотов:
 * сначала удаляет ранее отправленный hint (если был), затем — если у активной
 * модели есть видимые в текущем режиме слоты и ни один не заполнен — отправляет
 * новый hint и сохраняет его id. Иначе hint остаётся отсутствующим.
 *
 * Вызывать после: активации модели, удаления слота, апдейта media-input статуса.
 */
export async function refreshMediaHint(
  ctx: BotContext,
  section: Section,
  modelId: string,
): Promise<void> {
  if (!ctx.user) return;

  await consumeMediaHint(ctx, section);

  const activeSlots = await getActiveModelSlots(ctx.user.id, modelId);
  if (!activeSlots.length) return;

  const filled = await userStateService.getMediaInputs(ctx.user.id, modelId);
  const anyFilled = activeSlots.some((s) => filled[s.slotKey]?.length);
  if (anyFilled) return;

  const sent = await ctx.reply(ctx.t.mediaInput.referencesNotLoaded).catch(() => null);
  if (sent) {
    await mediaHintService.set(ctx.user.id, section, sent.message_id);
  }
}
