/**
 * MetaboxBridgeService — HTTP client for calling Metabox internal API.
 *
 * All calls require METABOX_API_URL + METABOX_INTERNAL_KEY env vars.
 * If they are not set, methods throw with a descriptive error.
 */
import { config } from "@metabox/shared";
import { createHmac } from "crypto";

// ── SSO token helpers (HMAC-SHA256, no extra deps) ────────────────────────────

const SSO_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

export function issueSsoToken(metaboxUserId: string): string {
  const secret = config.metabox.ssoSecret;
  if (!secret) throw new Error("METABOX_SSO_SECRET is not set");

  const payload = JSON.stringify({ sub: metaboxUserId, exp: Date.now() + SSO_EXPIRY_MS });
  const b64 = Buffer.from(payload).toString("base64url");
  const sig = createHmac("sha256", secret).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

export function verifySsoToken(token: string): string {
  const secret = config.metabox.ssoSecret;
  if (!secret) throw new Error("METABOX_SSO_SECRET is not set");

  const [b64, sig] = token.split(".");
  if (!b64 || !sig) throw new Error("Invalid SSO token format");

  const expected = createHmac("sha256", secret).update(b64).digest("base64url");
  if (sig !== expected) throw new Error("Invalid SSO token signature");

  const payload = JSON.parse(Buffer.from(b64, "base64url").toString()) as {
    sub: string;
    exp: number;
  };
  if (Date.now() > payload.exp) throw new Error("SSO token expired");
  return payload.sub;
}

// ── HTTP client ───────────────────────────────────────────────────────────────

function base() {
  const url = config.metabox.apiUrl;
  const key = config.metabox.internalKey;
  if (!url || !key) throw new Error("METABOX_API_URL / METABOX_INTERNAL_KEY not set");
  return { url, key };
}

export class MetaboxApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    path: string,
    public readonly code?: string,
    public readonly data?: Record<string, unknown>,
  ) {
    super(`Metabox internal API ${path} → ${status}: ${body}`);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const { url, key } = base();
  const res = await fetch(`${url}/api/internal${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": key,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text;
    let code: string | undefined;
    let data: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.error) message = String(parsed.error);
      if (parsed.code) code = String(parsed.code);
      data = parsed;
    } catch {
      // keep raw text
    }
    throw new MetaboxApiError(res.status, message, path, code, data);
  }
  return res.json() as Promise<T>;
}

async function get<T>(path: string): Promise<T> {
  const { url, key } = base();
  const res = await fetch(`${url}/api${path}`, {
    headers: { "X-Internal-Key": key },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Metabox API GET ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── API methods ───────────────────────────────────────────────────────────────

export interface MergedAccountInfo {
  userId: string;
  tokensBalance: number;
  subscriptionDays: number;
}

export interface RegisterFromBotResult {
  metaboxUserId: string;
  /** Только если аккаунт уже верифицирован [STAGE_MODE]. В обычном
   * режиме email требует подтверждения, токена не будет. */
  ssoToken?: string;
  referralCode: string;
  mergedFrom?: MergedAccountInfo;
  /** Если true — пользователю отправлено письмо с подтверждением,
   * SSO-логин не выдан. Юзер должен подтвердить email и войти вручную. */
  requiresVerification?: boolean;
  email?: string;
}

/** Register a new Metabox user from the bot (email + password). */
export async function registerFromBot(params: {
  email: string;
  password: string;
  telegramId: bigint;
  firstName?: string;
  lastName?: string;
  username?: string;
  referrerTelegramId?: bigint;
}): Promise<RegisterFromBotResult> {
  return post<RegisterFromBotResult>("/register-from-bot", {
    ...params,
    telegramId: params.telegramId.toString(),
    referrerTelegramId: params.referrerTelegramId?.toString(),
  });
}

/** Получить статус metabox-юзера: email + emailVerified.
 *  Используется ботом чтобы решить — звать SSO или показать
 *  «Подтвердите почту» pending-экран.
 *
 *  ВАЖНО: helper get() добавляет префикс /api, а нам нужен /api/internal —
 *  поэтому путь начинаем с /internal. */
export async function getMetaboxUserStatus(
  metaboxUserId: string,
): Promise<{ email: string; emailVerified: boolean; name: string }> {
  return get(`/internal/user-status?metaboxUserId=${encodeURIComponent(metaboxUserId)}`);
}

/** Перевыпустить verification email — старый не дошёл, юзер потерял или
 *  токен истёк. */
export async function resendMetaboxVerification(
  metaboxUserId: string,
): Promise<{ ok: boolean; email: string; alreadyVerified?: boolean }> {
  return post("/resend-verification", { metaboxUserId });
}

/** Сменить email на pending-аккаунте [юзер с ошибкой ввёл изначально]
 *  и заново отправить письмо. Доступно только пока emailVerified=false. */
export async function changeMetaboxEmailPending(
  metaboxUserId: string,
  newEmail: string,
): Promise<{ ok: boolean; email: string; warning?: string }> {
  return post("/change-email-pending", { metaboxUserId, newEmail });
}

/** Login existing Metabox user and link their Telegram account. */
export async function loginAndLink(params: {
  email: string;
  password: string;
  telegramId: bigint;
  telegramUsername: string | null;
  firstName?: string;
  lastName?: string;
  referrerTelegramId?: bigint | null;
  botHasPurchase: boolean;
  botCreatedAt: Date;
}): Promise<RegisterFromBotResult> {
  return post<RegisterFromBotResult>("/login-and-link", {
    email: params.email,
    password: params.password,
    telegramId: params.telegramId.toString(),
    telegramUsername: params.telegramUsername,
    firstName: params.firstName,
    lastName: params.lastName,
    referrerTelegramId: params.referrerTelegramId?.toString(),
    botHasPurchase: params.botHasPurchase,
    botCreatedAt: params.botCreatedAt.toISOString(),
  });
}

/** Verify a TelegramAuthToken created by Metabox (for Metabox→Bot deep link flow).
 *  Also tells Metabox to link telegramId to the user account. */
export async function verifyLinkToken(
  token: string,
  telegramId: bigint,
  botInfo?: {
    telegramUsername?: string;
    firstName?: string;
    lastName?: string;
    referrerTelegramId?: bigint | null;
    botHasPurchase: boolean;
    botCreatedAt: Date;
  },
): Promise<{
  metaboxUserId: string;
  email: string;
  firstName: string;
  referralCode: string;
  mergedFrom?: MergedAccountInfo;
}> {
  return post("/verify-link-token", {
    token,
    telegramId: telegramId.toString(),
    telegramUsername: botInfo?.telegramUsername,
    firstName: botInfo?.firstName,
    lastName: botInfo?.lastName,
    referrerTelegramId: botInfo?.referrerTelegramId?.toString(),
    botHasPurchase: botInfo?.botHasPurchase,
    botCreatedAt: botInfo?.botCreatedAt.toISOString(),
  });
}

/** Confirm merge after mentor conflict resolution. */
export async function confirmMerge(params: {
  token: string;
  telegramId: bigint;
  chosenMentor: "site" | "bot";
}): Promise<{
  metaboxUserId: string;
  email: string;
  firstName: string;
  referralCode: string;
  mergedFrom?: MergedAccountInfo;
}> {
  return post("/confirm-merge", {
    token: params.token,
    telegramId: params.telegramId.toString(),
    chosenMentor: params.chosenMentor,
  });
}

/** Issue a fresh SSO token for an already-linked user. */
export async function issueSsoTokenRemote(metaboxUserId: string): Promise<{ ssoToken: string }> {
  return post("/issue-sso-token", { metaboxUserId });
}

export interface RecordSaleResult {
  ok: boolean;
  userId?: string;
  orderId?: string;
}

/**
 * Перенос остатков (токены + опционально локальная подписка) на metabox-аккаунт
 * перед удалением юзера в боте. Эндпоинт `/credit-from-bot-deletion` пока
 * НЕ реализован на стороне metabox — функция спокойно бросит `MetaboxApiError(404)`,
 * caller это ловит и помечает запись `pendingMetaboxTransfer=true` в `DeletedUser`.
 * После выкатки эндпоинта на сайте поведение сразу станет happy-path без
 * изменений в коде бота.
 *
 * `subscription` передаётся ТОЛЬКО если у юзера была локальная подписка с
 * `metaboxSubscriptionId === null` (не пришла из metabox — например Trial). Если
 * подписка изначально с metabox — она там уже есть, переносить не нужно.
 */
export async function transferOnDeletion(params: {
  metaboxUserId: string;
  telegramId: bigint;
  tokens: number;
  subscription?: {
    planName: string;
    period: string;
    tokensGranted: number;
    endDate: string;
    startDate: string;
  };
}): Promise<{ ok: true }> {
  return post<{ ok: true }>("/credit-from-bot-deletion", {
    ...params,
    telegramId: params.telegramId.toString(),
  });
}

/** Notify Metabox of a purchase made inside the bot (for MLM bonus calculation + order tracking). */
export async function recordSale(params: {
  telegramId: bigint;
  firstName: string;
  lastName?: string;
  username?: string;
  productType: "product" | "subscription";
  productId: string;
  period?: "M1" | "M3" | "M6" | "M12";
  tokens: number;
  priceRub: number;
  stars: number;
  starRate: number;
  referrerTelegramId?: bigint;
}): Promise<RecordSaleResult> {
  return post<RecordSaleResult>("/record-sale", {
    ...params,
    telegramId: params.telegramId.toString(),
    referrerTelegramId: params.referrerTelegramId?.toString(),
  });
}

// ── AI token product catalog ─────────────────────────────────────────────────

export interface AiBotProduct {
  id: string;
  name: string;
  tokens: number;
  priceRub: string; // Decimal as string
}

/** Fetch the list of active AI token packages from Metabox. */
export async function getAiBotProducts(): Promise<AiBotProduct[]> {
  return get<AiBotProduct[]>("/aibot/products");
}

/**
 * Look up a Metabox user by Telegram ID.
 * Returns null if no account is linked to that Telegram ID on the Metabox side.
 */
export async function lookupByTelegramId(
  telegramId: bigint,
): Promise<{ metaboxUserId: string; referralCode: string } | null> {
  try {
    return await post<{ metaboxUserId: string; referralCode: string }>("/lookup-telegram", {
      telegramId: telegramId.toString(),
    });
  } catch (err) {
    if (err instanceof MetaboxApiError && err.status === 404) return null;
    throw err;
  }
}

// ── Unified catalog (subscriptions + token packages) ────────────────────────

export interface CatalogSubscription {
  id: string;
  name: string;
  tokens: number;
  priceMonthly: string;
  discount3m: string;
  discount6m: string;
  discount12m: string;
}

export interface CatalogProduct {
  id: string;
  name: string;
  tokens: number;
  priceRub: string;
  badge: string | null;
}

export interface AiBotCatalog {
  subscriptions: CatalogSubscription[];
  tokenPackages: CatalogProduct[];
}

/** Fetch unified catalog of subscriptions + token packages from Metabox. */
export async function getAiBotCatalog(): Promise<AiBotCatalog> {
  return get<AiBotCatalog>("/aibot/catalog");
}

/** Fetch PAID token-pack orders that haven't been granted to the bot yet. */
export async function getPendingTokenGrants(
  telegramId: bigint,
): Promise<Array<{ orderId: string; tokens: number; description: string }>> {
  const data = await get<{
    orders: Array<{ orderId: string; tokens: number; description: string }>;
  }>(`/internal/pending-token-grants?telegramId=${telegramId.toString()}`);
  return data.orders ?? [];
}

/** Mark a token-pack order as granted in the bot (sets tokensGrantedToBot = true on Metabox). */
export async function markOrderGrantedOnMetabox(orderId: string): Promise<void> {
  try {
    await post("/mark-order-granted", { orderId });
  } catch {
    // Non-fatal
  }
}

/**
 * Notify Metabox that tokens for a given subscription have been granted in the bot.
 * Sets AiBoxSubscription.tokensGrantedToBot = true on the Metabox side.
 * Silently ignores errors — the bot's LocalSubscription is the authoritative source.
 */
export async function markTokensGrantedOnMetabox(subscriptionId: string): Promise<void> {
  try {
    await post("/mark-tokens-granted", { subscriptionId });
  } catch {
    // Non-fatal: bot-side idempotency via LocalSubscription.metaboxSubscriptionId is sufficient
  }
}

/** Fetch subscription status for a user from Metabox. */
export async function getSubscriptionStatus(telegramId: bigint): Promise<{
  subscription: {
    subscriptionId: string;
    planName: string;
    period: string;
    daysLeft: number;
    totalDays: number;
    endDate: string;
    tokensGranted: number;
    tokensGrantedToBot: boolean;
  } | null;
}> {
  return get(`/internal/subscription-status?telegramId=${telegramId.toString()}`);
}

// ── Web (ai.metabox.global) методы ──────────────────────────────────────────
/**
 * Все endpoints ниже — новые "мосты" на стороне meta-box под
 * ai.metabox.global. Существующие (register-from-bot, login-and-link,
 * validate-credentials, record-sale и др.) — не затронуты.
 */

export interface WebValidateResult {
  metaboxUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  /** true если на стороне meta-box у юзера есть telegramId (может быть привязан через сайт ранее). */
  hasTelegramOnSite: boolean;
}

/** Валидация email + пароля для входа на ai.metabox.global. */
export async function webValidateCredentials(params: {
  email: string;
  password: string;
}): Promise<WebValidateResult> {
  return post<WebValidateResult>("/web-validate-credentials", params);
}

export interface WebRegisterResult {
  metaboxUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  referralCode: string;
}

/** Регистрация нового юзера с ai.metabox.global. Создаёт MetaBox User. */
export async function webRegister(params: {
  email: string;
  password: string;
  firstName: string;
  lastName?: string;
  referralCode?: string;
}): Promise<WebRegisterResult> {
  return post<WebRegisterResult>("/web-register", params);
}

/** Запрос на восстановление пароля — meta-box создаёт PasswordResetToken и шлёт email. */
export async function webRequestPasswordReset(params: {
  email: string;
  resetUrlBase: string; // например, https://stage.ai.metabox.global/reset-password?token=
}): Promise<{ ok: true }> {
  return post<{ ok: true }>("/web-password-reset-request", params);
}

/** Подтверждение сброса пароля по токену. */
export async function webConfirmPasswordReset(params: {
  token: string;
  newPassword: string;
}): Promise<{ ok: true }> {
  return post<{ ok: true }>("/web-password-reset-confirm", params);
}

/** Смена пароля авторизованным юзером (знает старый). */
export async function webChangePassword(params: {
  metaboxUserId: string;
  oldPassword: string;
  newPassword: string;
}): Promise<{ ok: true }> {
  return post<{ ok: true }>("/web-change-password", params);
}

/** Профиль юзера из meta-box (для /auth/web-me). */
export async function webGetProfile(params: { metaboxUserId: string }): Promise<{
  metaboxUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  telegramId: string | null;
  telegramUsername: string | null;
  referralCode: string | null;
}> {
  return post("/web-get-profile", params);
}

/** Get partner balance and referral count from Metabox. */
export async function getPartnerBalance(telegramId: bigint): Promise<{
  balance: number;
  totalEarned: number;
  totalWithdrawn: number;
  userStatus: string;
  referralCode: string | null;
  referralCount: number;
}> {
  return get(`/internal/partner-balance?telegramId=${telegramId.toString()}`);
}

/** Create a subscription invoice on Metabox for a linked user. */
export async function createSubscriptionInvoice(params: {
  metaboxUserId: string;
  planId: string;
  period: string;
  telegramId: bigint;
}): Promise<{ paymentUrl: string; subscriptionId: string }> {
  return post<{ paymentUrl: string; subscriptionId: string }>("/subscription-invoice", {
    ...params,
    telegramId: params.telegramId.toString(),
  });
}

/** Ask Metabox to create an AiBotOrder + Lava invoice for a linked user. */
export async function createAiBotInvoice(params: {
  metaboxUserId: string;
  productId: string;
  telegramId: bigint;
}): Promise<{ paymentUrl: string; orderId: string }> {
  return post<{ paymentUrl: string; orderId: string }>("/aibot-invoice", {
    ...params,
    telegramId: params.telegramId.toString(),
  });
}

/** Resolve a Metabox referralCode to a telegramId for bot referral linking. */
export async function resolveReferralCode(
  code: string,
): Promise<{ userId: string; telegramId: string | null; name: string } | null> {
  try {
    return await get<{ userId: string; telegramId: string | null; name: string }>(
      `/internal/resolve-referral?code=${encodeURIComponent(code)}`,
    );
  } catch {
    return null;
  }
}

/**
 * Register a bot user on Metabox (creates stub account with tg_{id}@aibox.meta-box.ru).
 * Called on /start in the bot. If user already exists — returns existing data.
 */
export async function registerBotUser(params: {
  telegramId: bigint;
  firstName?: string;
  lastName?: string;
  username?: string;
  referrerTelegramId?: bigint | null;
  referrerUserId?: string;
}): Promise<{
  ok: boolean;
  userId: string;
  referralCode: string;
  isNew: boolean;
  isStub: boolean;
  mentor?: { name: string; telegramUsername: string | null } | null;
}> {
  return post("/register-bot-user", {
    telegramId: params.telegramId.toString(),
    firstName: params.firstName,
    lastName: params.lastName,
    username: params.username,
    referrerTelegramId: params.referrerTelegramId?.toString(),
    referrerUserId: params.referrerUserId,
  });
}
