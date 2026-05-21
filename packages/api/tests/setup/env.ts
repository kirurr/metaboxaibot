/**
 * First setupFile — stubs env vars BEFORE any other module is imported.
 *
 * Listed first in `vitest.config.integration.ts > setupFiles` so it runs
 * before `lifecycle.ts` (which imports helpers that pull in
 * `@metabox/shared/config`, and that module throws on missing required vars
 * at evaluation time).
 *
 * Values must match docker-compose.test-deps.yml and the METABOX_BASE used
 * in tests/msw/handlers/metabox.ts.
 */
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.BOT_TOKEN = process.env.BOT_TOKEN ?? "test:bot-token";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://test_user:test_pass@127.0.0.1:5666/test_db";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://:test_redis_pass@127.0.0.1:6666";
process.env.KEY_VAULT_MASTER =
  process.env.KEY_VAULT_MASTER ?? "test-vault-master-key-32-bytes-base64===========";
process.env.WEB_JWT_SECRET =
  process.env.WEB_JWT_SECRET ?? "test-jwt-secret-very-long-string-for-hmac-sha256-tests";
process.env.METABOX_API_URL = process.env.METABOX_API_URL ?? "https://metabox-test.example.com";
process.env.METABOX_INTERNAL_KEY = process.env.METABOX_INTERNAL_KEY ?? "test-internal-key";
