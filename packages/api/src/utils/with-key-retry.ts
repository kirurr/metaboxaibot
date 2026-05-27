import {
  acquireKey,
  markRateLimited,
  recordError,
  recordSuccess,
  type AcquiredKey,
} from "../services/key-pool.service.js";
import { classifyRateLimit } from "./rate-limit-error.js";
import { isPoolExhaustedError } from "./pool-exhausted-error.js";
import { logger } from "../logger.js";

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Запускает `fn` с ключом из пула; на rate-limit / billing-error помечает
 * ключ throttled (через `markRateLimited`) и ретраит со следующим живым.
 *
 * Зачем: в sync-путях (Whisper, prompt-translate) нет «обёртки очередью»
 * как у воркера. Без ретрая первый юзер, попавший на ключ-только-что-сдох,
 * ловит ошибку — хотя в пуле могут быть ещё живые. С ретраем — ключ
 * помечается, следующий `acquireKey` отдаёт другой, юзер видит результат.
 *
 * НЕ ретраит на non-rate-limit ошибках (network / 5xx / invalid payload):
 *   - network/5xx — это сторона провайдера, ретрай по другому ключу не
 *     поможет; падает на верхний уровень.
 *   - 4xx с битым payload'ом — упадёт у любого ключа одинаково.
 *
 * Pool-exhausted между попытками не маскирует исходную ошибку: если на
 * первой попытке ключ упал по rate-limit, а на второй пул уже пустой —
 * наверх летит **первая** ошибка (она информативнее, чем «pool exhausted»).
 */
export async function withKeyRetry<T>(
  provider: string,
  fn: (acquired: AcquiredKey) => Promise<T>,
  opts?: {
    maxAttempts?: number;
    acquire?: (provider: string) => Promise<AcquiredKey>;
  },
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const acquireFn = opts?.acquire ?? acquireKey;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let acquired: AcquiredKey;
    try {
      acquired = await acquireFn(provider);
    } catch (err) {
      if (isPoolExhaustedError(err) && lastErr !== undefined) throw lastErr;
      throw err;
    }

    try {
      const result = await fn(acquired);
      if (acquired.keyId) void recordSuccess(acquired.keyId);
      return result;
    } catch (err) {
      if (!acquired.keyId) throw err;
      const cls = classifyRateLimit(err, provider);
      if (cls.isRateLimit) {
        await markRateLimited(acquired.keyId, cls.cooldownMs, cls.reason);
        lastErr = err;
        logger.warn(
          {
            provider,
            keyId: acquired.keyId,
            attempt: attempt + 1,
            maxAttempts,
            reason: cls.reason,
          },
          "withKeyRetry: rate-limit on key — retrying with next",
        );
        continue;
      }
      void recordError(acquired.keyId, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  throw lastErr;
}
