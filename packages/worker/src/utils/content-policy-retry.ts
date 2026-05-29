/**
 * Retry→fallback для content-policy / модерационных ошибок генеративных моделей.
 *
 * Провайдерская модерация часто недетерминирована — перезапуск того же запроса
 * или другой провайдер нередко проходит (особенно output-модерация с рандомом
 * сида). Поэтому вместо мгновенной user-facing ошибки делаем:
 *   1 ретрай на текущем провайдере → fallback на следующего кандидата →
 *   1 ретрай на нём → ... → когда кандидаты кончились, отдаём терминальную
 *   user-facing ошибку (БЕЗ ops-алерта — это не баг провайдера, а модерация).
 *
 * Re-enqueue зеркалит существующий poll-stage fallback (см. *.processor.ts):
 * чистим providerJobId/Key, сбрасываем stage, мерджим состояние в inputData,
 * `delayJob` (moveToDelayed — НЕ ест BullMQ attempts). Per-provider счётчик
 * ретраев живёт в `inputData.contentPolicy.retries`, цепочка провайдеров — в
 * `inputData.fallback.attemptedProviders` (тот же ключ, что у 5xx/unavailable
 * fallback'а — провайдер, исчерпанный модерацией, не пробуется и им).
 *
 * child-safety / CSAM сюда НЕ попадает — отфильтровано в `isContentPolicyError`.
 */

import type { Job } from "bullmq";
import { type AIModel, getFallbackCandidates, isFallbackCompatible } from "@metabox/shared";
import type { Prisma } from "@prisma/client";
import { db } from "@metabox/api/db";
import { logger } from "../logger.js";
import { delayJob } from "./delay-job.js";
import { notifyFallback } from "./notify-error.js";

/** Сколько ретраев на ОДНОМ провайдере перед переключением на следующего. */
const PER_PROVIDER_RETRIES = 1;

/** Задержка перед re-enqueue (как у существующего poll-fallback'а). */
const REENQUEUE_DELAY_MS = 1000;

interface ContentPolicyState {
  retries?: Record<string, number>;
}

interface FallbackState {
  primaryProvider?: string;
  effectiveProvider?: string;
  attemptedProviders?: string[];
}

export interface ContentPolicyRetryOpts {
  job: Job;
  token?: string;
  dbJobId: string;
  modelId: string;
  modelMeta: AIModel;
  /** Секция для `getFallbackCandidates` — у image это "design". */
  fallbackSection: "design" | "video" | "audio";
  /** Секция для `notifyFallback` / логов — "image" | "video" | "audio". */
  notifySection: string;
  /** mediaInputs текущей джобы — для фильтра совместимости кандидатов. */
  mediaInputs?: Record<string, string[]>;
  userId?: string;
}

/**
 * Обрабатывает content-policy ошибку: ретрай на том же провайдере, потом
 * fallback. Если re-enqueue произошёл — БРОСАЕТ `DelayedError` (через delayJob)
 * и НЕ возвращается. Если цепочка исчерпана — возвращается (caller проваливается
 * в обычный terminal user-facing path, без ops-алерта).
 */
export async function handleContentPolicyRetryFallback(
  opts: ContentPolicyRetryOpts,
): Promise<void> {
  const { job, token, dbJobId, modelId, modelMeta, fallbackSection, notifySection, mediaInputs } =
    opts;

  const dbJob = await db.generationJob.findUnique({
    where: { id: dbJobId },
    select: { inputData: true },
  });
  const inputData = (dbJob?.inputData as Record<string, unknown> | null | undefined) ?? {};
  const fbState = (inputData.fallback as FallbackState | undefined) ?? {};
  const cpState = (inputData.contentPolicy as ContentPolicyState | undefined) ?? {};
  const retries: Record<string, number> = { ...(cpState.retries ?? {}) };

  const currentEff = fbState.effectiveProvider ?? modelMeta.provider;
  const usedForCurrent = retries[currentEff] ?? 0;

  const reenqueueData = {
    ...job.data,
    stage: undefined,
    pollStartedAt: undefined,
    lastIntervalMs: undefined,
  };

  // ── 1. Один ретрай на текущем провайдере (модерация часто недетерминирована).
  if (usedForCurrent < PER_PROVIDER_RETRIES) {
    retries[currentEff] = usedForCurrent + 1;
    const merged = { ...inputData, contentPolicy: { retries } };
    await db.generationJob.update({
      where: { id: dbJobId },
      data: {
        providerJobId: null,
        providerKeyId: null,
        inputData: merged as unknown as Prisma.InputJsonValue,
      },
    });
    logger.warn(
      { dbJobId, modelId, provider: currentEff, attempt: retries[currentEff], notifySection },
      "Content-policy: retrying same provider",
    );
    await delayJob(job, reenqueueData, REENQUEUE_DELAY_MS, token);
    return;
  }

  // ── 2. Ретрай исчерпан — fallback на следующего совместимого кандидата.
  const attempted = new Set(fbState.attemptedProviders ?? []);
  attempted.add(currentEff);
  const candidates = getFallbackCandidates(modelId, fallbackSection).filter((m) =>
    isFallbackCompatible(m, mediaInputs),
  );
  const next = candidates.find((m) => !attempted.has(m.provider));

  if (!next) {
    // Цепочка исчерпана — terminal. Caller покажет user-facing сообщение без
    // ops-алерта (content-policy UserFacingError не имеет notifyOps).
    logger.warn(
      {
        dbJobId,
        modelId,
        currentEff,
        attempted: Array.from(attempted),
        registeredFallbacks: candidates.map((m) => m.provider),
      },
      "Content-policy: retry+fallback chain exhausted — terminal user error",
    );
    return;
  }

  const merged = {
    ...inputData,
    fallback: {
      primaryProvider: fbState.primaryProvider ?? modelMeta.provider,
      attemptedProviders: Array.from(attempted),
    },
    // Счётчики ретраев сохраняем; новый провайдер стартует с 0 → получит свой ретрай.
    contentPolicy: { retries },
  };
  await db.generationJob.update({
    where: { id: dbJobId },
    data: {
      providerJobId: null,
      providerKeyId: null,
      inputData: merged as unknown as Prisma.InputJsonValue,
    },
  });
  await notifyFallback({
    section: notifySection,
    modelId,
    primaryProvider: modelMeta.provider,
    fallbackProvider: next.provider,
    reason: "content_policy",
    jobId: dbJobId,
    userId: opts.userId,
  });
  logger.warn(
    { dbJobId, modelId, currentEff, next: next.provider },
    "Content-policy: re-enqueuing on fallback provider",
  );
  await delayJob(job, reenqueueData, REENQUEUE_DELAY_MS, token);
}
