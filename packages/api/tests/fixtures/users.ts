/**
 * Test user fixtures. Creates real User rows via Prisma and mints real
 * JWT/refresh tokens via the production session service — so the auth
 * middleware accepts them exactly as it would in prod.
 */

import { randomUUID } from "node:crypto";
import type { Role } from "@prisma/client";
import { db } from "../helpers/db.js";
import {
  createRefreshSession,
  sessionIdFromRefresh,
  signAccessToken,
} from "../../src/services/web-session.service.js";

let _nextTelegramId = 900_000_000n;
function nextTelegramId(): bigint {
  return _nextTelegramId++;
}

export interface CreateTestUserOptions {
  role?: Role;
  isBlocked?: boolean;
  /**
   * `true` (default) — full user: AI Box User row exists in DB with telegramId
   * set; JWT carries both `sub` (metaboxUserId) and `aib` (aibUserId).
   * `false` — web-only stub: NO User row is inserted; JWT carries only `sub`.
   * This matches the prod state "registered on web but Telegram not linked yet"
   * (aibUserId === null in the session), which `webTelegramLinkedPreHandler`
   * rejects with 403 TELEGRAM_NOT_LINKED.
   */
  withTelegram?: boolean;
  email?: string;
  firstName?: string;
}

export interface TestUser {
  user: {
    /** null when withTelegram=false (no DB row was created). */
    id: bigint | null;
    telegramId: bigint | null;
    metaboxUserId: string;
    role: Role | null;
    firstName: string | null;
    email: string;
  };
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  csrfToken: string;
}

/**
 * Insert a User row (if `withTelegram`) and return a fresh access/refresh
 * pair signed with the test WEB_JWT_SECRET. Mirrors what `/auth/web-login`
 * would produce after a successful Metabox call — but skips Metabox entirely.
 */
export async function createTestUser(opts: CreateTestUserOptions = {}): Promise<TestUser> {
  const {
    role = "USER",
    isBlocked = false,
    withTelegram = true,
    firstName = "Test",
  } = opts;

  const metaboxUserId = randomUUID();
  const email = opts.email ?? `test-${metaboxUserId}@local.test`;

  let dbUserId: bigint | null = null;
  let dbTelegramId: bigint | null = null;
  let dbRole: Role | null = null;
  if (withTelegram) {
    const row = await db.user.create({
      data: {
        telegramId: nextTelegramId(),
        metaboxUserId,
        firstName,
        role,
        isBlocked,
      },
    });
    dbUserId = row.id;
    dbTelegramId = row.telegramId;
    dbRole = row.role;
  }

  const { refreshToken, csrfToken } = await createRefreshSession({
    metaboxUserId,
    aibUserId: dbUserId !== null ? dbUserId.toString() : null,
    email,
    firstName,
    rememberMe: true,
    userAgent: "vitest",
    ip: "127.0.0.1",
  });

  const { token: accessToken, expiresAt: accessTokenExpiresAt } = signAccessToken({
    sub: metaboxUserId,
    ...(dbUserId !== null ? { aib: dbUserId.toString() } : {}),
    sid: sessionIdFromRefresh(refreshToken),
  });

  return {
    user: {
      id: dbUserId,
      telegramId: dbTelegramId,
      metaboxUserId,
      role: dbRole,
      firstName,
      email,
    },
    accessToken,
    accessTokenExpiresAt,
    refreshToken,
    csrfToken,
  };
}

/** Convenience: build an Authorization Bearer header for fastify.inject. */
export function bearer(accessToken: string): { Authorization: string } {
  return { Authorization: `Bearer ${accessToken}` };
}
