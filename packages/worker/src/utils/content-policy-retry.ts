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
 * `delayJob` (moveToDelayed — НЕ ест BullMQ attempts).
 *
 * ВАЖНО про `attemptedProviders`: процессор после УСПЕШНОГО submit пишет туда
 * объединение всех `fbResult.attempts`, ВКЛЮЧАЯ успешный провайдер. Submit-стадия
 * строит из него `skipProviders`. Поэтому для «ретрая на ТОМ ЖЕ провайдере» мы
 * обязаны УБРАТЬ currentEff из attemptedProviders (иначе submit его скипнет и
 * ретрай уйдёт на fallback / упадёт «no candidates»). Прочие провайдеры из
 * attemptedProviders (история 5xx/unavailable fallback'а) сохраняем.
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
  /** Сколько ретраев УЖЕ сделано на каждом провайдере. */
  retries?: Record<string, number>;
  /**
   * Сколько всего re-enqueue'ев сделано (ретраи + fallback'и). Circuit-breaker:
   * `delayJob` (moveToDelayed) НЕ инкрементит BullMQ attemptsMade, поэтому без
   * собственного счётчика теоретический цикл ничем не ограничен. Завершение и
   * так гарантируется монотонным ростом attemptedProviders + проверкой `next`,
   * но кап — страховка от будущих изменений (нестабильный порядок кандидатов и т.п.).
   */
  totalReenqueues?: number;
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
  /**
   * Пропустить `isFallbackCompatible`-фильтр кандидатов. Для audio: у audio
   * JobData нет mediaInputs, а submit-путь audio fallback'ов тоже не фильтрует —
   * мирроринг, чтобы не отсечь валидного кандидата.
   */
  skipCompatibilityFilter?: boolean;
  userId?: string;
}

/**
 * Обрабатывает content-policy ошибку: ретрай на том же провайдере, потом
 * fallback. Если re-enqueue произошёл — БРОСАЕТ `DelayedError` (через delayJob)
 * и НЕ возвращается. Если цепочка исчерпана / сработал circuit-breaker —
 * возвращается (caller проваливается в обычный terminal user-facing path,
 * без ops-алерта).
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
  const totalReenqueues = cpState.totalReenqueues ?? 0;

  const currentEff = fbState.effectiveProvider ?? modelMeta.provider;

  const candidatesRaw = getFallbackCandidates(modelId, fallbackSection);
  const candidates = opts.skipCompatibilityFilter
    ? candidatesRaw
    : candidatesRaw.filter((m) => isFallbackCompatible(m, mediaInputs));

  // Circuit-breaker: (#кандидатов + primary) × (ретрай + первичный заход).
  const maxReenqueues = (candidates.length + 1) * (PER_PROVIDER_RETRIES + 1);
  if (totalReenqueues >= maxReenqueues) {
    logger.warn(
      { dbJobId, modelId, totalReenqueues, maxReenqueues },
      "Content-policy: circuit breaker tripped — terminal user error",
    );
    return;
  }

  // attemptedProviders включает currentEff (success-провайдер). Для ретрая на
  // ТОМ ЖЕ провайдере убираем его, чтобы submit не скипнул; прочую историю
  // (5xx/unavailable fallback) сохраняем.
  const priorAttempted = new Set(fbState.attemptedProviders ?? []);
  priorAttempted.delete(currentEff);

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
    const merged = {
      ...inputData,
      // attemptedProviders без currentEff → submit повторно выберет currentEff.
      fallback: { ...fbState, attemptedProviders: Array.from(priorAttempted) },
      contentPolicy: { retries, totalReenqueues: totalReenqueues + 1 },
    };
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
  priorAttempted.add(currentEff);
  const next = candidates.find((m) => !priorAttempted.has(m.provider));

  if (!next) {
    // Цепочка исчерпана — terminal. Caller покажет user-facing сообщение без
    // ops-алерта (content-policy UserFacingError не имеет notifyOps).
    logger.warn(
      {
        dbJobId,
        modelId,
        currentEff,
        attempted: Array.from(priorAttempted),
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
      attemptedProviders: Array.from(priorAttempted),
    },
    // Счётчики ретраев сохраняем. ВАЖНО: на poll-стадии (effectiveProvider уже
    // записан после успешного submit — типичный случай output-модерации, ради
    // которой и сделана фича) новый провайдер стартует с retries=0 и получит
    // свой ретрай. На submit-стадии (effectiveProvider ещё не записан)
    // currentEff резолвится в primary, поэтому ретрай достаётся primary, а
    // каждый fallback-кандидат пробуется по разу — цепочка всё равно проходит
    // всех и корректно завершается.
    contentPolicy: { retries, totalReenqueues: totalReenqueues + 1 },
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
