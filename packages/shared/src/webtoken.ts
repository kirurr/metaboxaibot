/**
 * Short-lived URL token for Telegram Mini App authentication.
 *
 * Used when initData is unavailable (e.g. KeyboardButtonWebApp / requestSimpleWebView
 * which by Telegram design never injects tgWebAppData).
 *
 * Token format (v2): `<userId>_<iat>_<ts>_<hmacHex>`
 *  - `iat` — original issuance timestamp, **immutable across refreshes**.
 *  - `ts` — last refresh timestamp; bumped to `now` whenever the API issues
 *    a fresh wtoken via rolling refresh.
 *  - HMAC-SHA256 over `<userId>:<iat>:<ts>` keyed with the bot token.
 *
 * Legacy format (v1): `<userId>_<ts>_<hmacHex>` (no separate `iat`). Accepted
 * for back-compat; treated as `iat = ts` so a legacy token cannot dodge the
 * absolute cap by being refreshed.
 *
 * Rolling refresh + absolute cap:
 *  - Soft TTL = 30 days (since last refresh). Past it → `EXPIRED`.
 *  - Absolute TTL = 90 days (since `iat`). Past it → `EXPIRED`, refresh CANNOT
 *    revive it. Caps the lifetime of any stolen token chain — a thief who
 *    keeps a token alive via /profile-pings forever can do so for at most 90d.
 *  - `needsRefresh = age_from_ts >= TTL/2` (15d). Caller issues a fresh token
 *    via `generateWebToken(userId, botToken, originalIat)` — `iat` is carried
 *    forward unchanged, only `ts` advances.
 *  - Global kill switch: ротация bot token в @BotFather инвалидирует
 *    всю HMAC-вселенную моментально.
 */

import { createHmac } from "node:crypto";

const TOKEN_TTL_SEC = 30 * 24 * 60 * 60;
const TOKEN_ABS_TTL_SEC = 90 * 24 * 60 * 60;
const REFRESH_THRESHOLD_SEC = Math.floor(TOKEN_TTL_SEC / 2);
const SEP = "_";

export type WebTokenErrorCode = "EXPIRED" | "INVALID_FORMAT" | "INVALID_SIGNATURE";

export class WebTokenError extends Error {
  constructor(
    message: string,
    public readonly code: WebTokenErrorCode,
  ) {
    super(message);
    this.name = "WebTokenError";
  }
}

export interface VerifyWebTokenResult {
  userId: bigint;
  /** Original issuance timestamp (sec). Caller must pass this to `generateWebToken` on refresh. */
  iat: number;
  /** True when token is past half-life — caller should issue a fresh token (with the same `iat`). */
  needsRefresh: boolean;
}

function sign(payload: string, botToken: string): string {
  return createHmac("sha256", botToken).update(payload).digest("hex");
}

/**
 * Generate a wtoken. Pass `originalIat` when refreshing an existing chain to
 * preserve the absolute-TTL cap; omit for first-time issuance (bot keyboards,
 * /start refresh_menu, etc.) — then `iat = ts = now`.
 */
export function generateWebToken(userId: bigint, botToken: string, originalIat?: number): string {
  const ts = Math.floor(Date.now() / 1000);
  const iat = originalIat ?? ts;
  const payload = `${userId}:${iat}:${ts}`;
  const hmac = sign(payload, botToken);
  return `${userId}${SEP}${iat}${SEP}${ts}${SEP}${hmac}`;
}

export function verifyWebToken(token: string, botToken: string): VerifyWebTokenResult {
  const parts = token.split(SEP);

  let userIdStr: string;
  let iat: number;
  let ts: number;
  let hmac: string;
  let payload: string;

  // Строгая валидация цифр: `parseInt("500abc", 10)` вернёт 500 (молча),
  // а `BigInt("garbage")` бросит SyntaxError мимо WebTokenError-handler'а
  // и улетит как 500. Отсечь оба класса мусора на парсинг-слое — гигиена.
  const DIGITS = /^\d+$/;

  if (parts.length === 4) {
    // v2: userId_iat_ts_hmac
    const [u, iatStr, tsStr, h] = parts;
    if (!DIGITS.test(u) || !DIGITS.test(iatStr) || !DIGITS.test(tsStr)) {
      throw new WebTokenError("Invalid token format", "INVALID_FORMAT");
    }
    iat = parseInt(iatStr, 10);
    ts = parseInt(tsStr, 10);
    userIdStr = u;
    hmac = h;
    payload = `${userIdStr}:${iat}:${ts}`;
  } else if (parts.length === 3) {
    // v1 legacy: userId_ts_hmac. iat = ts → старый токен не сможет дотянуться
    // до нового absolute cap'а через серию refresh'ей.
    const [u, tsStr, h] = parts;
    if (!DIGITS.test(u) || !DIGITS.test(tsStr)) {
      throw new WebTokenError("Invalid token format", "INVALID_FORMAT");
    }
    ts = parseInt(tsStr, 10);
    iat = ts;
    userIdStr = u;
    hmac = h;
    payload = `${userIdStr}:${ts}`;
  } else {
    throw new WebTokenError("Invalid token format", "INVALID_FORMAT");
  }

  // Signature first — иначе протухший, но валидно подписанный токен и протухший
  // подделанный неотличимы в логах, и невозможно понять, нужен ли refresh.
  const expected = sign(payload, botToken);
  if (expected !== hmac) throw new WebTokenError("Invalid token signature", "INVALID_SIGNATURE");

  const now = Math.floor(Date.now() / 1000);
  // Absolute cap первым: токен с битым iat (вышел за 90д) мёртв даже если
  // ts свежий — это значит, кто-то нашёл способ переписать ts (что
  // невозможно без HMAC-ключа, но проверка дёшева и защищает от багов рефреша).
  if (now - iat > TOKEN_ABS_TTL_SEC) throw new WebTokenError("Token expired", "EXPIRED");
  if (now - ts > TOKEN_TTL_SEC) throw new WebTokenError("Token expired", "EXPIRED");

  return {
    userId: BigInt(userIdStr),
    iat,
    needsRefresh: now - ts >= REFRESH_THRESHOLD_SEC,
  };
}
