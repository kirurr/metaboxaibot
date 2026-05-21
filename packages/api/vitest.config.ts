import { defineConfig } from "vitest/config";

/**
 * Default vitest config — unit tests in `src/**\/*.test.ts`.
 * Pure logic and adapter mocks; no DB / Redis / msw infra needed.
 *
 * Integration tests live in `tests/**\/*.test.ts` and use
 * `vitest.config.integration.ts` (run via `pnpm test:integration`).
 */
export default defineConfig({
  test: {
    name: "unit",
    include: ["src/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./vitest.setup.unit.ts"],
  },
});
