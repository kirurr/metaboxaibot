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
 *
 * ВАЖНО: middleware регистрируется ДО `sequentialize` в bot.ts. После
 * sequentialize апдейты по чату обрабатываются последовательно — второй кусок
 * висел бы в очереди до завершения первого, склейка никогда не происходила.
 * До sequentialize апдейты parallel — coalesce успевает поймать оба и
 * заресолвить первый при приходе второго. Поэтому используется `ctx.from.id`
 * (auth ещё не сработал, ctx.user недоступен).
 */

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const COALESCE_WINDOW_MS = 2500;

interface CoalesceSlot {
  ctx: BotContext;
  field: "text" | "caption";
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
  if (slot.ctx.message) {
    Object.assign(slot.ctx.message, { [slot.field]: merged });
    logger.info(
      { userId: String(userId), parts: slot.parts.length, totalLength: merged.length },
      "message-coalescing: flushed merged prompt",
    );
  }
  slot.resolve();
}

export const messageCoalescingMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (!ctx.from?.id) return next();
  const got = getMessageText(ctx);
  if (!got) return next();
  const text = got.value;
  if (text.startsWith("/")) return next();

  const userId = BigInt(ctx.from.id);
  const existing = buffer.get(userId);

  if (existing) {
    // Склеиваем только однородные сообщения (text↔text, caption↔caption).
    // Иначе follow-up media (photo с caption после длинного text'а) был бы
    // проглочен — мы вернули бы void без next() и теряли бы исходное фото.
    if (got.field !== existing.field) {
      return next();
    }
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
      field: got.field,
      parts: [text],
      timer: setTimeout(() => flush(userId), COALESCE_WINDOW_MS),
      resolve,
    };
    buffer.set(userId, slot);
  });

  return next();
};
