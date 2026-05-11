/**
 * Central config module. Import after `dotenv/config` is loaded.
 *
 * Required vars throw at startup if missing.
 * Optional vars return undefined or a typed default.
 *
 * Usage:
 *   import { config } from "@metabox/shared";
 *   config.bot.token       // string
 *   config.ai.openai       // string | undefined
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[config] Missing required env var: ${name}`);
  return v;
}

function opt(name: string): string | undefined {
  return process.env[name] || undefined;
}

function optDefault<T extends string>(name: string, fallback: T): T {
  return (process.env[name] as T | undefined) ?? fallback;
}

function optInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (isNaN(n)) throw new Error(`[config] ${name} must be an integer, got: "${v}"`);
  return n;
}

function optFloat(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseFloat(v);
  if (isNaN(n)) throw new Error(`[config] ${name} must be a number, got: "${v}"`);
  return n;
}

export const config = {
  /** Runtime environment */
  env: optDefault("NODE_ENV", "development") as "development" | "production" | "test",

  /** Telegram Bot */
  bot: {
    token: req("BOT_TOKEN"),
    webappUrl: opt("WEBAPP_URL"),
    /**
     * When true, route Bot API calls through Telegram's Test Data-Center
     * (`/bot<TOKEN>/test/...`). Tokens issued by @BotFather inside the test
     * environment only work against this endpoint — without the flag every
     * call returns 401 Unauthorized.
     *
     * Set `TELEGRAM_TEST_ENV=1` (or `true`) in `.env` during local dev.
     */
    testEnvironment:
      (opt("TELEGRAM_TEST_ENV") ?? "").toLowerCase() === "true" || opt("TELEGRAM_TEST_ENV") === "1",
  },

  /** Database & cache */
  db: {
    url: req("DATABASE_URL"),
  },
  redis: {
    url: req("REDIS_URL"),
  },

  /** API server */
  api: {
    port: optInt("API_PORT", 3001),
    adminSecret: opt("ADMIN_SECRET"),
    /** Public base URL for this API server, used to generate download links (e.g. https://api.meta-box.ru). */
    publicUrl: opt("API_PUBLIC_URL"),
    /**
     * Master-секрет для шифрования значений в provider_keys / proxies (AES-256-GCM).
     * Обязателен: без него нечем расшифровать сохранённые ключи провайдеров.
     */
    keyVaultMaster: req("KEY_VAULT_MASTER"),
  },

  /** Observability */
  log: {
    level: optDefault("LOG_LEVEL", "info"),
  },
  sentry: {
    dsn: opt("SENTRY_DSN"),
  },

  /**
   * Billing parameters.
   * usdPerToken: how many USD one internal token is worth (Pro plan: $0.043).
   * targetMargin: multiplier over provider break-even (2.0 = 2× cost = ~100% gross margin).
   * Override via BILLING_USD_PER_TOKEN / BILLING_TARGET_MARGIN env vars.
   */
  billing: {
    usdPerToken: optFloat("BILLING_USD_PER_TOKEN", 0.02),
    targetMargin: optFloat("BILLING_TARGET_MARGIN", 1.0),
  },

  /**
   * Payments / Telegram Stars pricing.
   *
   * starPriceRub — RUB-эквивалент одной звезды Telegram. Используется напрямую
   * при расчёте цены инвойсов в звёздах (`calcStars(priceRub) = ceil(priceRub /
   * starPriceRub / 10) * 10`) и при записи `starRate` в Metabox recordSale.
   *
   * Раньше считалось через USD: `priceRub / usdtRubRate / STAR_PRICE_USD`.
   * Теперь — одна константа в рублях, конфигурируется через env, чтобы
   * подстраиваться под фактический курс Telegram Stars в RUB без редеплоя.
   *
   * Override через STAR_PRICE_RUB.
   */
  payments: {
    starPriceRub: optFloat("STAR_PRICE_RUB", 1.7136),
  },

  /**
   * S3-compatible object storage (optional).
   * If S3_BUCKET is not set, file uploads are skipped gracefully.
   * Compatible with AWS S3, Cloudflare R2, MinIO, etc.
   */
  s3: {
    bucket: opt("S3_BUCKET"),
    region: optDefault("S3_REGION", "auto"),
    endpoint: opt("S3_ENDPOINT"), // e.g. https://<account>.r2.cloudflarestorage.com
    accessKeyId: opt("S3_ACCESS_KEY_ID"),
    secretAccessKey: opt("S3_SECRET_ACCESS_KEY"),
    /** Public base URL for direct downloads (e.g. https://cdn.example.com). */
    publicUrl: opt("S3_PUBLIC_URL"),
  },

  /**
   * Admin alerts (optional) — tech errors, rate-limits, low-balance warnings.
   * Шлются через notifyTechError / notifyRateLimit / balance.monitor.
   *
   * ALERT_CHAT_ID — Telegram chat/channel ID для всех алертов.
   * ALERT_THREAD_ID — message_thread_id (для тем в супергруппах), опционально.
   * ALERT_INTERVAL_HOURS — частота проверки балансов (default: 12).
   * ALERT_FAL_THRESHOLD_USD — порог алерта по балансу FAL (default: 5).
   * ALERT_ELEVENLABS_THRESHOLD_CHARS — порог по остатку символов ElevenLabs (default: 10000).
   */
  alerts: {
    chatId: opt("ALERT_CHAT_ID"),
    threadId: optInt("ALERT_THREAD_ID", 0) || undefined,
    intervalHours: optFloat("ALERT_INTERVAL_HOURS", 12),
    falThresholdUsd: optFloat("ALERT_FAL_THRESHOLD_USD", 5),
    elevenlabsThresholdChars: optInt("ALERT_ELEVENLABS_THRESHOLD_CHARS", 10_000),
  },

  /**
   * Recurring reports (optional) — daily usage digest и подобные регулярные
   * информационные сводки. Отделены от alerts, чтобы их можно было слать
   * в другой канал/тему (нагрузка на алерт-канал у on-call'ов высокая,
   * отчёты обычно никто не читает в реальном времени).
   *
   * Фоллбек: если REPORT_* не заданы, используется alerts.chatId. Это значит,
   * однопотоковые установки (только ALERT_CHAT_ID) продолжают работать без правок.
   *
   * REPORT_CHAT_ID — отдельный канал для отчётов; default — alerts.chatId.
   * REPORT_THREAD_ID — message_thread_id для отчётов; default — legacy
   *   USAGE_THREAD_ID (если был задан), иначе undefined.
   */
  reports: {
    chatId: opt("REPORT_CHAT_ID") ?? opt("ALERT_CHAT_ID"),
    threadId: optInt("REPORT_THREAD_ID", 0) || optInt("USAGE_THREAD_ID", 0) || undefined,
  },

  /**
   * Fallback-уведомления (optional) — алерты о переключении image/video
   * генерации с primary на fallback-провайдера (через notifyFallback).
   * Отделены от alerts, чтобы on-call мог направить шумные fallback'и
   * в отдельный канал/тему — критичные tech-ошибки и rate-limit'ы при этом
   * остаются в основном alerts-канале.
   *
   * Фоллбек: если FALLBACK_ALERT_* не заданы, используется alerts.chatId.
   * Установки с одним только ALERT_CHAT_ID работают как раньше.
   *
   * FALLBACK_ALERT_CHAT_ID — отдельный канал для fallback-алертов; default — alerts.chatId.
   * FALLBACK_ALERT_THREAD_ID — message_thread_id; default — alerts.threadId.
   */
  fallbackAlerts: {
    chatId: opt("FALLBACK_ALERT_CHAT_ID") ?? opt("ALERT_CHAT_ID"),
    threadId: optInt("FALLBACK_ALERT_THREAD_ID", 0) || optInt("ALERT_THREAD_ID", 0) || undefined,
  },

  /**
   * Metabox site integration (optional — only needed for ecosystem linking).
   * METABOX_API_URL      — base URL of Metabox Next.js app, e.g. https://app.meta-box.ru
   * METABOX_INTERNAL_KEY — shared secret for X-Internal-Key header
   * METABOX_SSO_SECRET   — HMAC secret for signing/verifying SSO tokens (same on both apps)
   */
  metabox: {
    apiUrl: opt("METABOX_API_URL"),
    landingUrl: optDefault("METABOX_LANDING_URL", "https://meta-box.ru"),
    internalKey: opt("METABOX_INTERNAL_KEY"),
    ssoSecret: opt("METABOX_SSO_SECRET"),
  },

  /**
   * Web-версия AI Box (packages/web → ai.metabox.global).
   * JWT_SECRET — секрет для подписи web access-токенов (HMAC-SHA256).
   * Cookie параметры — домен и безопасность refresh-cookie.
   */
  web: {
    jwtSecret: opt("WEB_JWT_SECRET"),
    accessTtlSeconds: optInt("WEB_ACCESS_TTL_SEC", 15 * 60), // 15 минут
    refreshTtlSeconds: optInt("WEB_REFRESH_TTL_SEC", 30 * 24 * 60 * 60), // 30 дней
    /** Домен refresh-cookie (например, ".metabox.global" чтобы работало на поддоменах). */
    cookieDomain: opt("WEB_COOKIE_DOMAIN"),
    /** Secure cookie (true на https; в dev можно false). По умолчанию — true если NODE_ENV=production. */
    cookieSecure: optDefault("WEB_COOKIE_SECURE", "") as "" | "true" | "false",
    /** Базовый URL веб-фронта (для ссылок в email-ах восстановления пароля). */
    frontUrl: opt("WEB_FRONT_URL"),
  },

  /** Support Telegram username (without @) */
  supportTg: optDefault("SUPPORT_TG_USERNAME", "metaboxsupport"),

  /** AI providers (all optional — only needed for models you enable) */
  ai: {
    openai: opt("OPENAI_API_KEY"),
    openaiAssistantId: opt("OPENAI_ASSISTANT_ID"),
    anthropic: opt("ANTHROPIC_API_KEY"),
    google: opt("GOOGLE_AI_API_KEY"),
    qwen: opt("QWEN_API_KEY"),
    grok: opt("GROK_API_KEY"),
    deepseek: opt("DEEPSEEK_API_KEY"),
    perplexity: opt("PERPLEXITY_API_KEY"),
    fal: opt("FAL_API_KEY"),
    replicate: opt("REPLICATE_API_KEY") ?? opt("REPLICATE_API_TOKEN"),
    runway: opt("RUNWAY_API_KEY"),
    luma: opt("LUMA_API_KEY"),
    elevenlabs: opt("ELEVENLABS_API_KEY"),
    cartesia: opt("CARTESIA_API_KEY"),
    heygen: opt("HEYGEN_API_KEY"),
    heygenAvatarId: opt("HEYGEN_AVATAR_ID"),
    did: opt("DID_API_KEY"),
    didPresenterUrl: opt("DID_PRESENTER_URL"),
    higgsfieldApiKey: opt("HIGGSFIELD_API_KEY"),
    higgsfieldApiSecret: opt("HIGGSFIELD_API_SECRET"),
    alibaba: opt("ALIBABA_API_KEY"),
    apipass: opt("APIPASS_API_KEY"),
    recraft: opt("RECRAFT_API_KEY"),
    minimax: opt("MINIMAX_API_KEY"),
    kie: opt("KIE_API_KEY"),
    evolink: opt("EVOLINK_API_KEY"),
  },
} as const;

export type Config = typeof config;
