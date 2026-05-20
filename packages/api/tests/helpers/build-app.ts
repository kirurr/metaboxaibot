/**
 * Build a Fastify instance for tests — same plugins/hooks/routes as prod,
 * but with background jobs (schedulers, pubsub) disabled. Use with
 * `app.inject(...)` — never `app.listen()` in tests.
 */

import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";

export async function buildTestApp(): Promise<FastifyInstance> {
  return buildApp({ startBackgroundJobs: false });
}
