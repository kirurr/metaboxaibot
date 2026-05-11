/**
 * KIE-specific error helpers.
 *
 * Контекст: KIE при ошибке генерации (state==="fail" в recordInfo) НЕ перезапускает
 * генерацию на своей стороне и НЕ списывает за неудачную попытку. Если возвращён
 * 5xx-failCode — это терминальная ошибка модели, никаких retry'ев у провайдера
 * не будет. Воркер должен либо переключиться на fallback (по плану — после
 * исчерпания BullMQ retry'ев на poll-стадии), либо пометить job failed.
 *
 * Текст ошибки KIE adapter'а: `KIE ${modelId} generation failed: ${failCode} ${failMsg}`.
 * Также HTTP-уровень: `KIE * poll error ${status}` / `KIE * poll failed: ${code} — ${msg}`.
 */

/**
 * Возвращает true если ошибка — это KIE 5xx terminal failure из poll'а.
 * Используется в processor'ах для триггера re-submit на fallback.
 */
export function isKieFiveXxError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (!/^KIE\b/i.test(message)) return false;
  // Cover three KIE error shapes:
  //   "KIE foo generation failed: 500 Internal Error" (state=fail с 5xx failCode)
  //   "KIE foo poll error 502" (HTTP-уровень)
  //   "KIE foo poll failed: 503 — bad gateway" (KIE-API code 5xx)
  return /\b5\d{2}\b/.test(message);
}

/**
 * Возвращает true для любых KIE-ошибок которые надо трактовать как transient
 * KIE-side инфра-проблему (а не баг/policy-violation): покрывает 5xx + известные
 * 422-паттерны когда KIE-бэкенд («playground») сам в трауре.
 *
 * Контекст: 2026-05 поймали инцидент когда KIE возвращал на poll'е
 * `failCode=422` с `failMsg="generate playground failed, task id is blank"` —
 * это их внутренняя ошибка про потерю taskId на их стороне (мы при этом
 * передавали валидный 32-символьный hash). Ошибка одинаково летела для
 * gpt-image-2, nano-banana-2/pro и grok-imagine-r2v одновременно у разных
 * юзеров — массовый их инцидент. Трактуем как `5xx-эквивалент`: triggers
 * re-submit на fallback провайдера (если есть), retry'и BullMQ если нет.
 *
 * Используется в image/video processor'ах в качестве fallback-trigger'а.
 */
export function isKieTransientError(err: unknown): boolean {
  if (isKieFiveXxError(err)) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (!/^KIE\b/i.test(message)) return false;
  return /\b422\b/.test(message) && /playground failed|task id is blank/i.test(message);
}
