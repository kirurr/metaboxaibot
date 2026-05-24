import { defineConfig } from "vitest/config";

/**
 * Integration tests — hit a real Postgres + Redis and mock outgoing HTTP via
 * msw. Run the full pipeline (migrate + tests) via `pnpm -F @metabox/api test:docker`.
 */
export default defineConfig({
  test: {
    name: "integration",
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./tests/setup/env.ts", "./vitest.setup.ts"],
    pool: "threads",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
