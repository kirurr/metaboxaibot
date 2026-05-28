/**
 * Detect OpenAI account-wide billing exhaustion (как opposed to transient
 * rate-limit / 5xx). Эти ошибки означают «нужно пополнить биллинг на OpenAI
 * org/project» — ни retry, ни смена ключа в пуле не помогут (если все ключи
 * в одной org), плюс лечится только operational-действием.
 *
 * Покрытые сигналы (matches любого):
 *   - `code: "billing_hard_limit_reached"` (HTTP 400) — hard cap проекта
 *     достигнут. До отключения cap'а или пополнения OpenAI отвечает 400
 *     на каждый запрос.
 *   - `code: "insufficient_quota"` (HTTP 429) — квота исчерпана. Аналогично
 *     требует пополнения.
 *   - Fallback по message: "Billing hard limit" / "exceeded your current
 *     quota" — для случаев, когда `code` потерян по дороге (proxy / wrapper).
 *
 * Используется submit-with-throttle / submit-with-fallback / defer-rate-limit
 * для:
 *   - роута алертов в `balance` тему (а не в общие `alerts`),
 *   - дедупа через `notifyTechErrorThrottled`, чтобы при пустом биллинге не
 *     спамить 13× одинаковых сообщений на BullMQ-ретраях.
 */

/**
 * Cooldown, на который billing-исчерпанный ключ выводится из ротации
 * (per-key `markRateLimited`, НЕ provider-wide). Биллинг пополняется не
 * мгновенно, но и блокировать ключ навсегда нельзя — через 30 мин он снова
 * пробуется; если всё ещё пуст — throttle ставится заново. Это позволяет
 * `acquireKey` пропустить billing-dead ключ и взять здоровый (с деньгами),
 * вместо того чтобы каждый запрос упирался в один и тот же мёртвый ключ
 * (особенно критично для inverted-priority моделей вроде gpt-image-1.5).
 */
export const OPENAI_BILLING_KEY_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Сколько ключей ОДНОГО провайдера пробуем при billing-исчерпании в рамках
 * одного submit'а (key-level retry). billing-dead ключ выводится из ротации,
 * берётся следующий через acquireKey. Спасает запрос даже у моделей БЕЗ
 * fallback-модели (gpt-image-1.5). Если все ключи billing-dead — acquireKey
 * бросит PoolExhausted и управление уйдёт к fallback-кандидату / defer'у.
 */
export const MAX_BILLING_KEY_RETRIES = 3;

interface BillingErrorLike {
  code?: unknown;
  message?: unknown;
  error?: { code?: unknown };
}

/** OpenAI error-коды, означающие account-wide billing/доступ исчерпан. */
const BILLING_CODES = new Set([
  "billing_hard_limit_reached", // 400 — hard cap проекта достигнут
  "insufficient_quota", // 429 — квота исчерпана
  "quota_exceeded", // альтернативная формулировка квоты
  "access_terminated", // org/аккаунт деактивирован (бан/неоплата)
  "account_deactivated",
]);

/** Сообщения OpenAI про неоплаченный / деактивированный аккаунт (403/400). */
const BILLING_MESSAGE_RE =
  /billing hard limit|exceeded your (current )?quota|(account|billing|organization).{0,30}not active|account.{0,20}deactivated|account.{0,20}terminated/i;

export function isOpenAiBillingExhaustion(err: unknown): boolean {
  // Walk cause-chain (до 5 уровней) — наш providerHttpError / generic wrapper'ы
  // могут переложить оригинальную OpenAI-ошибку в `.cause`, потеряв `code` на
  // верхнем уровне. Симметрично isTransientNetworkError.
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (!cur || typeof cur !== "object") break;
    const e = cur as BillingErrorLike & { cause?: unknown };
    const code =
      typeof e.code === "string"
        ? e.code
        : typeof e.error?.code === "string"
          ? e.error.code
          : undefined;
    if (code && BILLING_CODES.has(code)) return true;
    const msg = typeof e.message === "string" ? e.message : "";
    if (msg && BILLING_MESSAGE_RE.test(msg)) return true;
    cur = e.cause;
  }
  return false;
}
