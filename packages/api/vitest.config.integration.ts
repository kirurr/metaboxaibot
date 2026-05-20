import { defineConfig } from "vitest/config";

/**
 * Integration tests — hit a real Postgres + Redis and mock outgoing HTTP via
 * msw. Run with `pnpm test:integration`. Requires the test stack to be up
 * (`pnpm test:up`) and migrations to be applied (`pnpm test:migrate`).
 *
 * Single-fork pool: integration tests share one DB schema and truncate after
 * every test — running them in parallel would race on row counts.
 */
export default defineConfig({
  test: {
    name: "integration",
    include: ["tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./tests/setup/env.ts", "./vitest.setup.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
