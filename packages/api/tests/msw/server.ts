/**
 * Shared msw server for vitest. Lifecycle (listen/resetHandlers/close) is
 * driven from `vitest.setup.ts`. Per-test overrides go through
 * `mswServer.use(...)`; the global defaults live in `handlers/`.
 */

import { setupServer } from "msw/node";
import { heygenHandlers } from "./handlers/heygen.js";
import { higgsfieldHandlers } from "./handlers/higgsfield.js";
import { metaboxHandlers } from "./handlers/metabox.js";
import { metaboxAuthHandlers } from "./handlers/metabox-auth.js";
import { metaboxBillingHandlers } from "./handlers/metabox-billing.js";
import { cartesiaHandlers, elevenLabsHandlers } from "./handlers/voices.js";

export const mswServer = setupServer(
  ...metaboxHandlers,
  ...metaboxBillingHandlers,
  ...metaboxAuthHandlers,
  ...cartesiaHandlers,
  ...elevenLabsHandlers,
  ...heygenHandlers,
  ...higgsfieldHandlers,
);
