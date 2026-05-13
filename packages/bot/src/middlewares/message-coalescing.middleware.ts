import type { MiddlewareFn } from "grammy";
import type { BotContext } from "../types/context.js";
import { logger } from "../logger.js";

/**
 * Telegram-клиенты при вводе/вставке текста длиннее 4096 символов автоматически
 * режут его на куски и шлют несколькими подряд сообщениями. Бот видит каждое
 * как отдельный prompt — теряет смысл длинного запроса (а в режиме confirm
 * pending-generation row перезаписывается последним чанком и юзер видит только
 * хвост). Этот middleware склеивает такие куски обратно в один
 * ctx.message.text/caption ДО входа в любую сцену.
 *
 * Триггер: первое сообщение длиной ≥ COALESCE_TRIGGER_LENGTH (3000). Telegram
 * TDLib режет по последнему \n, потом по последнему пробелу перед лимитом
 * 4096; для текста с абзацами первый чанк реально бывает 3000–4095. Точно
 * на 4096 завязываться нельзя — пропустим paragraph-break сплиты.
 *
 * Окно: 10с с запасом на сетевые задержки доставки следующего чанка.
 * Прошлые 3.5с регулярно срабатывали раньше прихода chunk2 → chunk1 уходил
 * соло, chunk2 заходил как самостоятельный prompt (двойное списание,
 * перезапись confirm-card'а). Таймер ресетится на каждом куске, так что
 * цепочка из N чанков работает пока разрыв между соседними < 10с.
 *
 * Continuation < CONTINUATION_BOUNDARY_LENGTH (4000) = это последний кусок.
 * Завязываться на 4096 нельзя: Telegram TDLib (Desktop, часть мобильных
 * клиентов) режет по последнему \n / пробелу перед 4096, и middle-chunk
 * легко получается 4000–4095 символов. Если бы флашили на `< 4096`, такой
 * middle-chunk ошибочно считался бы последним → последующие реальные
 * chunk'и заходили бы как fresh prompt (тот же баг, который чиним).
 * Граница 4000 покрывает разумный window поиска word-boundary (96 символов
 * от лимита); более длинные слова/URL у границы → Telegram режет hard на
 * 4096, middle-chunk = 4096, ≥ 4000 → ждём дальше корректно.
 * Continuation ≥ 4000 → middle-chunk, ресетим timer и ждём ещё.
 *
 * Typing indicator: на создание slot'а отправляем chat action fire-and-forget,
 * чтобы юзер видел что бот работает, а не завис. Без этого 10с тишины на
 * легитимном одиночном сообщении 3000–4095 символов выглядят как баг.
 *
 * Memory cap: MAX_BUFFER_SLOTS защищает от пика 100k+ юзеров одновременно
 * (каждый slot держит full ctx ≈ несколько KB на 10с). Превышение — fail-open
 * (пропускаем без буферизации), чтобы не дропать прод-трафик при аномалии.
 *
 * Фильтр: только text и caption (photo/video/document с подписью). Voice /
 * audio / sticker не имеют длинного текста, фильтр их не цепляет естественно.
 *
 * ВАЖНО: middleware регистрируется ДО `sequentialize` в bot.ts. После
 * sequentialize апдейты по чату обрабатываются последовательно — второй кусок
 * висел бы в очереди до завершения первого, склейка никогда не происходила.
 * До sequentialize апдейты parallel — coalesce успевает поймать оба и
 * заресолвить первый при приходе второго. Поэтому используется `ctx.from.id`
 * (auth ещё не сработал, ctx.user недоступен).
 */

const COALESCE_TRIGGER_LENGTH = 3000;
const CONTINUATION_BOUNDARY_LENGTH = 4000;
const COALESCE_WINDOW_MS = 10_000;
const MAX_BUFFER_SLOTS = 1000;

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

function flush(userId: bigint, reason: "continuation" | "timeout"): void {
  const slot = buffer.get(userId);
  if (!slot) return;
  buffer.delete(userId);
  clearTimeout(slot.timer);

  // try/finally вокруг resolve: если Object.assign или logger бросит (frozen
  // ctx в будущем, broken log transport — теоретические, но недопустимо
  // оставить незакрытым), chunk1's `await new Promise` повиснет навсегда,
  // запинит runner sink и течёт BotContext. resolve в finally гарантирует
  // что промис всегда разрешится; ошибка пробросится дальше (uncaughtException
  // если из setTimeout, или вверх по middleware chain — что корректно).
  try {
    const merged = slot.parts.join("");
    if (slot.ctx.message) {
      Object.assign(slot.ctx.message, { [slot.field]: merged });
      const payload = {
        userId: String(userId),
        parts: slot.parts.length,
        totalLength: merged.length,
        reason,
      };
      // Timeout с одним куском = либо честное короткое-ish сообщение, либо
      // chunk2 не доехал за окно (сигнал тюнить COALESCE_WINDOW_MS). Логируем
      // warn'ом, чтобы видеть частоту в проде.
      if (reason === "timeout" && slot.parts.length === 1) {
        logger.warn(payload, "message-coalescing: solo timeout flush");
      } else {
        logger.info(payload, "message-coalescing: flushed merged prompt");
      }
    }
  } finally {
    slot.resolve();
  }
}

export const messageCoalescingMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (!ctx.from?.id) return next();
  const got = getMessageText(ctx);
  if (!got) return next();
  const text = got.value;
  // Только настоящие команды (/word, /word@bot, /word arg…) — не любой текст
  // начинающийся со `/`. Иначе вставка JS-кода с `//` или forward сообщения
  // длиной 8000+ символов начинающегося со `/` обошли бы coalescing и
  // зарепродьюсили бы оригинальный split-баг. Telegram-формат команды:
  // ^/[A-Za-z0-9_]{1,32}(@<bot>)? + конец или пробел.
  if (/^\/[A-Za-z0-9_]{1,32}(@[A-Za-z0-9_]+)?(\s|$)/.test(text)) return next();

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
    if (text.length < CONTINUATION_BOUNDARY_LENGTH) {
      flush(userId, "continuation");
    } else {
      existing.timer = setTimeout(() => flush(userId, "timeout"), COALESCE_WINDOW_MS);
    }
    return;
  }

  if (text.length < COALESCE_TRIGGER_LENGTH) {
    return next();
  }

  // Fail-open на аномальном пике: не блокируем трафик, пускаем как обычное
  // сообщение. Split всё равно сломается, но это лучше чем OOM.
  if (buffer.size >= MAX_BUFFER_SLOTS) {
    logger.warn(
      { userId: String(userId), bufferSize: buffer.size },
      "message-coalescing: buffer cap reached, bypassing",
    );
    return next();
  }

  // Fire-and-forget typing indicator — юзер видит что бот думает, а не висит.
  // Catch — chat action не критичен, не валим основной flow если Telegram
  // ответит ошибкой (например permission denied в группе). Используем `typing`
  // даже для caption: фото уже принято, бот будет обрабатывать prompt, а не
  // что-то загружать; `upload_photo` action ввёл бы юзера в заблуждение.
  ctx.replyWithChatAction("typing").catch(() => {});

  await new Promise<void>((resolve) => {
    const slot: CoalesceSlot = {
      ctx,
      field: got.field,
      parts: [text],
      timer: setTimeout(() => flush(userId, "timeout"), COALESCE_WINDOW_MS),
      resolve,
    };
    buffer.set(userId, slot);
  });

  return next();
};
