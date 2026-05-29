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
 * Также покрывает `422` с обёрнутым `499 Client Closed Request` от апстрима
 * (KIE→Google Vertex AI / Replicate): апстрим разорвал коннект до возврата
 * результата — классический transient, не наша вина, retry/fallback должен
 * сработать как при 5xx. Без этой ветки fallback пропускался на последней
 * попытке, юзер получал generic «модель устала».
 *
 * `422` + `"Director: unexpected error handling prediction (E9243)"` — внутренний
 * сбой KIE-пайплайна («Director») на poll'е (наблюдали 2026-05 на kling). Тот же
 * класс, что `playground failed` — не наша вина и не валидация ввода; на другом
 * backend'е (evolink/fal) генерация может пройти. Без этой ветки fallback
 * пропускался (`Video fallback skipped: not eligible`) и джоба падала целиком.
 *
 * `400` + `"Internal Error, Please try again later."` — KIE нестандартно
 * сигналит transient через 400-failCode (наблюдали 2026-05 на gpt-image-2).
 * Сочетание «Internal Error» + «try again later» — однозначный transient-
 * маркер (не модерация, не валидация), и под другие regex'ы (isPolicy /
 * isProviderTemporaryUnavailable) не попадает. Без этой ветки cascade на
 * evolink-fallback не запускался → юзер получал generic «модель устала».
 *
 * `422` + `429 Too Many Requests` (обычно для url `tempfile.redpandaai.co/...`)
 * — KIE завернул rate-limit от своего же storage CDN в свой failed-task
 * (наблюдали 2026-05 на kling-motion). Их временный storage по нашему
 * reference-видео отбил 429 → KIE не смог скачать его для генерации →
 * вернул failCode=422 с failMsg, содержащим оригинальный «429 Too Many
 * Requests». Это инфра-проблема на их стороне, retry с тем же ключом не
 * поможет (RL на самом storage, не на нашем ключе). Trigger'им fallback
 * на evolink — у kling-motion он зарегистрирован.
 *
 * Используется в image/video processor'ах в качестве fallback-trigger'а.
 */
export function isKieTransientError(err: unknown): boolean {
  if (isKieFiveXxError(err)) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (!/^KIE\b/i.test(message)) return false;
  const is422Transient =
    /\b422\b/.test(message) &&
    /playground failed|task id is blank|client closed request|director:? unexpected error/i.test(
      message,
    );
  const is400InternalRetry =
    /\b400\b/.test(message) && /internal error.*try again later/i.test(message);
  const is422TooManyRequests =
    /\b422\b/.test(message) && /\b429\b|too many requests/i.test(message);
  return is422Transient || is400InternalRetry || is422TooManyRequests;
}

/**
 * Возвращает true если ошибка — KIE 402 «Insufficient Credits»: наш
 * KIE-аккаунт пуст. Это не вина юзера и не вина запроса — provider-wide
 * состояние до пополнения. Ни retry, ни смена ключа не помогут.
 *
 * Используется в `submitWithFallback` как fallback-триггер: при пустом
 * KIE-аккаунте сразу переключаемся на fallback-провайдера (если зарегистрирован),
 * вместо того чтобы упирать юзера в «модель недоступна». Параллельно летит
 * ops-алёрт в balance-канал — KIE надо пополнить независимо от того, спас ли
 * fallback конкретный запрос.
 *
 * Матчит обе формы: обёрнутый UserFacingError из адаптера ("KIE credits
 * exhausted (...)") и generic-ошибку ("KIE submit failed: 402 — ...").
 */
export function isKieCreditsExhausted(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (!/^KIE\b/i.test(message)) return false;
  if (/credits?\s+exhausted/i.test(message)) return true;
  return /\b402\b/.test(message) && /credits?\b|insufficient|balance.*enough/i.test(message);
}
