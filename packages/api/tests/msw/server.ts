/**
 * Shared msw server for vitest. Lifecycle (listen/resetHandlers/close) is
 * driven from `vitest.setup.ts`. Per-test overrides go through
 * `mswServer.use(...)`; the global defaults live in `handlers/`.
 */

import { setupServer } from "msw/node";
import { metaboxHandlers } from "./handlers/metabox.js";
import { cartesiaHandlers, elevenLabsHandlers } from "./handlers/voices.js";

export const mswServer = setupServer(
  ...metaboxHandlers,
  ...cartesiaHandlers,
  ...elevenLabsHandlers,
);
