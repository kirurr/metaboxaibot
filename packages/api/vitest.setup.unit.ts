/**
 * Setup for unit tests in `src/**\/*.test.ts` — adapter mocks, pure logic, etc.
 * Only stubs env so `@metabox/shared/config` import doesn't throw. No DB,
 * no Redis, no msw lifecycle (integration tests use `vitest.setup.ts`).
 */
process.env.BOT_TOKEN = process.env.BOT_TOKEN ?? "test:bot-token";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://test/test";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
process.env.KEY_VAULT_MASTER =
  process.env.KEY_VAULT_MASTER ?? "test-vault-master-key-32-bytes-base64===========";
