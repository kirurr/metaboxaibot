/**
 * Soft-retry helper для provider-side rate-limit / overload ошибок на
 * poll-стадии (например, KIE 422 "Service is currently unavailable due to
 * high demand"). Symmetric with `deferIfTransientNetworkError` — defer'им
 * SAME job через `moveToDelayed` на классификационный cooldownMs + jitter,
 * BullMQ retry после паузы.
 *
 * Зачем отдельно от `deferIfTransientNetworkError`: сетевые ошибки и
 * provider-overload — разные классы. Сеть лечится коротким wait'ом (DNS
 * рестарт), overload — provider'ским cooldown'ом из classifyRateLimit
 * (обычно 60-120с по дефолту).
 *
 * Использует тот же `transientRetries` budget — общий пул soft-retry'ев
 * между сетью и rate-limit'ом. Это намеренно: оба case'а — transient retry
 * не должны бесконечно loop'аться, общий cap простой и предсказуемый.
 *
 * Use из processor's outer catch ПОСЛЕ rate-limit-long-window-class checks
 * и до `deferIfTransientNetworkError` / user-facing branches:
 *
 *   await deferIfRateLimitOverload({ err, job, token, section, modelId, provider, keyId });
 *   // ↑ throws DelayedError если rescheduled; returns silently иначе
 *   // → fall through to user-facing failure handling
 */

import type { Job } from "bullmq";
import { classifyRateLimit } from "@metabox/api/utils/rate-limit-error";
import { markRateLimited } from "@metabox/api/services/key-pool";
import { isOpenAiBillingExhaustion } from "@metabox/api/utils/openai-billing-error";
import { delayJob } from "./delay-job.js";
import { notifyRateLimit, notifyTechErrorThrottled } from "./notify-error.js";
import { logger } from "../logger.js";

// Согласовано с MAX_TRANSIENT_RETRIES в defer-transient.ts — оба defer'а
// инкрементят ОДИН и тот же `transientRetries` counter в job.data. Если cap'ы
// расходятся, меньший из двух становится фактическим cap'ом для обоих типов
// retry'ев (rate-limit defer'нул 3 раза → счётчик 3 → transient defer пропустит
// retry на ENOTFOUND, и наоборот). Держим равными.
const MAX_RATE_LIMIT_DEFERS = 3;
const JITTER_MS = 30_000;

interface DeferIfRateLimitOpts<D extends { transientRetries?: number; stage?: string }> {
  err: unknown;
  job: Job<D>;
  token?: string;
  /** Section label (image/video/audio/avatar) — для логов и notifyRateLimit. */
  section: string;
  /** Model ID — для notifyRateLimit + логов. */
  modelId: string;
  /** Provider строка — для классификации (cooldownMs lookup) и markRateLimited. */
  provider?: string;
  /** Sticky providerKeyId на poll-стадии. Если задан — markRateLimited на нём. */
  keyId?: string | null;
}

export async function deferIfRateLimitOverload<
  D extends { transientRetries?: number; stage?: string },
>(opts: DeferIfRateLimitOpts<D>): Promise<void> {
  const { err, job, token, section, modelId, provider, keyId } = opts;

  // OpenAI billing-исчерпание (`billing_hard_limit_reached` 400 или
  // `insufficient_quota` 429) — account-wide состояние. Симметрично с
  // submitWithThrottle / submitWithFallback: НЕ markRateLimited (это не сбой
  // ключа, кончились деньги org) и НЕ defer (биллинг не «отойдёт» через
  // cooldown). Дедуп'ный алерт в balance-тему + silent return — caller
  // покажет юзеру user-facing «временно недоступна».
  if (isOpenAiBillingExhaustion(err)) {
    const dedupKey = keyId ? `openai-billing-exhaustion:${keyId}` : "openai-billing-exhaustion";
    void notifyTechErrorThrottled(
      err instanceof Error ? err : new Error(String(err)),
      { section, modelId, jobId: job.id },
      dedupKey,
      { channel: "balance" },
    );
    return;
  }

  const cls = classifyRateLimit(err, provider);
  if (!cls.isRateLimit) return;

  const current = job.data.transientRetries ?? 0;
  if (current >= MAX_RATE_LIMIT_DEFERS) {
    logger.warn(
      { section, modelId, jobId: job.id, retries: current },
      "Rate-limit defer budget exhausted — falling through to failure",
    );
    return;
  }

  // Per-key throttle (если есть DB-ключ) — другие job'ы не возьмут этот ключ
  // на cooldown window. Polling всё равно использует sticky keyId, но при
  // следующем submit'е acquireKey пропустит throttled key.
  if (keyId) {
    void markRateLimited(keyId, cls.cooldownMs, cls.reason);
  }

  void notifyRateLimit({
    section,
    modelId,
    cooldownMs: cls.cooldownMs,
    reason: cls.reason,
    isLongWindow: cls.isLongWindow,
    err,
    jobId: job.id,
  });

  const delay = cls.cooldownMs + Math.floor(Math.random() * JITTER_MS);
  const next = current + 1;

  logger.warn(
    { section, modelId, jobId: job.id, delay, attempt: next, reason: cls.reason },
    "Provider rate-limit/overload — deferring job",
  );

  await delayJob(job, { ...job.data, transientRetries: next }, delay, token);
}
