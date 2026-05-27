/**
 * Soft-retry helper for transient network failures (EAI_AGAIN, ECONNRESET, …).
 *
 * Why this exists: BullMQ `attempts: 1` on poll-stage re-enqueues means a
 * transient DNS/socket hiccup on the poll leg fails the whole job
 * immediately. This gives us an orthogonal retry budget that survives stage
 * transitions by carrying a `transientRetries` counter in the job payload.
 *
 * Use from the processor's outer catch, after rate-limit checks and before
 * user-facing / tech-notification branches:
 *
 *   await deferIfTransientNetworkError({ err, job, token, section });
 *   // ↑ throws DelayedError if rescheduled; returns silently otherwise
 *   // → fall through to user-facing failure handling
 */

import type { Job, Queue } from "bullmq";
import { isTransientNetworkError } from "@metabox/api/utils/fetch";
import { delayJob } from "./delay-job.js";
import { logger } from "../logger.js";

// 3 раунда retry с базовой паузой 30s + jitter до 30s даёт ~3-5 минут общего
// окна на восстановление сетевой связности (DNS, transient TLS). После исчерпания
// юзер увидит «не получилось». Раньше было 5 — на длинных outage'ах юзер ждал
// до 10 минут placeholder'а без обратной связи, что хуже честного fail.
const MAX_TRANSIENT_RETRIES = 3;
const BASE_DELAY_MS = 30_000;
const JITTER_MS = 30_000;

interface DeferIfTransientOpts<D extends { transientRetries?: number; stage?: string }> {
  err: unknown;
  job: Job<D>;
  /**
   * BullMQ worker token for the current job. Required for `moveToDelayed`.
   * Forward from the second arg of the processor function.
   */
  token?: string;
  /**
   * Kept in the API for symmetry with other helpers; not used directly anymore
   * (deferral is via `job.moveToDelayed`).
   */
  queue?: Queue;
  /** Section label (image/video/audio/avatar) — used only for logs. */
  section: string;
  /**
   * Kept in the API for backward compat. The stage field on `job.data` is
   * preserved across the moveToDelayed via `delayJob`.
   */
  jobName?: string;
}

/**
 * If the error is a transient network failure AND the retry budget isn't
 * exhausted, defers the SAME job via `moveToDelayed` (preserving jobId) and
 * throws `DelayedError` — caller's catch should let it propagate so BullMQ
 * picks it up.
 *
 * Returns silently when the error isn't transient or the budget is exhausted —
 * caller falls through to normal failure handling.
 */
export async function deferIfTransientNetworkError<
  D extends { transientRetries?: number; stage?: string },
>(opts: DeferIfTransientOpts<D>): Promise<void> {
  const { err, job, token, section } = opts;
  if (!isTransientNetworkError(err)) return;

  const current = job.data.transientRetries ?? 0;
  if (current >= MAX_TRANSIENT_RETRIES) {
    logger.warn(
      { section, jobId: job.id, retries: current },
      "Transient retry budget exhausted — falling through to failure",
    );
    return;
  }

  const next = current + 1;
  const delay = BASE_DELAY_MS + Math.floor(Math.random() * JITTER_MS);

  logger.warn(
    { section, jobId: job.id, delay, attempt: next, err },
    "Transient network error — re-scheduling job",
  );

  await delayJob(job, { ...job.data, transientRetries: next }, delay, token);
}
