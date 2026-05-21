/**
 * HMAC-signed download tokens for secure S3 file access.
 *
 * Token format: `<base64url-payload>.<hmac-hex>`
 * Payload JSON: { k: s3Key, u: userId, e: expUnixSec }
 *
 * The route /download/:token validates the token, generates a fresh
 * presigned S3 URL, and redirects the user there (302).
 *
 * Secret: METABOX_SSO_SECRET (falls back to BOT_TOKEN so it always works).
 */

import { createHmac } from "node:crypto";
import { config } from "@metabox/shared";

/** Telegram inline-button shape we need locally — keeps this util free of grammy types. */
export type DownloadInlineButton =
  | { text: string; url: string }
  | { text: string; web_app: { url: string } };

const TOKEN_TTL_SEC = 86_400; // 24 hours

interface TokenPayload {
  k: string; // s3Key
  u: string; // userId
  e: number; // expiry unix seconds
}

function getSecret(): string {
  return config.metabox.ssoSecret ?? config.bot.token;
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

function sign(rawPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(rawPayload).digest("hex");
}

export function generateDownloadToken(s3Key: string, userId: bigint | string): string {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const payload: TokenPayload = { k: s3Key, u: String(userId), e: exp };
  const rawPayload = b64urlEncode(JSON.stringify(payload));
  const hmac = sign(rawPayload, getSecret());
  return `${rawPayload}.${hmac}`;
}

export function verifyDownloadToken(token: string): TokenPayload {
  const dotIdx = token.lastIndexOf(".");
  if (dotIdx === -1) throw new Error("Invalid download token format");

  const rawPayload = token.slice(0, dotIdx);
  const hmac = token.slice(dotIdx + 1);

  const expected = sign(rawPayload, getSecret());
  if (expected !== hmac) throw new Error("Invalid download token signature");

  let payload: TokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(rawPayload)) as TokenPayload;
  } catch {
    throw new Error("Invalid download token payload");
  }

  if (!payload.k || !payload.u || !payload.e) throw new Error("Malformed download token payload");
  if (Math.floor(Date.now() / 1000) > payload.e) throw new Error("Download token expired");

  return payload;
}

/**
 * Builds the inline button used to deliver an S3 file to a user from a
 * Telegram message. Prefers `web_app:` (opens our mini-app bridge page,
 * which calls Telegram.WebApp.openLink to fire the system browser — the
 * only way to trigger a real download from Telegram's WebView). Falls
 * back to plain `url:` when WEBAPP_URL isn't configured (e.g. dev) so
 * the button still works, just without the WebView workaround.
 */
export function buildDownloadButton(
  text: string,
  s3Key: string,
  userId: bigint | string,
): DownloadInlineButton {
  const token = generateDownloadToken(s3Key, userId);
  if (config.bot.webappUrl) {
    return { text, web_app: { url: `${config.bot.webappUrl}?page=download&token=${token}` } };
  }
  if (config.api.publicUrl) {
    return { text, url: `${config.api.publicUrl}/download/${token}` };
  }
  // Should never happen in production; both are configured. Keeps the
  // return type honest so callers don't have to handle `null`.
  return { text, url: `/download/${token}` };
}

/**
 * Прямая HTTP-ссылка на скачивание (`/download/<token>/<имя>` → 302 на signed
 * S3 URL). В отличие от `buildDownloadButton`, всегда возвращает обычный `url`
 * (без `web_app`).
 *
 * Имя файла в хвосте — чтобы URL оканчивался реальным расширением и браузер
 * сохранил файл с осмысленным именем.
 *
 * ТОЛЬКО для ссылок, которые открывает браузер / Telegram. НЕ передавать
 * провайдерам (KIE, Fal Topaz и т.п.) как URL ассета: их серверные downloader'ы
 * не следуют 302-редиректу этого роута — провайдеру нужен presigned-S3 URL
 * напрямую.
 *
 * `null` только если `API_PUBLIC_URL` не задан (в проде он есть).
 */
export function buildDownloadUrl(s3Key: string, userId: bigint | string): string | null {
  if (!config.api.publicUrl) return null;
  const token = generateDownloadToken(s3Key, userId);
  const name = s3Key.split("/").pop() || "file";
  return `${config.api.publicUrl}/download/${token}/${name}`;
}
