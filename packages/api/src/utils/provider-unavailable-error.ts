/**
 * Provider temporarily unavailable / task processing failed: provider-side
 * issue (overload, upstream failure, internal pipeline error) signaled в
 * response message. Примеры:
 *  - KIE 422 "Service is currently unavailable due to high demand. Please try
 *    again later. (E003)"
 *  - KIE 422 "Models task execute failed." — terminal сбой выполнения задачи
 *    на конкретной модели (часто транзиентный backend-issue).
 *  - Evolink poll "unknown_error: Task processing failed. Please try again
 *    later or contact technical support."
 *  - Evolink 503 "service_error Service busy. Allocating resources, please
 *    retry later." — узел провайдера перегружен.
 *
 * Семантически отличается от rate-limit:
 *  - rate-limit = "ты слишком часто" → defer на cooldown'е, retry с тем же
 *    или другим ключом провайдера часто помогает (per-key throttle).
 *  - provider unavailable / task failed = "наш узел перегружен / задача упала
 *    у нас на стороне" → ни ключи провайдера, ни cooldown не помогут.
 *    Рациональная реакция — переключиться на fallback провайдера (другую
 *    модель), если зарегистрирован.
 *
 * "high demand" / "service unavailable" / "service busy" паттерны ТАКЖЕ
 * присутствуют (или должны присутствовать) в `RATE_LIMIT_PATTERNS` — это
 * намеренно:
 *  - Если у модели есть fallback-кандидат, processor поймает через
 *    `isProviderTemporaryUnavailable` ПЕРВЫМ и переключится на fallback.
 *  - Если fallback'а нет, fall-through сработает на rate-limit defer цикл
 *    (5×60s) → существующее поведение сохранено для legacy моделей.
 *
 * "task processing failed" / "task execute failed" / "allocating resources"
 * в RATE_LIMIT_PATTERNS НЕ дублируется — это не rate-limit, и без fallback'а
 * defer-loop бесполезен (провайдер уже упал на этой задаче, retry даст тот
 * же результат). Без fallback'а ошибка сразу пойдёт user-facing failure path.
 */
export function isProviderTemporaryUnavailable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: string };
  const msg = typeof e.message === "string" ? e.message : "";
  return /high demand|service is (currently )?unavailable|service unavailable|service busy|allocating resources|task (processing|execute) failed/i.test(
    msg,
  );
}
