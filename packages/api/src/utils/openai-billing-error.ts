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

interface BillingErrorLike {
  code?: unknown;
  message?: unknown;
  error?: { code?: unknown };
}

export function isOpenAiBillingExhaustion(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as BillingErrorLike;
  const code =
    typeof e.code === "string"
      ? e.code
      : typeof e.error?.code === "string"
        ? e.error.code
        : undefined;
  if (code === "billing_hard_limit_reached" || code === "insufficient_quota") return true;
  const msg = typeof e.message === "string" ? e.message : "";
  if (!msg) return false;
  return /billing hard limit/i.test(msg) || /exceeded your (current )?quota/i.test(msg);
}
