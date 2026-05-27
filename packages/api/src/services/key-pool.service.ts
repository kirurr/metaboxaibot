/**
 * KeyPool — выбор API-ключа из БД с прокси-привязкой и приоритетной балансировкой.
 *
 * Стратегия: ключи сгруппированы по `priority` (по убыванию). Внутри одной
 * priority-группы — round-robin через атомарный `INCR` в Redis. Если ключ
 * сейчас на throttle-cooldown (см. throttle.service `throttle:key:<id>`),
 * он пропускается; если все ключи группы throttled — переходим к группе
 * с меньшим приоритетом.
 *
 * Если в БД нет активных ключей провайдера — `PoolExhaustedError`. Env-fallback
 * убран намеренно: иначе деактивация единственного ключа в админке не
 * останавливала бы трафик (молча подхватывался env-ключ). БД — единственный
 * источник правды; для seed'а из env есть отдельный скрипт `seed-keys-from-env`.
 */

import { db } from "../db.js";
import { getRedis } from "../redis.js";
import { logger } from "../logger.js";
import { decryptSecret } from "@metabox/shared";
import { checkKeyThrottle, tripKeyThrottle } from "./throttle.service.js";
import { PoolExhaustedError } from "../utils/pool-exhausted-error.js";

export interface ProxyConfig {
  protocol: "http" | "https" | "socks5";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface AcquiredKey {
  /** id записи в provider_keys, или null если использован env-fallback. */
  keyId: string | null;
  apiKey: string;
  proxy: ProxyConfig | null;
}

const KEYS_CACHE_TTL_MS = 30_000;
const RR_PREFIX = "pool:rr:";
const KEYS_CACHE_PREFIX = "pool:keys:";

/** Локальный in-process кэш списка ключей по провайдеру. */
interface CachedEntry {
  keys: PoolKeyRecord[];
  expiresAt: number;
}
const localCache = new Map<string, CachedEntry>();

/** То что нам нужно из ProviderKey + расшифрованный proxy для использования. */
interface PoolKeyRecord {
  id: string;
  priority: number;
  keyCipher: string;
  proxy: {
    id: string;
    protocol: string;
    host: string;
    port: number;
    username: string | null;
    passwordCipher: string | null;
  } | null;
}

async function loadKeysForProvider(provider: string): Promise<PoolKeyRecord[]> {
  const now = Date.now();
  const cached = localCache.get(provider);
  if (cached && cached.expiresAt > now) return cached.keys;

  const rows = await db.providerKey.findMany({
    where: { provider, isActive: true },
    orderBy: [{ priority: "desc" }, { id: "asc" }],
    select: {
      id: true,
      priority: true,
      keyCipher: true,
      proxy: {
        select: {
          id: true,
          protocol: true,
          host: true,
          port: true,
          username: true,
          passwordCipher: true,
          isActive: true,
        },
      },
    },
  });

  const keys: PoolKeyRecord[] = rows.map((r) => ({
    id: r.id,
    priority: r.priority,
    keyCipher: r.keyCipher,
    proxy:
      r.proxy && r.proxy.isActive
        ? {
            id: r.proxy.id,
            protocol: r.proxy.protocol,
            host: r.proxy.host,
            port: r.proxy.port,
            username: r.proxy.username,
            passwordCipher: r.proxy.passwordCipher,
          }
        : null,
  }));

  localCache.set(provider, { keys, expiresAt: now + KEYS_CACHE_TTL_MS });
  return keys;
}

/** Сбросить кэш для провайдера — вызывается из admin CRUD после write-операций. */
export function invalidatePoolCache(provider?: string): void {
  if (provider) localCache.delete(provider);
  else localCache.clear();
}

function decodeProxy(rec: PoolKeyRecord["proxy"]): ProxyConfig | null {
  if (!rec) return null;
  if (rec.protocol !== "http" && rec.protocol !== "https" && rec.protocol !== "socks5") {
    logger.warn({ proxyId: rec.id, protocol: rec.protocol }, "key-pool: unknown proxy protocol");
    return null;
  }
  return {
    protocol: rec.protocol,
    host: rec.host,
    port: rec.port,
    username: rec.username ? decryptSecret(rec.username) : undefined,
    password: rec.passwordCipher ? decryptSecret(rec.passwordCipher) : undefined,
  };
}

/**
 * Выбрать ключ для провайдера. Если в БД нет активных ключей — `PoolExhaustedError`
 * (никакого env-fallback'а: админка должна быть единственным источником правды,
 * иначе деактивация ключа не отключает трафик). Если все ключи throttled —
 * также `PoolExhaustedError` с минимальным `retryAfterMs`.
 *
 * `opts.inverted = true` — инвертирует приоритеты (от низкого к высокому).
 * Нужно для "холодных" ключей которые мы хотим намеренно прогревать через
 * редкие модели (например gpt-image-1.5 — раз в месяц юзается, низкоприори-
 * тетный ключ иначе никогда не получит трафик → tier у OpenAI не растёт).
 * Fallback всё равно работает: если все low-priority throttled, дойдёт до
 * high-priority.
 */
export async function acquireKey(
  provider: string,
  opts?: { inverted?: boolean },
): Promise<AcquiredKey> {
  const keys = await loadKeysForProvider(provider);
  if (keys.length === 0) throw new PoolExhaustedError(provider, 0);

  // Группируем по приоритету.
  const byPriority = new Map<number, PoolKeyRecord[]>();
  for (const k of keys) {
    const arr = byPriority.get(k.priority) ?? [];
    arr.push(k);
    byPriority.set(k.priority, arr);
  }
  // По умолчанию — высокий приоритет первым (DESC). При inverted=true —
  // низкий первым (ASC), чтобы целенаправленно нагружать холодные ключи.
  const priorities = [...byPriority.keys()].sort((a, b) => (opts?.inverted ? a - b : b - a));

  let minThrottleMs = Number.POSITIVE_INFINITY;

  const redis = getRedis();
  for (const p of priorities) {
    const group = byPriority.get(p)!;
    // Round-robin внутри группы: атомарный INCR Redis. Inverted-режим
    // юзает отдельный counter (`:inv:`), чтобы не сбивать порядок обычного RR.
    const counterKey = opts?.inverted
      ? `${RR_PREFIX}${provider}:inv:${p}`
      : `${RR_PREFIX}${provider}:${p}`;
    const counter = await redis.incr(counterKey);
    const startIdx = (counter - 1) % group.length;
    // Проходим всю группу с этой стартовой точки, чтобы попробовать все ключи.
    for (let offset = 0; offset < group.length; offset++) {
      const k = group[(startIdx + offset) % group.length];
      const throttle = await checkKeyThrottle(k.id);
      if (throttle) {
        if (throttle.remainingMs < minThrottleMs) minThrottleMs = throttle.remainingMs;
        continue;
      }
      // Свободный ключ найден.
      return {
        keyId: k.id,
        apiKey: decryptSecret(k.keyCipher),
        proxy: decodeProxy(k.proxy),
      };
    }
  }

  // Все ключи всех приоритетов на cooldown'е.
  const retryAfterMs = Number.isFinite(minThrottleMs) ? minThrottleMs : 60_000;
  throw new PoolExhaustedError(provider, retryAfterMs);
}

/**
 * Получить ключ по заранее известному id (для poll-стадии staged BullMQ —
 * providerJobId привязан к конкретному аккаунту). Throttle игнорируется:
 * текущая операция уже в процессе, мы обязаны её завершить тем же ключом.
 *
 * Если keyId не задан или запись пропала из БД — `PoolExhaustedError`
 * (env-fallback убран; пул — единственный источник правды). Inactive-ключ
 * всё ещё используется: in-flight-операция должна доехать на исходном ключе.
 */
export async function acquireById(
  keyId: string | null | undefined,
  provider: string,
): Promise<AcquiredKey> {
  if (!keyId) {
    logger.warn({ provider }, "key-pool.acquireById: no keyId provided");
    throw new PoolExhaustedError(provider, 0);
  }

  const row = await db.providerKey.findUnique({
    where: { id: keyId },
    select: {
      id: true,
      isActive: true,
      keyCipher: true,
      proxy: {
        select: {
          id: true,
          protocol: true,
          host: true,
          port: true,
          username: true,
          passwordCipher: true,
          isActive: true,
        },
      },
    },
  });

  if (!row) {
    logger.warn({ keyId, provider }, "key-pool.acquireById: key not found");
    throw new PoolExhaustedError(provider, 0);
  }
  if (!row.isActive) {
    logger.warn(
      { keyId, provider },
      "key-pool.acquireById: key inactive, but reusing for in-flight job",
    );
  }

  return {
    keyId: row.id,
    apiKey: decryptSecret(row.keyCipher),
    proxy: decodeProxy(row.proxy && row.proxy.isActive ? row.proxy : null),
  };
}

/** Поставить cooldown на ключ после 429-подобной ошибки. */
export async function markRateLimited(
  keyId: string,
  cooldownMs: number,
  reason: string,
): Promise<void> {
  await tripKeyThrottle(keyId, cooldownMs, reason);
  // Best-effort обновление метрик; ошибки не критичны.
  await db.providerKey
    .update({
      where: { id: keyId },
      data: { errorCount: { increment: 1 }, lastErrorAt: new Date(), lastErrorText: reason },
    })
    .catch((err) => logger.warn({ err, keyId }, "key-pool.markRateLimited: metrics update failed"));
}

/** Зафиксировать успешное использование (счётчик + lastUsedAt). */
export async function recordSuccess(keyId: string): Promise<void> {
  await db.providerKey
    .update({
      where: { id: keyId },
      data: { requestCount: { increment: 1 }, lastUsedAt: new Date() },
    })
    .catch((err) => logger.warn({ err, keyId }, "key-pool.recordSuccess: metrics update failed"));
}

/** Зафиксировать ошибку (не rate-limit) — для observability. */
export async function recordError(keyId: string, message: string): Promise<void> {
  await db.providerKey
    .update({
      where: { id: keyId },
      data: {
        errorCount: { increment: 1 },
        lastErrorAt: new Date(),
        lastErrorText: message.slice(0, 500),
      },
    })
    .catch((err) => logger.warn({ err, keyId }, "key-pool.recordError: metrics update failed"));
}

/** Получить метаинфо для admin: cooldown с Redis + базовые метрики. */
export async function getKeyStats(keyId: string): Promise<{
  currentCooldownMs: number | null;
  cooldownReason: string | null;
}> {
  const t = await checkKeyThrottle(keyId);
  return {
    currentCooldownMs: t?.remainingMs ?? null,
    cooldownReason: t?.reason ?? null,
  };
}

// Используется тестами/admin endpoint для очистки кеша после CRUD.
export const _internal = { KEYS_CACHE_PREFIX, RR_PREFIX };
