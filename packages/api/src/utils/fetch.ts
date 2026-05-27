import { logger } from "../logger.js";

/** Recursively truncate strings longer than `maxLen` characters. */
export function truncateStrings(value: unknown, maxLen = 20): unknown {
  if (typeof value === "string") {
    return value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateStrings(item, maxLen));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        truncateStrings(v, maxLen),
      ]),
    );
  }
  return value;
}

/**
 * Drop-in replacement for `fetch` that logs the URL, HTTP method, and request
 * body at debug level before each call.
 *
 * Body logging:
 *  - JSON string  → parsed, strings > 20 chars truncated, logged as object
 *  - Other string → logged as `<string N chars>`
 *  - ArrayBuffer / TypedArray → logged as `<binary N bytes>`
 *  - null / undefined → not logged
 *
 * Третий аргумент `customFetch` позволяет подменить транспорт (например, на
 * undici fetch с ProxyAgent — см. `ai/transport/proxy-fetch.ts`). Если не
 * передан — используется глобальный `fetch`.
 */
export async function fetchWithLog(
  url: string | URL | Request,
  init?: RequestInit,
  customFetch?: typeof globalThis.fetch,
): Promise<Response> {
  const method = init?.method ?? "GET";
  const urlStr = url instanceof Request ? url.url : String(url);

  if (logger.isLevelEnabled("debug")) {
    const body = init?.body;

    let bodyLog: unknown;
    if (body == null) {
      // no body — omit from log
    } else if (typeof body === "string") {
      try {
        bodyLog = truncateStrings(JSON.parse(body));
      } catch {
        bodyLog = `<string ${body.length} chars>`;
      }
    } else if (body instanceof ArrayBuffer) {
      bodyLog = `<binary ${body.byteLength} bytes>`;
    } else if (ArrayBuffer.isView(body)) {
      bodyLog = `<binary ${(body as ArrayBufferView).byteLength} bytes>`;
    } else if (body instanceof FormData) {
      const obj: Record<string, unknown> = {};
      for (const [key, val] of body.entries()) {
        if (val instanceof Blob) {
          obj[key] = `<blob ${val.size} bytes>`;
        } else {
          obj[key] = truncateStrings(val);
        }
      }
      bodyLog = obj;
    } else {
      bodyLog = "<body>";
    }

    logger.debug({ method, url: urlStr, ...(bodyLog !== undefined && { body: bodyLog }) }, "fetch");
  }

  const f = customFetch ?? fetch;
  try {
    return await f(url as Parameters<typeof fetch>[0], init);
  } catch (err) {
    // Undici выбрасывает `TypeError: fetch failed` без контекста — реальная
    // причина прячется в err.cause (.code: "ECONNRESET" и т.п.). Заворачиваем
    // в Error с понятным префиксом + сохраняем оригинал как cause, чтобы
    // isTransientNetworkError (walk через cause) и serializeError (тоже walk)
    // подобрали правильный код и напечатали URL/method/host в alert'е.
    const causeCode = extractErrorCode(err);
    const baseMsg = err instanceof Error ? err.message : String(err);
    const tagged = new Error(
      `fetch ${method} ${truncateUrl(urlStr)} failed${causeCode ? ` (${causeCode})` : ""}: ${baseMsg}`,
      { cause: err },
    );
    throw tagged;
  }
}

/** Walks err.cause до 5 уровней вглубь и возвращает первый найденный `code`. */
function extractErrorCode(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (typeof cur === "object" && cur !== null) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string") return code;
      cur = (cur as { cause?: unknown }).cause;
    } else break;
  }
  return null;
}

/** Обрезает query string и длинный path для алертов. Хранит host + первые 80 символов path. */
function truncateUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 80 ? u.pathname.slice(0, 77) + "..." : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url.length > 100 ? url.slice(0, 97) + "..." : url;
  }
}

/**
 * Node DNS/socket error codes that indicate a *transient* network failure —
 * the request never reached the remote server, so the operation can safely
 * be retried later without risk of duplicating side effects.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  "EAI_AGAIN", // DNS lookup temporarily failed (try again)
  "EAI_FAIL", // DNS lookup failed (usually transient upstream issue)
  "ENOTFOUND", // DNS name not found (often transient during resolver outages)
  "ECONNRESET", // connection reset mid-flight
  "ECONNREFUSED", // peer refused (load balancer reload etc.)
  "ETIMEDOUT", // socket-level timeout
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET", // undici socket error
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Returns true if the given error represents a transient network failure
 * (DNS hiccup, connection reset, etc.) rather than a logical/HTTP error.
 * Walks the `cause` chain because undici wraps the original libuv error.
 *
 * Принимает и Error-like объект (обычный путь из fetch'а), и сырую строку
 * (символика `s.errorRaw` в virtual-batch sub-job'ах — там message сохранён
 * в БД как plain string без code/cause). Без string-ветки batch не
 * классифицировал ENOTFOUND и не запускал fallback на evolink.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (typeof err === "string") {
    for (const code of TRANSIENT_NETWORK_CODES) {
      if (err.includes(code)) return true;
    }
    return false;
  }
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (typeof cur === "object" && cur !== null) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
      // undici generic wrapper exposes "fetch failed" — treat as transient only
      // when the underlying cause is a transient code (handled by the walk).
      cur = (cur as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

/**
 * Log an SDK call at debug level: model, action, and params (strings > 20 chars truncated).
 */
export function logCall(model: string, action: string, params: Record<string, unknown>): void {
  if (logger.isLevelEnabled("debug")) {
    logger.debug(
      { model, action, params: truncateStrings(params) as Record<string, unknown> },
      "sdk-call",
    );
  }
}
