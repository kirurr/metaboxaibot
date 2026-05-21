/**
 * Telegram initData fixture. Produces a HMAC-valid `initData` string that
 * `verifyTelegramInitData` (telegram-auth.ts) will accept under the test
 * BOT_TOKEN. Use as the `tma ` part of the Authorization header.
 */

import { createHmac } from "node:crypto";
import { config } from "@metabox/shared";

export interface TelegramInitDataOptions {
  telegramId: bigint | number;
  firstName?: string;
  lastName?: string;
  username?: string;
  authDate?: number;
}

/**
 * Build a Telegram Mini App `initData` URL-encoded string and sign it with
 * HMAC-SHA256(secretKey, dataCheckString) where secretKey =
 * HMAC-SHA256("WebAppData", BOT_TOKEN). Matches the verification logic in
 * `packages/api/src/middlewares/telegram-auth.ts:verifyTelegramInitData`.
 */
export function signTelegramInitData(opts: TelegramInitDataOptions): string {
  const authDate = opts.authDate ?? Math.floor(Date.now() / 1000);
  const userJson = JSON.stringify({
    id: Number(opts.telegramId),
    first_name: opts.firstName ?? "Test",
    last_name: opts.lastName,
    username: opts.username,
  });

  const params = new URLSearchParams();
  params.set("auth_date", String(authDate));
  params.set("user", userJson);

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(config.bot.token).digest();
  const hash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  params.set("hash", hash);
  return params.toString();
}

/** Convenience: build an Authorization "tma <initData>" header. */
export function tmaAuth(opts: TelegramInitDataOptions): { Authorization: string } {
  return { Authorization: `tma ${signTelegramInitData(opts)}` };
}
