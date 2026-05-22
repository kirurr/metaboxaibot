/**
 * Build a Fastify instance for tests — same plugins/hooks/routes as prod,
 * but with background jobs (schedulers, pubsub) disabled. Use with
 * `app.inject(...)` — never `app.listen()` in tests.
 */

import type { FastifyInstance } from "fastify";
import { preloadLocales, SUPPORTED_LANGUAGES } from "@metabox/shared";
import { buildApp } from "../../src/app.js";

// В проде `preloadLocales` вызывается из `src/index.ts` (top-level entrypoint),
// `buildApp` сам по себе локали не подгружает. Для тестов это нужно сделать
// явно — иначе `getT(lang)` в роутах (например, `web-models.ts`) вернёт undefined
// и сериализация моделей упадёт с TypeError.
let localesPreloaded = false;

export async function buildTestApp(): Promise<FastifyInstance> {
  if (!localesPreloaded) {
    await preloadLocales(SUPPORTED_LANGUAGES);
    localesPreloaded = true;
  }
  return buildApp({ startBackgroundJobs: false });
}
