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
  if (!err) return false;
  // Симметрично с `isKieTransientError`: принимаем и Error-like объект (общий
  // путь — exception из адаптера), и сырую строку (`s.errorRaw` в virtual-batch
  // sub-job'ах — там message сохранён в БД как plain string). Без string-ветки
  // VB-резабмит на 422 «high demand» не классифицировал ошибку transient'ом
  // и fallback не запускался.
  const msg =
    typeof err === "string"
      ? err
      : typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : "";
  if (!msg) return false;
  // `currently |temporarily ` — оба наречия в адверб-слоте между "is" и
  // "unavailable" должны матчиться. Наблюдали KIE 2026-05: failCode=422 с
  // failMsg "Service is temporarily unavailable. Please try again later. (E004)"
  // — провайдер явно сигналит transient через эту фразу, regex без вариаций
  // её пропускал, fallback не запускался → юзер ждал зря 3 ретрая.
  //
  // `Cloudflare Tunnel error|error 1033|Argo Tunnel`: KIE 2026-05-27 — Cloudflare
  // вернул HTML-страницу с error 1033 (Argo Tunnel до их origin лёг). Тело
  // ответа парсится как plain text, status=530. providerHttpError() поднимает
  // 530 в `err.status` → isFiveXxError ловит. Дублирующая text-проверка здесь —
  // safety net на случай если новый адаптер забудет про providerHttpError.
  return /high demand|service is (currently |temporarily )?unavailable|service unavailable|service busy|allocating resources|task (processing|execute) failed|Cloudflare Tunnel error|\berror 1033\b|Argo Tunnel/i.test(
    msg,
  );
}
