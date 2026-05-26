/**
 * Sends a structured error notification to the tech Telegram chat (ALERT_CHAT_ID).
 * Silently no-ops if ALERT_CHAT_ID is not configured.
 */

import { config } from "@metabox/shared";
import { Api } from "grammy";
import { getRedis } from "@metabox/api/redis";
import { scrubBotTokens } from "@metabox/api/utils/bot-token-scrub";

const telegram = new Api(config.bot.token);

export interface ErrorContext {
  /** BullMQ job ID or DB job ID */
  jobId?: string;
  /** Model/provider ID (e.g. "flux-pro", "kling") */
  modelId?: string;
  /** Section: image, video, audio, avatar */
  section?: string;
  /** Internal user ID */
  userId?: string;
  /** Number of attempts made so far */
  attempt?: number;
  /**
   * True если часть sub-jobs всё-таки завершилась успешно — юзер получил
   * частичный результат, джоб БД помечен `completed`, не `failed`. Меняет
   * заголовок алерта на ⚠️, чтобы ops видели разницу со «всё упало».
   */
  partialSuccess?: boolean;
}

/**
 * Serializes an error into a full diagnostic string, including nested cause chain,
 * structured fal error detail, and stack trace.
 *
 * Specifically для undici-style ошибок: `TypeError: fetch failed` несёт
 * реальную причину в `cause` (с полем `code` типа "ECONNRESET"). Walk'аем
 * cause-chain, на каждом уровне выводим code/errno/syscall/address если есть —
 * без этого alert получается бесполезным "fetch failed".
 *
 * Перед return скрабится Telegram bot token (см. `scrubBotTokens`). Рекурсивные
 * вызовы scrub'ятся независимо, top-level join тоже — идемпотентность ок.
 */
function serializeError(err: unknown): string {
  if (err === null || err === undefined) return String(err);

  const parts: string[] = [];

  if (typeof err === "object") {
    const e = err as Record<string, unknown>;

    // Standard Error fields
    if (typeof e.message === "string") parts.push(e.message);
    if (typeof e.status === "number" || typeof e.statusCode === "number") {
      parts.push(`HTTP ${e.status ?? e.statusCode}`);
    }

    // Network-уровень: code/errno/syscall/host (undici, libuv, dns).
    const code = e.code ?? e.errno;
    if (typeof code === "string" || typeof code === "number") {
      parts.push(`code: ${code}`);
    }
    if (typeof e.syscall === "string") parts.push(`syscall: ${e.syscall}`);
    if (typeof e.address === "string") parts.push(`address: ${e.address}`);
    if (typeof e.hostname === "string") parts.push(`hostname: ${e.hostname}`);
    if (typeof e.port === "number") parts.push(`port: ${e.port}`);

    // fal structured body
    if (e.body !== undefined) {
      try {
        parts.push("body: " + JSON.stringify(e.body, null, 2));
      } catch {
        parts.push("body: [unserializable]");
      }
    }

    // Stack trace
    if (typeof e.stack === "string") {
      // Only the first 5 lines of the stack to keep the message readable
      const stackLines = e.stack.split("\n").slice(0, 6).join("\n");
      parts.push(stackLines);
    }

    // Cause chain
    if (e.cause !== undefined) {
      parts.push("caused by: " + serializeError(e.cause));
    }
  } else {
    parts.push(String(err));
  }

  return scrubBotTokens(parts.join("\n"));
}

const PROVIDER_OUT_ALERT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ALERTS_PER_WINDOW = 5;

/**
 * Burst-throttled variant of `notifyTechError` — sends up to `maxAlerts`
 * alerts per `dedupKey` within `ttlMs`, then stays silent until the TTL
 * expires. Use for provider-wide conditions that affect every user job
 * (e.g. credits exhausted, key revoked).
 *
 * The burst is intentional: a single muted alert is easy to miss when
 * we're AFK, so we let the tech channel ping a few times to make sure
 * someone notices. After the burst we go quiet to avoid a flood when
 * the issue persists for hours.
 *
 * Falls back to an unthrottled send if Redis is unavailable.
 */
export async function notifyTechErrorThrottled(
  err: unknown,
  ctx: ErrorContext,
  dedupKey: string,
  opts: { maxAlerts?: number; ttlMs?: number; channel?: "alerts" | "balance" } = {},
): Promise<void> {
  const maxAlerts = opts.maxAlerts ?? DEFAULT_MAX_ALERTS_PER_WINDOW;
  const ttlMs = opts.ttlMs ?? PROVIDER_OUT_ALERT_TTL_MS;
  const redis = getRedis();
  const counterKey = `alert:tech:${dedupKey}:count`;

  let count: number;
  try {
    count = await redis.incr(counterKey);
    if (count === 1) {
      // First alert in the window → set TTL so the counter resets later.
      await redis.pexpire(counterKey, ttlMs);
    }
  } catch {
    // Redis down → don't swallow, send through.
    await notifyTechError(err, ctx, opts.channel);
    return;
  }

  if (count > maxAlerts) return;
  await notifyTechError(err, ctx, opts.channel);
}

