import type { MiddlewareFn } from "grammy";
import type { BotContext } from "../types/context.js";
import { logger } from "../logger.js";

/**
 * Telegram iOS-клиент при вводе/вставке текста длиннее 4096 символов автоматически
 * режет его на куски ровно по 4096 чарам и шлёт несколькими подряд сообщениями.
 * Бот видит каждое как отдельный prompt — теряет смысл длинного запроса. Этот
 * middleware склеивает такие куски обратно в один ctx.message.text/caption.
 *
 * Триггер: первое сообщение длиной ровно 4096 символов от юзера → создаём slot,
 * держим middleware-pipeline открытым до 2.5с. Любые text/caption от того же
 * юзера в окне аппендим в slot. Как только пришёл кусок < 4096 (последний) или
 * истёк timer — флашим: мутируем text/caption первого ctx и отпускаем next().
 *
 * Фильтр: только text и caption (photo/video/document с подписью). Voice / audio /
 * sticker не имеют 4096-чарового текста, фильтр их не цепляет естественно.
 */

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const COALESCE_WINDOW_MS = 2500;

interface CoalesceSlot {
  ctx: BotContext;
  parts: string[];
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
}

const buffer = new Map<bigint, CoalesceSlot>();

function getMessageText(ctx: BotContext): { value: string; field: "text" | "caption" } | null {
  const msg = ctx.message;
  if (!msg) return null;
  if (typeof msg.text === "string") return { value: msg.text, field: "text" };
  if (typeof msg.caption === "string") return { value: msg.caption, field: "caption" };
  return null;
}

function flush(userId: bigint): void {
  const slot = buffer.get(userId);
  if (!slot) return;
  buffer.delete(userId);
  clearTimeout(slot.timer);

  const merged = slot.parts.join("");
  const got = getMessageText(slot.ctx);
  if (got && slot.ctx.message) {
    Object.assign(slot.ctx.message, { [got.field]: merged });
    logger.info(
      { userId: String(userId), parts: slot.parts.length, totalLength: merged.length },
      "message-coalescing: flushed merged prompt",
    );
  }
  slot.resolve();
}

export const messageCoalescingMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (!ctx.user) return next();
  const got = getMessageText(ctx);
  if (!got) return next();
  const text = got.value;
  if (text.startsWith("/")) return next();

  const userId = ctx.user.id;
  const existing = buffer.get(userId);

  if (existing) {
    existing.parts.push(text);
    clearTimeout(existing.timer);
    if (text.length < TELEGRAM_MAX_MESSAGE_LENGTH) {
      flush(userId);
    } else {
      existing.timer = setTimeout(() => flush(userId), COALESCE_WINDOW_MS);
    }
    return;
  }

  if (text.length < TELEGRAM_MAX_MESSAGE_LENGTH) {
    return next();
  }

  await new Promise<void>((resolve) => {
    const slot: CoalesceSlot = {
      ctx,
      parts: [text],
      timer: setTimeout(() => flush(userId), COALESCE_WINDOW_MS),
      resolve,
    };
    buffer.set(userId, slot);
  });

  return next();
};
