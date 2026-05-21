/**
 * Test Redis helpers. Reuses the singleton from `src/redis.ts` — it picks up
 * REDIS_URL from the test env stubbed in `vitest.setup.ts`.
 */

import { closeRedis, getRedis } from "../../src/redis.js";

export { getRedis };

export async function flushRedis(): Promise<void> {
  const redis = getRedis();
  await redis.flushdb();
}

export async function disconnectRedis(): Promise<void> {
  await closeRedis();
}
