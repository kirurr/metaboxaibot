/**
 * Provider-agnostic rate-limit / concurrency error classifier.
 *
 * Async generation providers (fal, runway, heygen, google, openai, higgsfield,
 * luma, minimax, pika, alibaba…) all have their own ways of signalling
 * "back off" — HTTP 429, custom error codes, JSON bodies with `RESOURCE_EXHAUSTED`,
 * plain-text "too many requests in flight". This module collapses them into a
 * single boolean + a cooldown hint + a long-window flag.
 *
 * The long-window flag is a heuristic — daily/monthly quotas can't always be
 * distinguished from per-minute bursts on first contact. We err on "short" by
 * default and graduate the detection list as we see new error shapes in
 * production.
 */

/** Per-provider cooldown when the error doesn't carry a Retry-After hint. */
const COOLDOWN_MS: Record<string, number> = {
  fal: 60_000,
  runway: 60_000,
  heygen: 60_000,
  google: 60_000,
  openai: 60_000,
  higgsfield: 90_000,
  luma: 60_000,
  minimax: 60_000,
  pika: 60_000,
  alibaba: 60_000,
  replicate: 60_000,
  elevenlabs: 60_000,
  cartesia: 60_000,
  did: 60_000,
};
const DEFAULT_COOLDOWN_MS = 60_000;

/** If a detected cooldown exceeds this, we treat it as a long-window quota. */
export const LONG_WINDOW_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/** Patterns that strongly suggest a daily/monthly quota, not a per-minute burst. */
const LONG_WINDOW_PATTERNS: RegExp[] = [
  /daily quota/i,
  /daily limit/i,
  /monthly quota/i,
  /monthly limit/i,
  /quota exceeded for/i,
  /usage limit/i,
  /trial limit/i,
  /out of credits/i,
  /insufficient credits/i,
  /credit exhausted/i,
  /account.*suspended/i,
  /tier limit/i,
  // Google AI Studio / Gemini / Veo: при превышении billing-quota шлют 429
  // с message "You exceeded your current quota, please check your plan and
  // billing details." Это per-account/project лимит — другие наши ключи
  // могут быть ещё в порядке, поэтому per-key throttle (а не provider-wide).
  /exceeded your (current )?quota/i,
];

/**
 * Default cooldown (per-key) for pattern-matched long-window quotas without
 * explicit Retry-After header. Bumped from 60s default к 1h: дневные/месячные
 * квоты обычно живут долго, 60-секундный throttle почти бесполезен — после
 * него мы тут же снова хватаем тот же 429.
 *
 * Намеренно равен LONG_WINDOW_THRESHOLD_MS (НЕ строго больше) — submit-fallback
 * gate `cooldownMs > LONG_WINDOW_THRESHOLD_MS` НЕ срабатывает, provider-wide
 * marker не ставим. Per-account quota блокирует только конкретный ключ;
 * соседние ключи провайдера остаются в пуле.
 */
const LONG_WINDOW_PATTERN_COOLDOWN_MS = 60 * 60 * 1000;

/** Patterns that mark an error as rate-limit / concurrency related.
 *
 * Намеренно НЕ включаем общие "try again later" / "please retry" — провайдеры
 * (Anthropic, OpenAI, kie и т.п.) шлют их в обычных 5xx-ошибках типа
 * "Server exception, please try again later" — это transient server failure,
 * а не rate-limit. Реальные rate-limit'ы и так матчатся через 429 status,
 * "rate limit" / "too many requests" / "quota" / "throttle". */
const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate limit/i,
  /rate_limit/i,
  /too many requests/i,
  /too_many_requests/i,
  /resource_exhausted/i,
  /quota/i,
  /concurrency/i,
  /concurrent (request|generation)/i,
  /throttl/i,
  // Provider-side overload (e.g. KIE 422 "Service is currently unavailable
  // due to high demand. Please try again later. (E003)") — транзиентный отказ
  // на стороне провайдера, не error в нашем запросе. Применяем backoff
  // вместо немедленного fail'а.
  /high demand/i,
  /service is (currently )?unavailable/i,
  /service unavailable/i,
];

export interface RateLimitClassification {
  isRateLimit: boolean;
  /** Recommended cooldown in ms. Only meaningful if `isRateLimit` is true. */
  cooldownMs: number;
  /** True if this looks like a long-window (daily/monthly) quota — caller should fail the job. */
  isLongWindow: boolean;
  /** Short reason string for logs / Redis gate value. */
  reason: string;
}