/**
 * Sends a tech error alert. `channel` выбирает тему: `"alerts"` (default —
 * ALERT_CHAT_ID, общие tech-ошибки) или `"balance"` (BALANCE_ALERT_CHAT_ID,
 * тема про баланс/кредиты провайдеров). Does not throw — always resolves.
 */
export async function notifyTechError(
  err: unknown,
  ctx: ErrorContext,
  channel: "alerts" | "balance" = "alerts",
): Promise<void> {
  const dest = channel === "balance" ? config.balanceAlerts : config.alerts;
  const chatId = dest.chatId;
  if (!chatId) return;

  const threadId = dest.threadId;

  const label = [ctx.section, ctx.modelId].filter(Boolean).join("/") || "unknown";
  const header = ctx.partialSuccess
    ? `⚠️ <b>Sub-job failure (partial success)</b> [${label}]`
    : `🔴 <b>Job error</b> [${label}]`;

  const meta: string[] = [];
  if (ctx.jobId) meta.push(`job: <code>${ctx.jobId}</code>`);
  if (ctx.userId) meta.push(`user: <code>${ctx.userId}</code>`);
  if (ctx.attempt !== undefined) meta.push(`attempt: ${ctx.attempt}`);

  const errorText = serializeError(err);
  // Telegram HTML message cap is 4096 chars — truncate the error body if needed
  const maxErrorLen = 3500 - header.length - meta.join(" | ").length;
  const truncated =
    errorText.length > maxErrorLen ? errorText.slice(0, maxErrorLen) + "\n…[truncated]" : errorText;

  const text = [
    header,
    meta.length ? meta.join(" | ") : null,
    `<pre>${escapeHtml(truncated)}</pre>`,
  ]
    .filter(Boolean)
    .join("\n");

  await telegram
    .sendMessage(chatId, text, {
      parse_mode: "HTML",
      ...(threadId ? { message_thread_id: threadId } : {}),
    })
    .catch(() => void 0); // never let alerting break the worker flow
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface RateLimitNotificationContext {
  section?: string;
  modelId: string;
  cooldownMs: number;
  reason: string;
  isLongWindow: boolean;
  /**
   * Оригинальная ошибка для serializeError — полное тело ответа провайдера,
   * cause-chain, code/syscall. Без этого alert обрезает body на ~160 символах
   * (cls.reason идёт усечённый из classifyRateLimit).
   */
  err?: unknown;
  /**
   * BullMQ/DB jobId для dedup'а через Redis. Без него один и тот же job на
   * каждом retry'е (раз в cooldownMs ≈ минуту) спамил тех-канал. Если не
   * указан — dedup по `modelId:reason-hash` (более грубо, но всё равно гасит).
   */
  jobId?: string;
}

/** Минимум на сколько душим повторы алертов за один rate-limit эпизод. */
const RATE_LIMIT_ALERT_MIN_TTL_MS = 10 * 60 * 1000;

function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * Sends a rate-limit / throttle notification to ALERT_CHAT_ID. Distinct from
 * `notifyTechError` so the on-call thread can be filtered visually.
 * Does not throw — always resolves.
 *
 * Dedup: одна и та же rate-limit ошибка одного job'а (или одной модели если
 * jobId не пришёл) шлёт alert один раз за TTL = max(cooldownMs * 6,
 * RATE_LIMIT_ALERT_MIN_TTL_MS). До этого фикса каждый retry job'а (раз в
 * cooldownMs) генерировал отдельный alert.
 */
