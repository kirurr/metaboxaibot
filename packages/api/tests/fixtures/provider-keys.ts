/**
 * Хелпер сидинга `ProviderKey` для интеграционных тестов. Зеркалит то, что
 * делает админка при добавлении ключа: encryptSecret(apiKey) → keyCipher,
 * maskKey(apiKey) → keyMask. `acquireKey(provider)` сразу увидит запись после
 * `invalidatePoolCache(provider)` (или после истечения 30-секундного in-process
 * кеша в key-pool.service).
 */

import type { ProviderKey } from "@prisma/client";
import { encryptSecret, maskKey } from "@metabox/shared";
import { db } from "../helpers/db.js";

export interface CreateTestProviderKeyOptions {
  label?: string;
  priority?: number;
  isActive?: boolean;
}

export async function createTestProviderKey(
  provider: string,
  apiKey: string,
  opts: CreateTestProviderKeyOptions = {},
): Promise<ProviderKey> {
  return db.providerKey.create({
    data: {
      provider,
      label: opts.label ?? `test-${provider}`,
      keyCipher: encryptSecret(apiKey),
      keyMask: maskKey(apiKey),
      priority: opts.priority ?? 0,
      isActive: opts.isActive ?? true,
    },
  });
}