interface ErrorLike {
  status?: number;
  statusCode?: number;
  code?: string | number;
  message?: string;
  headers?: Record<string, string | string[] | undefined>;
  response?: { status?: number; headers?: Record<string, string | string[] | undefined> };
}

function asErrorLike(err: unknown): ErrorLike {
  if (err && typeof err === "object") return err as ErrorLike;
  return { message: typeof err === "string" ? err : undefined };
}

function getStatus(e: ErrorLike): number | undefined {
  return e.status ?? e.statusCode ?? e.response?.status;
}

function getMessage(e: ErrorLike): string {
  if (typeof e.message === "string") return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Parse a Retry-After header value (seconds or HTTP-date) into ms. */
function parseRetryAfter(headers?: Record<string, string | string[] | undefined>): number | null {
  if (!headers) return null;
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return Math.max(0, asNumber * 1000);
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

/**
 * Returns true if the error looks like an HTTP 5xx response.
 * Используется в fallback-логике как «provider transient failure» сигнал,
 * отличный от 429 (rate-limit) и валидационных 4xx.
 */
export function isFiveXxError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; statusCode?: number; response?: { status?: number } };
  const status = e.status ?? e.statusCode ?? e.response?.status;
  return typeof status === "number" && status >= 500 && status < 600;
}

/**
 * Конструктор-двойник `isFiveXxError`: plain `Error` с числовым `status`,
 * проставленным ТОЛЬКО для 5xx. Адаптеры на голом `fetch` иначе кладут статус
 * провайдера лишь в текст сообщения, а property-based классификаторы
 * (`isFiveXxError`, `classifyError`) и `submitWithFallback` его не видят →
 * fallback по 5xx не триггерится.
 *
 * Для не-5xx статус не проставляем — поведение 4xx/429 не меняем (их ловят
 * `classifyRateLimit` / message-based ветки). `null`/`undefined` (напр.
 * отсутствующий `errorCode` в provider-ответе) просто игнорируются.
 */
export function providerHttpError(message: string, status: number | null | undefined): Error {
  const err: Error & { status?: number } = new Error(message);
  if (typeof status === "number" && status >= 500 && status < 600) {
    err.status = status;
  }
  return err;
}

/**
 * Распознаёт «битое/неподдерживаемое изображение в инпуте» — провайдер
 * 400'ит до начала генерации с конкретным текстом. Это perm-error: ретраить
 * и переключать fallback-провайдера бессмысленно, нужно сразу показать юзеру
 * понятное сообщение.
 *
 * Покрытие:
 *  - OpenAI (chat completions / responses): «does not represent a valid image»
 *  - OpenAI: «Invalid image» / «Could not process image»
 *  - Anthropic: «could not process the image» / «Invalid image»
 *  - Generic: «unsupported image format» / «supported image formats»
 */
const INVALID_IMAGE_PATTERNS: RegExp[] = [
  /does not represent a valid image/i,
  /supported image formats/i,
  /could not process (the )?image/i,
  /\binvalid image\b/i,
  /unsupported image (format|type)/i,
];

export function isInvalidImageError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { status?: number; statusCode?: number; message?: unknown };
  const status = e.status ?? e.statusCode;
  if (typeof status === "number" && status !== 400) return false;
  const msg = typeof e.message === "string" ? e.message : String(err);
  return INVALID_IMAGE_PATTERNS.some((p) => p.test(msg));
}

/** Node net + undici error codes для обрывов соединения / DNS / таймаутов. */
const TRANSIENT_NETWORK_CODES = new Set<string>([
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  // ⚠️ Сейчас безопасно: AbortController в chat-пути не используется, поэтому
  // UND_ERR_ABORTED прилетает только из внутренних таймаутов SDK (это transient).
  // ЕСЛИ появится фича «отменить генерацию» через AbortController — этот код
  // будет ретраить отменённый юзером запрос. В таком случае надо либо убрать
  // UND_ERR_ABORTED отсюда, либо проверять `signal.aborted` отдельно.
  "UND_ERR_ABORTED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  // node-fetch v2 (используется OpenAI SDK v4 по умолчанию) выставляет этот код
  // когда upstream закрыл соединение пока response body ещё стримился. Для нас
  // = transient разрыв провайдера, безопасно ретраить.
  "ERR_STREAM_PREMATURE_CLOSE",
]);

/** Имена классов ошибок, которые SDK провайдеров используют для сетевых сбоев. */
const TRANSIENT_NETWORK_NAMES = new Set<string>([
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "FetchError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "SocketError",
]);

