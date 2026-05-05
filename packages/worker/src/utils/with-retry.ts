import { logger } from "../logger.js";

/**
 * Универсальный retry-helper для сетевых операций (download/send) на финале
 * job'а. Покрывает разовые network blip'ы, провайдер-CDN'ы с прерывистой
 * доступностью и т.п. Между попытками — экспоненциальный backoff
 * (500ms → 1000ms → 2000ms ...).
 *
 * Не используем где есть BullMQ-ретраи на submit/poll: там вся стадия
 * ретраится отдельной попыткой, дополнительный inner-retry удваивал бы delay.
 * А вот на стадии финализации (download → send) BullMQ-ретрай дорог: вторая
 * попытка job'а пройдёт через recovery-путь по `existingOutput`, повторно
 * скачает по тем же URL'ам (если они уже 404'ят — деньги юзера ушли в
 * никуда). Inner-retry даёт быстрый второй шанс на тот же chunk'инговый
 * blip без сжигания BullMQ-attempt'а.
 */
export async function withRetry<T>(op: string, attempts: number, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      const delayMs = 500 * 2 ** i;
      logger.warn(
        { err, op, attempt: i + 1, of: attempts, nextDelayMs: delayMs },
        "withRetry: operation failed, retrying",
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
