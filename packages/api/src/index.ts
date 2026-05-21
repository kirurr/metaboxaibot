import "dotenv/config";
import { initSentry } from "./sentry.js";
initSentry();

import { logger } from "./logger.js";
import { buildApp } from "./app.js";
import { config, preloadLocales, SUPPORTED_LANGUAGES } from "@metabox/shared";

await preloadLocales(SUPPORTED_LANGUAGES);

const server = await buildApp({ startBackgroundJobs: true });

const port = config.api.port;
await server.listen({ port, host: "0.0.0.0" });
logger.info({ port }, "API server started");