export async function notifyRateLimit(ctx: RateLimitNotificationContext): Promise<void> {
  const chatId = config.alerts.chatId;
  if (!chatId) return;

  // Dedup. Ключ включает jobId если есть — иначе по modelId+reason-hash чтобы
  // одинаковые rate-limit'ы разных задач на одной модели всё-таки гасились.
  const dedupSuffix = ctx.jobId ?? shortHash(ctx.reason);
  const dedupKey = `alert:ratelimit:${ctx.modelId}:${dedupSuffix}`;
  const ttl = Math.max(ctx.cooldownMs * 6, RATE_LIMIT_ALERT_MIN_TTL_MS);
  const setResult = await getRedis()
    .set(dedupKey, ctx.reason.slice(0, 80), "PX", ttl, "NX")
    .catch(() => null);
  if (setResult !== "OK") return;

  const threadId = config.alerts.threadId;

  const icon = ctx.isLongWindow ? "⛔" : "⏳";
  const kind = ctx.isLongWindow ? "Long-window quota" : "Rate limit";
  const label = [ctx.section, ctx.modelId].filter(Boolean).join("/") || ctx.modelId;
  const header = `${icon} <b>${kind}</b> [${label}]`;

  const cooldownLabel =
    ctx.cooldownMs >= 60_000
      ? `${Math.round(ctx.cooldownMs / 60_000)}m`
      : `${Math.round(ctx.cooldownMs / 1000)}s`;

  // Если есть оригинальный err — сериализуем полностью (тело провайдера,
  // cause-chain, code/syscall). Иначе fallback на (усечённый) cls.reason.
  const body = ctx.err !== undefined ? serializeError(ctx.err) : ctx.reason;

  const meta: string[] = [`cooldown: <code>${cooldownLabel}</code>`];
  if (ctx.jobId) meta.push(`job: <code>${ctx.jobId}</code>`);

  // Telegram cap 4096; оставляем запас на header/meta/HTML escaping.
  const maxBodyLen = 3500 - header.length - meta.join(" | ").length;
  const truncated = body.length > maxBodyLen ? body.slice(0, maxBodyLen) + "\n…[truncated]" : body;

  const text = [header, meta.join(" | "), `<pre>${escapeHtml(truncated)}</pre>`].join("\n");

  await telegram
    .sendMessage(chatId, text, {
      parse_mode: "HTML",
      ...(threadId ? { message_thread_id: threadId } : {}),
    })
    .catch(() => void 0);
}

export interface FallbackNotificationContext {
  /** "image" | "video" */
  section: string;
  /** Common modelId (primary == fallback id by construction). */
  modelId: string;
  /** Provider строка primary модели. */
  primaryProvider: string;
  /** Provider строка модели на которую переключились (или null если все упали). */
  fallbackProvider: string | null;
  /** Причина переключения. */
  reason:
    | "pool_exhausted"
    | "long_window_rate_limit"
    | "persistent_5xx"
    | "provider_long_cooldown_marker"
    | "kie_credits_exhausted"
    | "all_candidates_failed"
    /** Primary-провайдер вернул ошибку — адаптер-внутренний фолбэк (KieElevenLabs → прямой EL). */
    | "primary_failed"
    /** Primary упал с unclassified-ошибкой (validation / content policy / network reset
     *  / неизвестный 4xx-body) — fallback на соседнего кандидата. Параллельно
     *  submitWithFallback уже шлёт per-candidate notifyTechErrorThrottled с
     *  оригинальным err'ом. */
    | "unknown_error";
  /** GenerationJob.id для трассировки. */
  jobId?: string;
  /** Internal user ID, если доступен. */
  userId?: string;
}

/**
 * Алерт в технический tg-канал о факте fallback'а.
 *
 * Раньше был дедуп через Redis SETNX (TTL 5 мин), но он скрывал реальную
 * частоту fallback'ов и мешал диагностике (один сбойный провайдер мог
 * генерировать сотни fallback'ов за окно, и все они уходили только в лог).
 * Теперь алерт идёт на каждый fallback — пусть шумно, зато честно.
 *
 * Канал: `fallbackAlerts.chatId` (FALLBACK_ALERT_CHAT_ID), с фоллбеком на
 * общий `alerts.chatId`. Это позволяет направить шумные fallback'и в
 * отдельный канал/тему, не засоряя основной on-call alert.
 */
export async function notifyFallback(ctx: FallbackNotificationContext): Promise<void> {
  const chatId = config.fallbackAlerts.chatId;
  if (!chatId) return;

  const threadId = config.fallbackAlerts.threadId;
  const allFailed = ctx.fallbackProvider === null;
  const header = allFailed
    ? `❌ <b>Fallback FAILED</b> [${ctx.section}/${ctx.modelId}]`
    : `🔁 <b>Fallback</b> [${ctx.section}/${ctx.modelId}]`;

  const lines: string[] = [header];
  if (allFailed) {
    lines.push(`all candidates exhausted (primary: <code>${ctx.primaryProvider}</code>)`);
  } else {
    lines.push(`<code>${ctx.primaryProvider}</code> → <code>${ctx.fallbackProvider}</code>`);
  }
  lines.push(`reason: <code>${ctx.reason}</code>`);

  const meta: string[] = [];
  if (ctx.jobId) meta.push(`job: <code>${ctx.jobId}</code>`);
  if (ctx.userId) meta.push(`user: <code>${ctx.userId}</code>`);
  if (meta.length) lines.push(meta.join(" | "));

  await telegram
    .sendMessage(chatId, lines.join("\n"), {
      parse_mode: "HTML",
      ...(threadId ? { message_thread_id: threadId } : {}),
    })
    .catch(() => void 0);
}
