/**
 * Integration test lifecycle — second setupFile after `tests/setup/env.ts`.
 *
 * env.ts MUST run first (it stubs DATABASE_URL / BOT_TOKEN / etc) because
 * the imports below transitively load `@metabox/shared/config`, which throws
 * on missing required vars at module-evaluation time.
 */

import { afterAll, afterEach, beforeAll } from "vitest";
import { mswServer } from "./tests/msw/server.js";
import { disconnectDb, truncateAll } from "./tests/helpers/db.js";
import { disconnectRedis, flushRedis } from "./tests/helpers/redis.js";

beforeAll(async () => {
  mswServer.listen({ onUnhandledRequest: "error" });
  // Previous run may have left rows around — start clean.
  await truncateAll();
  await flushRedis();
});

afterEach(async () => {
  mswServer.resetHandlers();
  await truncateAll();
  await flushRedis();
});

afterAll(async () => {
  mswServer.close();
  await disconnectRedis();
  await disconnectDb();
});