/** Сообщения, которые undici/Node/SDK кладут в обычный TypeError/Error. */
const TRANSIENT_NETWORK_MESSAGE_PATTERNS: RegExp[] = [
  /\bterminated\b/i,
  /socket hang up/i,
  /fetch failed/i,
  /network (error|failure)/i,
  /other side closed/i,
  /connection (reset|closed|terminated|aborted)/i,
  /\beconnreset\b/i,
  /\betimedout\b/i,
  // Fallback на случай если code потерян при wrapping'е (некоторые SDK
  // переоборачивают node-fetch FetchError в свой Error без сохранения `code`).
  /\bpremature close\b/i,
];

/**
 * True для ошибок, означающих транзиентный сетевой сбой (TCP-обрыв, таймаут,
 * DNS-флап) — у таких ошибок нет HTTP-статуса, поэтому `isFiveXxError` их
 * не ловит. Безопасно ретраить (запрос не дошёл до серверной обработки или
 * ответ не дошёл до нас целиком).
 *
 * Обходит `cause` рекурсивно: undici `TypeError: terminated` хранит
 * настоящий `SocketError` с `code` именно в `cause`.
 *
 * Guard: если у ошибки есть HTTP-статус — это ответ от провайдера, не сетевой
 * обрыв. 5xx обработает `isFiveXxError`, остальное — terminal-ошибки, ретраить
 * нельзя. Без этого guard'а `\bterminated\b`/`connection (reset|closed|…)` могли
 * ложно матчить HTTP-тела с такими словами от провайдера.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const top = err as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  const httpStatus =
    typeof top.status === "number"
      ? top.status
      : typeof top.statusCode === "number"
        ? top.statusCode
        : typeof top.response?.status === "number"
          ? top.response.status
          : undefined;
  if (httpStatus !== undefined) return false;

  const visited = new Set<object>();
  const stack: unknown[] = [err];

  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || visited.has(cur as object)) continue;
    visited.add(cur as object);

    const e = cur as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };

    if (typeof e.code === "string" && TRANSIENT_NETWORK_CODES.has(e.code)) return true;
    if (typeof e.name === "string" && TRANSIENT_NETWORK_NAMES.has(e.name)) return true;
    if (typeof e.message === "string") {
      for (const p of TRANSIENT_NETWORK_MESSAGE_PATTERNS) {
        if (p.test(e.message)) return true;
      }
    }
    if (e.cause !== undefined) stack.push(e.cause);
  }

  return false;
}

/** Classify an arbitrary thrown error as rate-limit-related or not. */
export function classifyRateLimit(err: unknown, provider?: string): RateLimitClassification {
  const e = asErrorLike(err);
  const status = getStatus(e);
  const message = getMessage(e);
  const code = typeof e.code === "string" ? e.code : undefined;

  const matchesPattern = RATE_LIMIT_PATTERNS.some((p) => p.test(message));
  const isRateLimit =
    status === 429 ||
    code === "RESOURCE_EXHAUSTED" ||
    code === "rate_limit_exceeded" ||
    code === "TOO_MANY_REQUESTS" ||
    matchesPattern;

  if (!isRateLimit) {
    return { isRateLimit: false, cooldownMs: 0, isLongWindow: false, reason: "" };
  }

  const retryAfterMs = parseRetryAfter(e.headers) ?? parseRetryAfter(e.response?.headers) ?? null;

  const baseCooldown =
    (provider ? COOLDOWN_MS[provider.toLowerCase()] : undefined) ?? DEFAULT_COOLDOWN_MS;

  const matchedLongWindow = LONG_WINDOW_PATTERNS.some((p) => p.test(message));

  // Cooldown precedence: explicit Retry-After > pattern-matched long-window
  // (1h) > provider default (60s). Без bump'а до 1h pattern-matched квоты
  // не давали меняться ключам — markRateLimited на 60с и тот же ключ снова
  // хватал тот же 429.
  const cooldownMs =
    retryAfterMs && retryAfterMs > 0
      ? retryAfterMs
      : matchedLongWindow
        ? LONG_WINDOW_PATTERN_COOLDOWN_MS
        : baseCooldown;

  const isLongWindow = matchedLongWindow || cooldownMs > LONG_WINDOW_THRESHOLD_MS;

  const reason = `${status ?? code ?? "rate_limit"}: ${message}`;

  return { isRateLimit: true, cooldownMs, isLongWindow, reason };
}
