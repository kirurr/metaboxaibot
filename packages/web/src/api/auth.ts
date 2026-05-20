import { apiClient } from "./client";
import type { AuthSession, WebUser } from "./types";

/**
 * Auth-endpoints. Реальные URL живут в `packages/api` и проксируют валидацию
 * пароля / регистрацию / reset в MetaBox internal API.
 */

export interface LoginBody {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface SignupBody {
  email: string;
  password: string;
  firstName: string;
  referralCode?: string;
}

export function login(body: LoginBody) {
  return apiClient<AuthSession, LoginBody>("/auth/web-login", {
    method: "POST",
    body,
    skipAuth: true,
  });
}

/** В prod-режиме метабокс отправляет письмо подтверждения и НЕ выдаёт сессию,
 *  поэтому signup может вернуть `{ requiresVerification, email }` вместо
 *  `AuthSession`. */
export type SignupResponse =
  | AuthSession
  | { requiresVerification: true; email: string; firstName: string | null };

export function signup(body: SignupBody) {
  return apiClient<SignupResponse, SignupBody>("/auth/web-signup", {
    method: "POST",
    body,
    skipAuth: true,
  });
}

export function resendVerification(email: string) {
  return apiClient<{ ok: true }, { email: string }>("/auth/web-resend-verification", {
    method: "POST",
    body: { email },
    skipAuth: true,
  });
}

// Telegram link via deep-link flow ─────────────────────────────────────────
//
// `/auth/web-link-telegram/init`  — генерирует state в Redis, возвращает
//   deep-link `t.me/<bot>?start=linkweb_<state>`.
// `/auth/web-link-telegram/status` — фронт polls пока bot не закроет state.

export function linkTelegramInit() {
  return apiClient<{ deepLinkUrl: string; state: string }>("/auth/web-link-telegram/init", {
    method: "POST",
  });
}

export function linkTelegramStatus(state: string) {
  return apiClient<{ linked: boolean; telegramUsername: string | null }>(
    "/auth/web-link-telegram/status",
    { method: "POST", body: { state } },
  );
}

export function logout() {
  return apiClient("/auth/web-logout", { method: "POST" });
}

export function refresh() {
  return apiClient<{ accessToken: string; accessTokenExpiresAt: number; csrfToken: string }>(
    "/auth/web-refresh",
    { method: "POST", skipAuth: true, skipAuthRefresh: true },
  );
}

export function me() {
  return apiClient<{ user: WebUser; csrfToken: string }>("/auth/web-me");
}

/**
 * Обновляет `user.language` в БД. Воркеры читают это поле для формирования
 * user-facing сообщений (включая ошибки генераций), поэтому смену UI-языка в
 * Settings нужно прокинуть на бэк — иначе ошибки придут в старом языке.
 *
 * Web-only юзеры без линкованного Telegram получают 204 (нет User-row, менять
 * нечего). UI на ошибке не валим — language всё равно сохранён локально.
 */
export function updatePreferences(body: { language?: string }) {
  return apiClient<{ ok: true; language?: string }, { language?: string }>("/auth/web-me", {
    method: "PATCH",
    body,
  });
}

export interface TransactionDto {
  id: string;
  amount: string;
  type: "credit" | "debit" | string;
  reason: string;
  description: string | null;
  modelId: string | null;
  createdAt: string;
}

export function getTransactions() {
  return apiClient<{ transactions: TransactionDto[] }>("/auth/web-transactions");
}

export function forgotPassword(email: string) {
  return apiClient<{ ok: true }, { email: string }>("/auth/web-forgot-password", {
    method: "POST",
    body: { email },
    skipAuth: true,
  });
}

export function resetPassword(token: string, newPassword: string) {
  return apiClient<{ ok: true }, { token: string; newPassword: string }>(
    "/auth/web-reset-password",
    {
      method: "POST",
      body: { token, newPassword },
      skipAuth: true,
    },
  );
}

export function changePassword(oldPassword: string, newPassword: string) {
  return apiClient<{ ok: true }, { oldPassword: string; newPassword: string }>(
    "/auth/web-change-password",
    { method: "POST", body: { oldPassword, newPassword } },
  );
}
