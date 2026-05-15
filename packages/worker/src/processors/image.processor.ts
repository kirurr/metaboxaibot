import { UnrecoverableError, DelayedError } from "bullmq";
import type { Job } from "bullmq";
import { delayJob } from "../utils/delay-job.js";
import {
  resolveUserFacingMessage,
  shouldNotifyOps,
  resolveSubJobError,
} from "../utils/user-facing-error.js";
import { getIntervalForElapsed } from "../utils/poll-schedule.js";
import { Api } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type { ImageJobData } from "@metabox/api/queues";
import { db } from "@metabox/api/db";
import { createImageAdapter } from "@metabox/api/ai/image";
import type { ImageResult } from "@metabox/api/ai/image";
import {
  deductTokens,
  refundTokens,
  calculateCost,
  calculateProviderCostUsd,
  usdToTokens,
  translatePromptIfNeeded,
} from "@metabox/api/services";
import {
  buildS3Key,
  buildThumbnailKey,
  sectionMeta,
  uploadBuffer,
  getFileUrl,
  generateThumbnail,
  measureImageMegapixels,
  compressForTelegramPhoto,
} from "@metabox/api/services/s3";
import { buildDownloadButton } from "@metabox/api/utils/download-token";
import { isUniqueViolation } from "../utils/prisma-errors.js";
import { withRetry } from "../utils/with-retry.js";
import { InputFile } from "grammy";
import { logger } from "../logger.js";
import {
  config,
  AI_MODELS,
  getT,
  buildResultCaption,
  getFallbackCandidates,
  isFallbackCompatible,
  pickGenerationFailedMessage,
} from "@metabox/shared";
import type { AIModel } from "@metabox/shared";
import type { DeductResult } from "@metabox/api/services";
import { notifyTechError, notifyRateLimit, notifyFallback } from "../utils/notify-error.js";
import { isKieTransientError } from "@metabox/api/utils/kie-error";
import { isProviderTemporaryUnavailable } from "@metabox/api/utils/provider-unavailable-error";
import { isRateLimitLongWindowError } from "../utils/submit-with-throttle.js";
import { submitWithFallback } from "../utils/submit-with-fallback.js";
import {
  deriveLockedProvider,
  detectUsedFallback,
  pickBatchErrorCode,
} from "../utils/fallback-state.js";
import { classifyError, POLL_TIMEOUT_CODE } from "../utils/classify-error.js";
import { apiNotifySuccess, apiNotifyError } from "../utils/api-notify.js";
import { acquireForPoll } from "../utils/acquire-for-processor.js";
import { resolveKeyProviderForModel } from "@metabox/api/ai/key-provider";
import { deferIfTransientNetworkError } from "../utils/defer-transient.js";
import { deferIfRateLimitOverload } from "../utils/defer-rate-limit.js";
import {
  acquireKey,
  markRateLimited,
  recordError,
  recordSuccess,
} from "@metabox/api/services/key-pool";
import { isProviderInLongCooldown, markProviderLongCooldown } from "@metabox/api/services/throttle";
import { isPoolExhaustedError } from "@metabox/api/utils/pool-exhausted-error";
import {
  classifyRateLimit,
  isFiveXxError,
  LONG_WINDOW_THRESHOLD_MS,
} from "@metabox/api/utils/rate-limit-error";
import type { Prisma } from "@prisma/client";

/**
 * Per-sub-job state в `inputData.batch.subJobs[i]` для virtual batch.
 * Сохраняется ПОСЛЕ каждого submit/poll для idempotent restart-recovery.
 *
 * - `pending` — запрос отправлен (`providerJobId` есть для async, или ждём
 *   первого poll-tick), но конечного результата ещё нет.
 * - `succeeded` — есть готовый ImageResult (хранится здесь же `result`,
 *   sync-адаптеры — на случай если worker крашнулся между submit и finalize).
 * - `failed` — терминальная ошибка (429 после eviction-попытки, PoolExhausted,
 *   contentPolicy от провайдера и т.п.). Хранится в `error`.
 */
interface VirtualBatchSubJob {
  status: "pending" | "succeeded" | "failed";
  providerJobId?: string | null;
  providerKeyId?: string | null;
  /**
   * Provider строка, на которой sub-job был засабмичен. Может быть primary
   * `provider` или fallback'овый. На poll-стадии processor использует это
   * поле чтобы подобрать правильный AIModel + adapter.
   */
  effectiveProvider?: string;
  /** Sync-адаптер: результат, чтобы restart не сабмитил повторно. */
  result?: ImageResult;
  /**
   * User-facing локализованный текст ошибки (из resolveSubJobError).
   * Используется в K=0 user-fault ветке (показываем юзеру первый user-facing
   * error, чтобы понимал что фиксить). На partial-success / not-user-fault
   * путях НЕ показывается — там идёт обобщённое batchSubJobFailedMessage /
   * pickGenerationFailedMessage. Никогда не содержит сырых provider-string'ов.
   */
  error?: string;
  /**
   * Сырое err.message — для notifyTechError и логов. Не показывается юзеру.
   * Заполняется только если sub-job упал на unknown / generic ошибке (когда
   * userText был fallback'ом на t.errors.generationFailed).
   */
  errorRaw?: string;
  /**
   * Структурированная категория ошибки (`GenerationErrorCode`). Заполняется
   * через `classifyError(err)` в `resolveSubJobError`. На batch K=0 failure
   * aggregator `pickBatchErrorCode` берёт самую частую и пишет в parent
   * `GenerationJob.errorCode`.
   */
  errorCode?: string;
}
interface VirtualBatchState {
  n: number;
  subJobs: VirtualBatchSubJob[];
}

/**
 * State-shape `inputData.fallback` (для single-shot path).
 *
 * - `effectiveProvider`: provider строка, на которой состоялся успешный submit.
 *   Poll-stage использует её для выбора адаптера.
 *
 * Для virtual batch sticky-lock derived из `subJobs[*].effectiveProvider` —
 * не дублируется в FallbackState, чтобы избежать race'а между двумя записями
 * в inputData (writeBatchState + writeFallbackState).
 */
interface FallbackState {
  primaryProvider: string;
  effectiveProvider?: string;
  attemptedProviders?: string[];
}

const INITIAL_POLL_INTERVAL_MS = 5000;

/** Telegram multipart upload limit for sendDocument (used by `orig_` callback). */
const TELEGRAM_DOC_MAX_BYTES = 50 * 1024 * 1024;

const telegram = new Api(config.bot.token);

/**
 * Форматирует structured-report для notifyTechError при failure'ах в virtual
 * batch. Без этого в alert приходит только склеенный `errorRaw.join("---")`
 * без понимания: на какой sub-job упало, какой provider использовался, на
 * какой стадии (submit vs poll). С контекстом ops видит сразу:
 *
 *   stage: poll, primary: kie, total sub-jobs: 4, failed: 2
 *   [0] provider=kie:
 *       fetch GET kie.ai/api/v1/jobs/recordInfo failed (ECONNRESET): ...
 *       caused by: socket hang up [code: ECONNRESET]
 *   [2] provider=evolink (FALLBACK):
 *       HTTP 502 ...
 */
function formatSubJobErrorReport(
  subJobs: VirtualBatchSubJob[],
  stage: "submit" | "poll",
  primaryProvider: string,
): string {
  const failed = subJobs.filter((s) => s.status === "failed" && s.errorRaw);
  const header = `stage: ${stage}, primary: ${primaryProvider}, total sub-jobs: ${subJobs.length}, failed: ${failed.length}`;
  const lines: string[] = [header];
  for (let i = 0; i < subJobs.length; i++) {
    const s = subJobs[i];
    if (s.status !== "failed" || !s.errorRaw) continue;
    const provider = s.effectiveProvider ?? "unknown";
    const fbMark = provider !== primaryProvider ? " (FALLBACK)" : "";
    const indented = s.errorRaw
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n");
    lines.push(`[${i}] provider=${provider}${fbMark}:\n${indented}`);
  }
  return lines.join("\n");
}

/**
 * Virtual batch K=0 fallback re-submit. Аналог single-shot fallback в catch'е
 * processImageJob (см. там `if (stage === "poll" && isLastAttempt && ...)`),
 * но для virtual batch'а: главная функция в этом случае НЕ throw'ит наверх,
 * поэтому общий catch с fallback re-enqueue не вызывается → юзер не получает
 * fallback'овый результат хотя у модели зарегистрирован запасной провайдер.
 *
 * Логика: если все sub-job'ы упали с transient KIE-ошибкой (5xx или
 * 422 task-id-blank) И есть неиспользованный fallback-кандидат →
 *   1. Запоминаем primary провайдера в `inputData.fallback.attemptedProviders`
 *   2. Сбрасываем `inputData.batch` (sub-job state) → fresh start с N pending
 *   3. delayJob со stage=undefined → BullMQ перезапустит как fresh submit,
 *      Stage 1 пойдёт через fallback провайдера (skipProviders'ом отсечёт primary)
 *
 * Возвращает true если fallback ИНИЦИИРОВАН (delayJob сразу throw'ит DelayedError,
 * до return мы фактически не доходим — true это формальность для контракта).
 * Возвращает false если все sub-jobs не transient / нет candidate / нет
 * techRawErrors → caller продолжает обычный K=0 flow (mark failed + user message).
 *
 * Не покрывает partial-success (K>0 c failures) — там у юзера есть результат,
 * fallback не нужен.
 */
async function tryVirtualBatchFallbackResubmit(opts: {
  job: Job<ImageJobData>;
  dbJobId: string;
  modelId: string;
  modelMeta: AIModel | undefined;
  state: { subJobs: VirtualBatchSubJob[] };
  techRawErrors: string[];
  userIdStr: string;
  token: string | undefined;
  stage: "submit" | "poll";
}): Promise<boolean> {
  const { job, dbJobId, modelId, modelMeta, state, techRawErrors, userIdStr, token, stage } = opts;

  if (techRawErrors.length === 0 || !modelMeta) return false;

  // Все failed sub-job'ы должны быть transient-ошибкой провайдера.
  // Mixed (часть user-facing) → не fallback'аем: юзер увидит specific error.
  //
  // Два класса transient'ов:
  //  - `isKieTransientError`: KIE 5xx + специфичные 422 ("task id is blank",
  //    "playground failed", "client closed request") — внутренние сбои KIE.
  //  - `isProviderTemporaryUnavailable`: pattern-match "high demand" /
  //    "service unavailable" / "task processing failed" — узел провайдера
  //    перегружен (используется в single-shot пути на poll-stage).
  //
  // Раньше тут чекался только KIE-specific → KIE 422 "high demand" (E003)
  // не классифицировался transient'ом → fallback на virtual batch'е не запускался,
  // юзер получал K=0 alert вместо переключения на evolink-аналог.
  const failedTechSubs = state.subJobs.filter((s) => s.status === "failed" && s.errorRaw);
  if (failedTechSubs.length === 0) return false;
  const allTransient = failedTechSubs.every(
    (s) => isKieTransientError(s.errorRaw) || isProviderTemporaryUnavailable(s.errorRaw),
  );
  if (!allTransient) return false;

  // Refetch inputData — closures внутри try-блока могут быть устаревшими.
  const dbJob = await db.generationJob.findUnique({
    where: { id: dbJobId },
    select: { inputData: true },
  });
  const inputData = (dbJob?.inputData as Record<string, unknown> | null | undefined) ?? {};
  const fbStateNow =
    (inputData.fallback as
      | { effectiveProvider?: string; attemptedProviders?: string[] }
      | undefined) ?? {};
  const currentEff = fbStateNow.effectiveProvider ?? modelMeta.provider;
  const alreadyAttempted = new Set(fbStateNow.attemptedProviders ?? []);
  alreadyAttempted.add(currentEff);

  const fallbackCandidatesNow = getFallbackCandidates(modelId, "design").filter((m) =>
    isFallbackCompatible(m, job.data.mediaInputs),
  );
  const nextCandidate = fallbackCandidatesNow.find((m) => !alreadyAttempted.has(m.provider));

  if (!nextCandidate) {
    logger.warn(
      {
        dbJobId,
        modelId,
        currentEff,
        attempted: Array.from(alreadyAttempted),
        registeredFallbacks: fallbackCandidatesNow.map((m) => m.provider),
        stage,
      },
      "Virtual batch K=0: KIE transient — fallback skipped (no eligible candidate)",
    );
    return false;
  }

  logger.warn(
    { dbJobId, modelId, currentEff, next: nextCandidate.provider, stage },
    "Virtual batch K=0: KIE transient — re-enqueuing on fallback",
  );

  await notifyFallback({
    section: "image",
    modelId,
    primaryProvider: modelMeta.provider,
    fallbackProvider: nextCandidate.provider,
    reason: "persistent_5xx",
    jobId: dbJobId,
    userId: userIdStr,
  });

  // Сбрасываем sub-job state'ы (`inputData.batch` → удалить) — на свежем
  // запуске Stage 1 пересоздаст N pending sub-job'ов через fallback провайдера.
  // providerJobId/Key чистим defensive (в virtual batch они хранятся per-sub-job,
  // но на job-уровне всё равно можно было что-то записать в сценарии recovery).
  const merged: Record<string, unknown> = {
    ...inputData,
    fallback: {
      primaryProvider: modelMeta.provider,
      attemptedProviders: Array.from(alreadyAttempted),
    },
  };
  delete merged.batch;
  await db.generationJob.update({
    where: { id: dbJobId },
    data: {
      providerJobId: null,
      providerKeyId: null,
      inputData: merged as unknown as Prisma.InputJsonValue,
    },
  });

  await delayJob(
    job,
    {
      ...job.data,
      stage: undefined,
      pollStartedAt: undefined,
      lastIntervalMs: undefined,
    },
    1000,
    token,
  );

  return true; // unreachable due to delayJob throwing DelayedError
}

/** Upload an image to S3 and generate a thumbnail. Returns { s3Key, thumbnailS3Key }. */
async function uploadImageToS3(
  url: string,
  userIdStr: string,
  keySuffix: string,
  contentTypeHint?: string,
  filenameHint?: string,
): Promise<{ s3Key: string | null; thumbnailS3Key: string | null; buffer: Buffer | null }> {
  const isSvg = filenameHint?.endsWith(".svg") ?? false;
  const resolvedContentType = isSvg
    ? "image/svg+xml"
    : (contentTypeHint ?? sectionMeta("image").contentType);
  const resolvedExt = isSvg
    ? "svg"
    : (resolvedContentType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg");

  let imageBuffer: Buffer | null = null;
  try {
    // 3 попытки — провайдер-CDN'ы (fal/replicate/kie/evolink) иногда блипуют
    // 404/5xx, разовые сетевые проблемы покрываются inner-retry без burning'а
    // BullMQ attempt'а. На all-fail оставляем silent fallthrough — Stage 3
    // (resolveTelegramSource) попробует ещё раз для отправки.
    imageBuffer = await withRetry("image.fetchBuffer", 3, async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
  } catch (e) {
    logger.error({ reason: e }, "Could not fetch image buffer");
  }

  const key = buildS3Key("image", userIdStr, keySuffix, resolvedExt);
  const s3Key = imageBuffer
    ? await uploadBuffer(key, imageBuffer, resolvedContentType).catch((reason) => {
        logger.error({ reason }, "Could not upload image buffer");
        return null;
      })
    : null;

  let thumbnailS3Key: string | null = null;
  if (imageBuffer && s3Key) {
    const thumbBuf = await generateThumbnail(imageBuffer, resolvedContentType);
    if (thumbBuf) {
      thumbnailS3Key = await uploadBuffer(buildThumbnailKey(s3Key), thumbBuf, "image/webp").catch(
        () => null,
      );
    }
  }

  return { s3Key, thumbnailS3Key, buffer: imageBuffer };
}

export async function processImageJob(job: Job<ImageJobData>, token?: string): Promise<void> {
  const {
    dbJobId,
    userId: userIdStr,
    modelId,
    prompt,
    negativePrompt,
    telegramChatId,
    dialogId,
    aspectRatio,
    modelSettings,
    promptMessageId,
  } = job.data;

  const stage = job.data.stage ?? "generate";

  /**
   * Делает результат генерации reply'ем на исходное сообщение пользователя
   * (текст/голос/фото-с-caption), чтобы он понимал, какому запросу принадлежит
   * результат. `allow_sending_without_reply: true` — на случай, если юзер
   * удалил исходный промпт, чтобы не падать при отправке.
   */
  const replyToPrompt = promptMessageId
    ? {
        reply_parameters: {
          message_id: promptMessageId,
          allow_sending_without_reply: true,
        },
      }
    : undefined;

  logger.info({ dbJobId, modelId, stage }, "Processing image job");

  const userLang = (await db.user
    .findUnique({ where: { id: BigInt(userIdStr) }, select: { language: true } })
    .then((u) => u?.language ?? "ru")) as Parameters<typeof getT>[0];
  const t = getT(userLang);
  const modelMeta = AI_MODELS[modelId];
  const modelName = modelMeta?.name ?? modelId;

  // Fallback-кандидаты: уже отфильтрованные по media-режиму задачи (если у
  // задачи есть, например, edit slots — fallback должен их поддерживать).
  const fallbackCandidates: AIModel[] = modelMeta
    ? getFallbackCandidates(modelId, "design").filter((m) =>
        isFallbackCompatible(m, job.data.mediaInputs),
      )
    : [];

  /** Подобрать AIModel по provider строке (primary или один из fallback'ов). */
  const findModelByProvider = (provider: string): AIModel | undefined => {
    if (modelMeta?.provider === provider) return modelMeta;
    return fallbackCandidates.find((m) => m.provider === provider);
  };

  // ── Virtual batch detection ─────────────────────────────────────────────
  // Если модель — single-only (`nativeBatchMax === 1`) и у неё задан
  // `maxVirtualBatch > 1`, юзер мог попросить N=2..4 картинок. Воркер делает
  // N последовательных submit'ов с разнесением во времени, а в финале склеивает
  // в один mediaGroup. Если все возвращают 1 image — и `n === 1` — это просто
  // обычная single-flow, в которой `isVirtualBatch === false`.
  const requestedN = job.data.numImages ?? 1;
  const nativeBatchMax = modelMeta?.nativeBatchMax ?? 1;
  const isVirtualBatch = requestedN > 1 && nativeBatchMax === 1;
  const SUB_STAGGER_MIN_MS = 12_000;
  const SUB_STAGGER_JITTER_MS = 3_000;

  // Накопленные ошибки sub-job'ов — выводятся юзеру в footer-сообщении
  // после mediaGroup (либо одиночным сообщением при K=0).
  const batchErrors: string[] = [];
  // User-facing подмножество batchErrors: только те ошибки, где юзер виноват
  // (resolved.isUserFacing === true в resolveSubJobError). Используется в
  // K=0-ветке Stage 3: если есть user-facing ошибки → юзеру понятное сообщение
  // что фиксить (content policy / prompt rejected / etc.), иначе — рандомный
  // «модель отдыхает» через pickGenerationFailedMessage.
  // Сигнал: на каждом push-point если `s.errorRaw` undefined → ошибка
  // user-facing (см. resolveSubJobError: errorRaw записывается ТОЛЬКО для
  // не-user-facing технических ошибок).
  const userFacingBatchErrors: string[] = [];

  try {
    const existingJob = await db.generationJob.findUnique({
      where: { id: dbJobId },
      select: {
        providerJobId: true,
        providerKeyId: true,
        status: true,
        inputData: true,
        outputs: { orderBy: { index: "asc" as const } },
      },
    });

    /** Прочитать текущее состояние virtual batch из inputData. */
    const readBatchState = (): VirtualBatchState => {
      const raw = (existingJob?.inputData as Record<string, unknown> | null | undefined)?.batch as
        | { n?: number; subJobs?: VirtualBatchSubJob[] }
        | undefined;
      const n = raw?.n ?? requestedN;
      const subJobs = Array.isArray(raw?.subJobs) ? [...raw!.subJobs!] : [];
      while (subJobs.length < n) subJobs.push({ status: "pending" });
      return { n, subJobs };
    };

    /** Записать обновлённое состояние virtual batch в inputData (мерджится с существующим). */
    const writeBatchState = async (state: VirtualBatchState): Promise<void> => {
      const current = await db.generationJob.findUnique({
        where: { id: dbJobId },
        select: { inputData: true },
      });
      const merged = {
        ...((current?.inputData as Record<string, unknown> | null | undefined) ?? {}),
        batch: { n: state.n, subJobs: state.subJobs },
      };
      // Prisma's InputJsonValue is structural; через unknown-cast снимаем type-mismatch
      // (VirtualBatchSubJob[] не наследует index-signature, хотя по содержанию валиден).
      await db.generationJob.update({
        where: { id: dbJobId },
        data: { inputData: merged as unknown as Prisma.InputJsonValue },
      });
      // Также обновляем in-memory snapshot, чтобы readBatchState() сразу видел новое.
      if (existingJob) {
        (existingJob.inputData as unknown) = merged;
      }
    };

    /** Прочитать текущее fallback-state из inputData. */
    const readFallbackState = (): FallbackState => {
      const raw = (existingJob?.inputData as Record<string, unknown> | null | undefined)
        ?.fallback as FallbackState | undefined;
      return {
        primaryProvider: modelMeta?.provider ?? "",
        ...(raw ?? {}),
      };
    };

    /** Записать обновлённое fallback-state в inputData (мерджится). */
    const writeFallbackState = async (next: FallbackState): Promise<void> => {
      const current = await db.generationJob.findUnique({
        where: { id: dbJobId },
        select: { inputData: true },
      });
      const merged = {
        ...((current?.inputData as Record<string, unknown> | null | undefined) ?? {}),
        fallback: next,
      };
      await db.generationJob.update({
        where: { id: dbJobId },
        data: { inputData: merged as unknown as Prisma.InputJsonValue },
      });
      if (existingJob) {
        (existingJob.inputData as unknown) = merged;
      }
    };

    // Output records created during finalization — used for buttons in Stage 3
    let outputRecords: Array<{ id: string; outputUrl: string | null; s3Key: string | null }> = [];
    let deductResult: DeductResult | undefined;

    // Finalizes a set of generated image results: uploads to S3, creates
    // output records, marks the job done and deducts tokens. Shared between
    // the sync-adapter path (Stage 1) and the async-adapter poll path (Stage 2).
    //
    // Returns `true` if THIS run owns the finalization (status transitioned
    // pending/processing → done). Returns `false` if another handler beat us
    // to it (stalled-redelivery race) — caller should skip the user-facing
    // send to avoid duplicate messages.
    //
    // Для virtual batch: `chargeMultiplier` = K (count успешных sub-job'ов).
    // Списываем `perImageCost × K`, не `perImageCost × 1`. По умолчанию 1 — для
    // single-output и для native-batch, где базовый расчёт уже корректен.
    const finalizeResults = async (
      imageResults: ImageResult[],
      options: { chargeMultiplier?: number } = {},
    ): Promise<boolean> => {
      const chargeMultiplier = options.chargeMultiplier ?? 1;
      for (let i = 0; i < imageResults.length; i++) {
        const ir = imageResults[i];
        const keySuffix = imageResults.length > 1 ? `${dbJobId}_${i + 1}` : dbJobId;
        let s3Key: string | null;
        let thumbnailS3Key: string | null;

        if (ir.base64Data) {
          // gpt-image returns raw base64 — decode and upload directly.
          const ext = ir.filename?.split(".").pop() ?? "png";
          const contentType =
            ir.contentType ??
            (ext === "webp" ? "image/webp" : ext === "jpg" ? "image/jpeg" : "image/png");
          const key = buildS3Key("image", userIdStr, keySuffix, ext);
          const buffer = Buffer.from(ir.base64Data, "base64");
          s3Key = await uploadBuffer(key, buffer, contentType).catch(() => null);
          thumbnailS3Key = null;
          if (s3Key) {
            const thumbBuf = await generateThumbnail(buffer, contentType);
            if (thumbBuf) {
              thumbnailS3Key = await uploadBuffer(
                buildThumbnailKey(s3Key),
                thumbBuf,
                "image/webp",
              ).catch(() => null);
            }
          }
        } else {
          const up = await uploadImageToS3(
            ir.url,
            userIdStr,
            keySuffix,
            ir.contentType,
            ir.filename,
          );
          s3Key = up.s3Key;
          thumbnailS3Key = up.thumbnailS3Key;
        }

        try {
          const output = await db.generationJobOutput.create({
            data: { jobId: dbJobId, index: i, outputUrl: ir.url, s3Key, thumbnailS3Key },
          });
          outputRecords.push({ id: output.id, outputUrl: ir.url, s3Key });
        } catch (err) {
          if (isUniqueViolation(err)) {
            // Stalled-redelivery race: another runner wrote outputs[i] first.
            // They're ahead — bail without atomic update or deduct.
            logger.info(
              { dbJobId, index: i },
              "finalizeResults: duplicate output detected — another runner is finalizing",
            );
            return false;
          }
          throw err;
        }
      }

      // Atomic transition: only one runner wins. After Redis wipe + recovery,
      // a stalled-redelivered handler may race here — the loser sees count=0
      // and bails so we don't double-deduct or duplicate the user-send.
      const updated = await db.generationJob.updateMany({
        where: { id: dbJobId, status: { in: ["pending", "processing"] } },
        data: { status: "done", completedAt: new Date() },
      });
      if (updated.count === 0) {
        logger.info({ dbJobId }, "finalizeResults: job already done by another runner");
        return false;
      }

      // Billing — use first image for megapixel calculation.
      const firstResult = imageResults[0];
      const model = AI_MODELS[modelId];
      if (!model) return true;

      const megapixels =
        model.costUsdPerMPixel && firstResult.width && firstResult.height
          ? (firstResult.width * firstResult.height) / 1_000_000
          : undefined;

      const editUrls: string[] =
        (job.data.mediaInputs as Record<string, string[]> | undefined)?.edit ?? [];
      const legacyUrl = job.data.sourceImageUrl;
      const inputUrls: string[] = editUrls.length > 0 ? editUrls : legacyUrl ? [legacyUrl] : [];
      const hasInputImage = inputUrls.length > 0;
      let inputImagesMegapixels: number[] | undefined;
      if (hasInputImage && model.costUsdPerMPixelInput && !model.costUsdPerMPixelInputFixed) {
        inputImagesMegapixels = (
          await Promise.all(inputUrls.map((u) => measureImageMegapixels(u).catch(() => 0)))
        ).filter((mp) => mp > 0);
      } else if (hasInputImage && model.costUsdPerMPixelInputFixed) {
        inputImagesMegapixels = inputUrls.map(() => 1);
      }

      // Adapter-supplied cost (e.g. gpt-image, which sums text + image input +
      // output tokens from OpenAI usage) wins over the matrix lookup, since
      // the matrix only covers per-image output cost.
      //
      // ВАЖНО: при fallback'е игнорируем adapter cost — иначе пользователь
      // мог бы переплатить по более дорогой схеме fallback провайдера. Цена
      // всегда по primary (см. план fallback'а).
      //
      // Detection: для single-shot читаем `inputData.fallback.effectiveProvider`,
      // для virtual batch — derive из `subJobs[*].effectiveProvider` (см. A4
      // в audit'е: lockedProvider не хранится отдельно во избежание race'ов).
      const fbState = readFallbackState();
      const { usedFallback } = detectUsedFallback({
        fallbackState: fbState,
        batchState: isVirtualBatch ? readBatchState() : undefined,
        isVirtualBatch,
        primaryProvider: model.provider,
      });
      const adapterUsdCost = usedFallback ? undefined : firstResult.providerUsdCost;
      const perImageInternalCost =
        adapterUsdCost !== undefined
          ? usdToTokens(adapterUsdCost)
          : calculateCost(model, 0, 0, megapixels, undefined, modelSettings, undefined, undefined, {
              hasInputImage,
              inputImagesMegapixels,
            });
      // chargeMultiplier > 1 — virtual batch: было K успешных sub-job'ов,
      // каждый стоил perImageInternalCost. БЕЗ округления — для текстовых
      // моделей (которые сюда не ходят, но соблюдаем единый contract) одно
      // сообщение может стоить дробно; deductTokens принимает float.
      const internalCost = perImageInternalCost * chargeMultiplier;

      // Audit-метаданные: фактический provider и сырая USD-цена по нему. При
      // fallback'е находим actual model среди кандидатов (тот же modelId, другой
      // provider). actualCostUsd считаем по ней БЕЗ pricing-коэффициентов.
      const activeProvider = usedFallback
        ? (fbState?.effectiveProvider ?? model.provider)
        : model.provider;
      const activeModel =
        activeProvider === model.provider
          ? model
          : (getFallbackCandidates(modelId, "design").find((m) => m.provider === activeProvider) ??
            model);
      const actualCostUsd =
        calculateProviderCostUsd(
          activeModel,
          0,
          0,
          megapixels,
          undefined,
          modelSettings,
          undefined,
          undefined,
          { hasInputImage, inputImagesMegapixels },
        ) * chargeMultiplier;

      deductResult = await deductTokens(
        BigInt(userIdStr),
        internalCost,
        modelId,
        undefined,
        undefined,
        {
          actualProvider: activeProvider,
          actualCostUsd,
        },
      );
      await db.generationJob.update({
        where: { id: dbJobId },
        data: { tokensSpent: internalCost },
      });
      return true;
    };

    if (existingJob?.outputs?.length) {
      // Stage 3 already done — skip submit + poll (crash-recovery fast path).
      // Atomic transition: if status is still pending/processing we won the race
      // (handler crashed mid-finalize, this run delivers the result + closes
      // the row). If count=0 the previous handler already finished — skip the
      // duplicate user-send entirely.
      const updated = await db.generationJob.updateMany({
        where: { id: dbJobId, status: { in: ["pending", "processing"] } },
        data: { status: "done", completedAt: new Date() },
      });
      if (updated.count === 0) {
        logger.info({ dbJobId }, "Generation already done, skipping duplicate send");
        return;
      }
      logger.warn(
        { dbJobId },
        "Resumed mid-finalize generation: re-sending result to user (tokens NOT deducted — cost context lost)",
      );
      outputRecords = existingJob.outputs;
      // Если это был virtual batch с partial success — подгружаем ошибки из
      // inputData.batch.subJobs, чтобы Stage 3 показал footer.
      if (isVirtualBatch) {
        const state = readBatchState();
        for (const s of state.subJobs) {
          if (s.status === "failed" && s.error) {
            batchErrors.push(s.error);
            if (!s.errorRaw) userFacingBatchErrors.push(s.error);
          }
        }
      }
    } else if (stage === "generate") {
      // ── Stage 1: submit (or sync-generate) ─────────────────────────────
      await db.generationJob.update({
        where: { id: dbJobId },
        data: { status: "processing" },
      });

      const effectivePrompt = await translatePromptIfNeeded(
        prompt,
        modelSettings,
        BigInt(userIdStr),
        modelId,
      );

      // ── Virtual batch path ──────────────────────────────────────────────
      // Делаем N последовательных submit'ов с разнесением 12-15s между ними.
      // Для sync-адаптеров — collect results inline; для async — записываем
      // providerJobId каждого sub-job в inputData.batch и идём в poll-стадию.
      // Skip-на-failure: 429/PoolExhausted/generic от одного sub-job не обрывают
      // батч, помечают только этот sub-job как failed и продолжаем.
      if (isVirtualBatch) {
        if (!modelMeta) throw new Error(`Unknown image model: ${modelId}`);
        const state = readBatchState();
        // Пробегаем по sub-job'ам в порядке индекса. Уже sub-job с providerJobId
        // или терминальным статусом — restart-recovery, пропускаем.
        for (let i = 0; i < state.n; i++) {
          const sub = state.subJobs[i];
          if (sub.status !== "pending" || sub.providerJobId || sub.result) continue;

          // Stagger между NEW submit'ами (не первый и не следующий за пропущенным).
          // Кладём паузу ПЕРЕД текущим, кроме первого свежего.
          const isFirstFresh = !state.subJobs
            .slice(0, i)
            .some(
              (p) =>
                p.providerJobId !== undefined || p.result !== undefined || p.status === "failed",
            );
          if (!isFirstFresh) {
            await new Promise((r) =>
              setTimeout(r, SUB_STAGGER_MIN_MS + Math.floor(Math.random() * SUB_STAGGER_JITTER_MS)),
            );
          }

          // Sticky: если в batch уже есть sub-job с известным effectiveProvider
          // (succeeded ИЛИ pending с providerJobId), все остальные sub-jobs идут
          // на этот же provider. Derive из subJobs — без отдельного хранения,
          // чтобы избежать race'а между writeBatchState и writeFallbackState.
          const lockedProvider = deriveLockedProvider(state.subJobs, i);

          const subCandidates: AIModel[] = lockedProvider
            ? (() => {
                const m = findModelByProvider(lockedProvider);
                return m ? [m] : [];
              })()
            : [modelMeta, ...fallbackCandidates];

          if (subCandidates.length === 0) {
            const synth = new Error(`Locked provider ${lockedProvider} not found`);
            const resolved = resolveSubJobError(synth, t, modelName);
            state.subJobs[i] = {
              status: "failed",
              error: resolved.userText,
              errorRaw: resolved.isUserFacing ? undefined : resolved.rawText,
              errorCode: resolved.errorCode,
            };
            await writeBatchState(state);
            continue;
          }

          // Per-sub-job candidate loop. На каждом кандидате:
          // - pre-check long-cooldown маркер → skip
          // - acquireKey → PoolExhausted skip, прочее throw
          // - submit:
          //   • success → mark sub-job succeeded, выходим из loop'а
          //   • short 429 / non-rate-limit / 5xx-without-allow → mark sub-job
          //     failed, выходим (НЕ ходим к следующему кандидату — это не
          //     "недоступность primary", это локальная проблема одного запроса)
          //   • long-window 429 / 5xx (allowFiveXxFallback) → continue к следующему
          //     кандидату
          // Если sticky locked — кандидат всего один, при failure sub-job просто
          // помечается failed (строгий sticky).
          const allowFiveXxFallback = job.attemptsMade >= 2;
          let subSettled = false;
          let lastSubError = "";
          // Сырая ошибка с последнего candidate — нужна чтобы при failure
          // sub-job'а резолвить user-facing message (UserFacingError, FAL/HeyGen
          // helpers, AI-classified). Synthetic-кейсы (pool exhausted /
          // long cooldown) оставляют lastSubErr = null, и финализатор
          // подставит generic шаблон t.errors.generationFailed.
          let lastSubErr: unknown = null;

          for (const candidate of subCandidates) {
            const candidateProvider = candidate.provider;
            const candidateKeyProvider = resolveKeyProviderForModel(candidate);

            if (await isProviderInLongCooldown(candidateKeyProvider).catch(() => false)) {
              lastSubError = `${candidateProvider} in long cooldown`;
              continue;
            }

            let subAcquired: Awaited<ReturnType<typeof acquireKey>>;
            try {
              subAcquired = await acquireKey(candidateKeyProvider);
            } catch (e) {
              if (isPoolExhaustedError(e)) {
                lastSubError = `${candidateProvider} pool exhausted`;
                continue;
              }
              throw e;
            }

            const subAdapter = createImageAdapter(candidate, subAcquired);
            try {
              if (!subAdapter.isAsync && subAdapter.generate) {
                const r = await subAdapter.generate({
                  prompt: effectivePrompt,
                  negativePrompt,
                  imageUrl: job.data.sourceImageUrl,
                  mediaInputs: job.data.mediaInputs,
                  aspectRatio,
                  modelSettings,
                });
                const result = Array.isArray(r) ? r[0] : r;
                state.subJobs[i] = {
                  status: "succeeded",
                  providerKeyId: subAcquired.keyId,
                  effectiveProvider: candidateProvider,
                  result,
                };
              } else if (subAdapter.submit) {
                const providerJobId = await subAdapter.submit({
                  prompt: effectivePrompt,
                  negativePrompt,
                  imageUrl: job.data.sourceImageUrl,
                  mediaInputs: job.data.mediaInputs,
                  aspectRatio,
                  modelSettings,
                });
                state.subJobs[i] = {
                  status: "pending",
                  providerJobId,
                  providerKeyId: subAcquired.keyId,
                  effectiveProvider: candidateProvider,
                };
              } else {
                throw new Error(`Adapter ${modelId} has no generate()/submit()`);
              }
              if (subAcquired.keyId) void recordSuccess(subAcquired.keyId);
              subSettled = true;
              break;
            } catch (err) {
              lastSubErr = err;
              const cls = classifyRateLimit(err, candidateKeyProvider);
              const message = err instanceof Error ? err.message : String(err);
              if (cls.isRateLimit) {
                if (subAcquired.keyId) {
                  void markRateLimited(subAcquired.keyId, cls.cooldownMs, cls.reason);
                }
                const isLong = cls.isLongWindow || cls.cooldownMs > LONG_WINDOW_THRESHOLD_MS;
                if (isLong) {
                  void markProviderLongCooldown(candidateKeyProvider, cls.cooldownMs, cls.reason);
                  void notifyRateLimit({
                    section: "image",
                    modelId,
                    cooldownMs: cls.cooldownMs,
                    reason: cls.reason,
                    isLongWindow: true,
                    err,
                    jobId: dbJobId,
                  });
                  lastSubError = `long-window: ${message.slice(0, 200)}`;
                  continue; // → следующий кандидат (long-window триггерит fallback)
                }
                // Short-window 429 — НЕ fallback, mark sub-job failed.
                void notifyRateLimit({
                  section: "image",
                  modelId,
                  cooldownMs: cls.cooldownMs,
                  reason: cls.reason,
                  isLongWindow: false,
                  err,
                  jobId: dbJobId,
                });
                lastSubError = `rate-limit: ${message.slice(0, 200)}`;
                break;
              }
              if (isFiveXxError(err) && allowFiveXxFallback) {
                if (subAcquired.keyId) void recordError(subAcquired.keyId, message.slice(0, 500));
                lastSubError = `5xx: ${message.slice(0, 200)}`;
                continue; // → следующий кандидат (persistent 5xx триггерит fallback)
              }
              if (isFiveXxError(err)) {
                // Transient 5xx на ранней попытке — пробрасываем наверх: BullMQ
                // ретраит, sub-job остаётся pending (без providerJobId) и будет
                // переподан заново. Зеркалит поведение submitWithFallback.
                if (subAcquired.keyId) void recordError(subAcquired.keyId, message.slice(0, 500));
                throw err;
              }
              if (subAcquired.keyId) void recordError(subAcquired.keyId, message.slice(0, 500));
              lastSubError = message.slice(0, 200);
              break;
            }
          }

          if (!subSettled) {
            // Если был реальный err от submit'а — резолвим через user-facing
            // mapping. Если все candidate'ы skip'нулись (pool exhausted /
            // long cooldown) — synthetic Error → generic шаблон.
            const errToResolve =
              lastSubErr ?? new Error(lastSubError || "Pool exhausted: no provider keys available");
            const resolved = resolveSubJobError(errToResolve, t, modelName);
            state.subJobs[i] = {
              status: "failed",
              error: resolved.userText,
              errorRaw: resolved.isUserFacing ? undefined : resolved.rawText,
              errorCode: resolved.errorCode,
            };
          }
          await writeBatchState(state);
        }

        // Submit-loop done. Decide: finalize if all sync (no pending), else poll.
        const stillPending = state.subJobs.some((s) => s.status === "pending");
        if (!stillPending) {
          // Все sync или все failed. Собираем successes и финализируем.
          const successResults: ImageResult[] = [];
          const techRawErrors: string[] = [];
          for (const s of state.subJobs) {
            if (s.status === "succeeded" && s.result) successResults.push(s.result);
            else if (s.status === "failed" && s.error) {
              batchErrors.push(s.error);
              if (s.errorRaw) techRawErrors.push(s.errorRaw);
              else userFacingBatchErrors.push(s.error);
            }
          }
          // Один alert на batch со списком всех unknown/tech-ошибок sub-job'ов
          // (mirror'ит single-shot notifyTechError на финальной попытке).
          // Structured-report содержит per-sub-job: index, provider, fallback-маркер,
          // полный error message + cause-chain.
          if (techRawErrors.length > 0) {
            const report = formatSubJobErrorReport(
              state.subJobs,
              "submit",
              modelMeta?.provider ?? "unknown",
            );
            await notifyTechError(new Error(report), {
              jobId: dbJobId,
              modelId,
              section: "image",
              userId: userIdStr,
              attempt: job.attemptsMade,
              partialSuccess: successResults.length > 0,
            });
          }
          if (successResults.length === 0) {
            // K=0 — все провалились. Перед mark-failed пробуем fallback re-submit:
            // если все ошибки transient (KIE 5xx / 422 task-id-blank) и есть
            // запасной провайдер — delayJob throw'ит DelayedError, переходим
            // на fallback. Иначе возвращается false и продолжаем mark-failed.
            await tryVirtualBatchFallbackResubmit({
              job,
              dbJobId,
              modelId,
              modelMeta,
              state,
              techRawErrors,
              userIdStr,
              token,
              stage: "submit",
            });
            await db.generationJob.update({
              where: { id: dbJobId },
              data: {
                status: "failed",
                error: batchErrors.join("; ").slice(0, 1000),
                errorCode: pickBatchErrorCode(state.subJobs),
              },
            });
            // outputRecords остаётся пустым; Stage 3 обработает K=0 по footer-ветке.
          } else {
            if (
              !(await finalizeResults(successResults, { chargeMultiplier: successResults.length }))
            )
              return;
          }
        } else {
          // Есть async sub-job'ы → schedule poll.
          logger.info(
            {
              dbJobId,
              n: state.n,
              pending: state.subJobs.filter((s) => s.status === "pending").length,
            },
            "Virtual batch poll scheduled",
          );
          await delayJob(
            job,
            {
              ...job.data,
              stage: "poll",
              pollStartedAt: Date.now(),
              lastIntervalMs: INITIAL_POLL_INTERVAL_MS,
            },
            INITIAL_POLL_INTERVAL_MS,
            token,
          );
          return;
        }
        // Fall-through to Stage 3 (sync VB или K=0).
      } else {
        // ── Single-shot path (не virtual batch) ─────────────────────────────
        if (!modelMeta) throw new Error(`Unknown image model: ${modelId}`);

        // Sync vs async — определяется на primary; fallback'и того же режима.
        const isAsync = createImageAdapter(modelMeta).isAsync;

        if (!isAsync) {
          // Sync adapter (DALL-E, gpt-image, recraft) — generate inline, then finalize.
          // Если приехали после poll-stage re-submit'а — attemptedProviders уже
          // содержит primary, передаём в skipProviders.
          const prevFallbackStateSync = readFallbackState();
          const skipProvidersSync =
            prevFallbackStateSync.attemptedProviders &&
            prevFallbackStateSync.attemptedProviders.length > 0
              ? new Set(prevFallbackStateSync.attemptedProviders)
              : undefined;
          const fbResult = await submitWithFallback<ImageResult | ImageResult[], ImageJobData>({
            primaryModel: modelMeta,
            fallbacks: fallbackCandidates,
            section: "image",
            job,
            token,
            allowFiveXxFallback: job.attemptsMade >= 2,
            jobId: dbJobId,
            userId: userIdStr,
            skipProviders: skipProvidersSync,
            submit: async (model, acquired) => {
              const adapter = createImageAdapter(model, acquired);
              if (!adapter.generate) {
                throw new Error(`Adapter ${model.id} (${model.provider}) has no generate()`);
              }
              return adapter.generate({
                prompt: effectivePrompt,
                negativePrompt,
                imageUrl: job.data.sourceImageUrl,
                mediaInputs: job.data.mediaInputs,
                aspectRatio,
                modelSettings,
              });
            },
          });

          const accumulatedSync = new Set([
            ...(prevFallbackStateSync.attemptedProviders ?? []),
            ...fbResult.attempts.map((a) => a.provider),
          ]);
          await writeFallbackState({
            primaryProvider: modelMeta.provider,
            effectiveProvider: fbResult.effectiveProvider,
            attemptedProviders: Array.from(accumulatedSync),
          });

          const imageResults: ImageResult[] = Array.isArray(fbResult.result)
            ? fbResult.result
            : [fbResult.result];
          // Native batch: для моделей где провайдер биллит per-output (Midjourney
          // через Replicate с num_outputs > 1) — умножаем cost на K. Для KIE
          // и подобных провайдеров с per-call биллингом флаг не задан → K не применим.
          const nativeBatchCharge =
            modelMeta.chargePerOutput && imageResults.length > 1 ? imageResults.length : undefined;
          if (
            !(await finalizeResults(
              imageResults,
              nativeBatchCharge ? { chargeMultiplier: nativeBatchCharge } : {},
            ))
          )
            return;
        } else {
          // Async adapter — submit then schedule poll.
          let providerJobId: string;

          if (existingJob?.providerJobId) {
            providerJobId = existingJob.providerJobId;
            logger.info({ dbJobId, providerJobId }, "Resuming poll for existing provider job");
          } else {
            const prevFallbackStateAsync = readFallbackState();
            const skipProvidersAsync =
              prevFallbackStateAsync.attemptedProviders &&
              prevFallbackStateAsync.attemptedProviders.length > 0
                ? new Set(prevFallbackStateAsync.attemptedProviders)
                : undefined;
            const fbResult = await submitWithFallback<string, ImageJobData>({
              primaryModel: modelMeta,
              fallbacks: fallbackCandidates,
              section: "image",
              job,
              token,
              allowFiveXxFallback: job.attemptsMade >= 2,
              jobId: dbJobId,
              userId: userIdStr,
              skipProviders: skipProvidersAsync,
              submit: async (model, acquired) => {
                const adapter = createImageAdapter(model, acquired);
                if (!adapter.submit) {
                  throw new Error(`Adapter ${model.id} (${model.provider}) has no submit()`);
                }
                return adapter.submit({
                  prompt: effectivePrompt,
                  negativePrompt,
                  imageUrl: job.data.sourceImageUrl,
                  mediaInputs: job.data.mediaInputs,
                  aspectRatio,
                  modelSettings,
                });
              },
            });
            providerJobId = fbResult.result;

            const accumulatedAsync = new Set([
              ...(prevFallbackStateAsync.attemptedProviders ?? []),
              ...fbResult.attempts.map((a) => a.provider),
            ]);
            await writeFallbackState({
              primaryProvider: modelMeta.provider,
              effectiveProvider: fbResult.effectiveProvider,
              attemptedProviders: Array.from(accumulatedAsync),
            });
            await db.generationJob.update({
              where: { id: dbJobId },
              data: {
                providerJobId,
                providerKeyId: fbResult.acquired.keyId,
                // Фиксируем момент перехода в poll-стадию: после Redis wipe
                // recovery восстановит таймер с этой точки, а не с нуля.
                pollStartedAt: new Date(),
              },
            });
          }

          logger.info({ dbJobId, providerJobId }, "Image poll scheduled");
          await delayJob(
            job,
            {
              ...job.data,
              stage: "poll",
              pollStartedAt: Date.now(),
              lastIntervalMs: INITIAL_POLL_INTERVAL_MS,
            },
            INITIAL_POLL_INTERVAL_MS,
            token,
          );
        }
      } // close `} else {` of single-shot path (virtual-batch branch above)
    } else {
      // ── Stage 2: poll ──────────────────────────────────────────────────
      if (isVirtualBatch) {
        // Параллельный poll всех pending sub-job'ов одной волной. Each sub-job
        // имеет собственный sticky `providerKeyId`, поэтому acquireForPoll даёт
        // тот же ключ что и при submit. Failure одного sub-job (включая timeout
        // или provider error) помечает только его, не валит весь батч.
        const state = readBatchState();
        const pendingIndices = state.subJobs
          .map((s, i) => (s.status === "pending" && s.providerJobId ? i : -1))
          .filter((i) => i >= 0);

        await Promise.all(
          pendingIndices.map(async (i) => {
            const sub = state.subJobs[i];
            try {
              // Подбираем модель / keyProvider по effectiveProvider sub-job'а.
              // Для legacy записей (effectiveProvider не выставлен) — primary.
              const effModel =
                (sub.effectiveProvider && findModelByProvider(sub.effectiveProvider)) || modelMeta;
              if (!effModel) throw new Error(`Unknown image model: ${modelId}`);
              const effKeyProvider = resolveKeyProviderForModel(effModel);
              const subAcquired = await acquireForPoll(sub.providerKeyId ?? null, effKeyProvider);
              const subAdapter = createImageAdapter(effModel, subAcquired);
              if (!subAdapter.poll) {
                const resolved = resolveSubJobError(
                  new Error(`Adapter ${modelId} has no poll()`),
                  t,
                  modelName,
                );
                state.subJobs[i] = {
                  ...sub,
                  status: "failed",
                  error: resolved.userText,
                  errorRaw: resolved.rawText,
                  errorCode: resolved.errorCode,
                };
                return;
              }
              const r = await subAdapter.poll(sub.providerJobId!);
              if (r === null) return; // ещё pending, оставляем как есть
              const result = Array.isArray(r) ? r[0] : r;
              state.subJobs[i] = { ...sub, status: "succeeded", result };
              if (sub.providerKeyId) void recordSuccess(sub.providerKeyId);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (sub.providerKeyId) void recordError(sub.providerKeyId, message.slice(0, 500));
              const resolved = resolveSubJobError(err, t, modelName);
              state.subJobs[i] = {
                ...sub,
                status: "failed",
                error: resolved.userText,
                errorRaw: resolved.isUserFacing ? undefined : resolved.rawText,
                errorCode: resolved.errorCode,
              };
            }
          }),
        );
        await writeBatchState(state);

        // Settled? — finalize. Иначе — schedule next poll-tick.
        const stillPending = state.subJobs.some((s) => s.status === "pending");
        if (stillPending) {
          const elapsed = Date.now() - (job.data.pollStartedAt ?? Date.now());
          const interval = getIntervalForElapsed(elapsed);
          if (interval === null) {
            // 24h timeout — fail batch entirely.
            await db.generationJob.update({
              where: { id: dbJobId },
              data: { status: "failed", error: "poll timeout (24h)", errorCode: POLL_TIMEOUT_CODE },
            });
            const timeoutMsg = t.errors.generationTimedOut24h.replace("{modelName}", modelName);
            if (telegramChatId !== null) {
              await telegram.sendMessage(telegramChatId, timeoutMsg).catch(() => void 0);
            } else {
              await apiNotifyError({
                section: "image",
                userId: userIdStr,
                dbJobId,
                userMessage: timeoutMsg,
                errorCode: POLL_TIMEOUT_CODE,
              }).catch(() => void 0);
            }
            throw new UnrecoverableError("poll timeout 24h");
          }
          await delayJob(
            job,
            { ...job.data, stage: "poll", lastIntervalMs: interval },
            interval,
            token,
          );
          return;
        }

        // All settled — собираем successes + errors.
        const successResults: ImageResult[] = [];
        const techRawErrors: string[] = [];
        for (const s of state.subJobs) {
          if (s.status === "succeeded" && s.result) successResults.push(s.result);
          else if (s.status === "failed" && s.error) {
            batchErrors.push(s.error);
            if (s.errorRaw) techRawErrors.push(s.errorRaw);
            else userFacingBatchErrors.push(s.error);
          }
        }
        if (techRawErrors.length > 0) {
          const report = formatSubJobErrorReport(
            state.subJobs,
            "poll",
            modelMeta?.provider ?? "unknown",
          );
          await notifyTechError(new Error(report), {
            jobId: dbJobId,
            modelId,
            section: "image",
            userId: userIdStr,
            attempt: job.attemptsMade,
            partialSuccess: successResults.length > 0,
          });
        }
        if (successResults.length === 0) {
          // K=0 — все провалились. См. tryVirtualBatchFallbackResubmit:
          // если transient KIE-ошибки и есть fallback — delayJob throw'ит,
          // job пере-enqueue на fallback провайдера. Иначе mark failed.
          await tryVirtualBatchFallbackResubmit({
            job,
            dbJobId,
            modelId,
            modelMeta,
            state,
            techRawErrors,
            userIdStr,
            token,
            stage: "poll",
          });
          await db.generationJob.update({
            where: { id: dbJobId },
            data: {
              status: "failed",
              error: batchErrors.join("; ").slice(0, 1000),
              errorCode: pickBatchErrorCode(state.subJobs),
            },
          });
        } else {
          if (!(await finalizeResults(successResults, { chargeMultiplier: successResults.length })))
            return;
        }
        // Fall-through to Stage 3 (footer + send).
      } else {
        // ── Single-shot poll path (не virtual batch) ────────────────────────
        const providerJobId = existingJob?.providerJobId;
        if (!providerJobId) throw new Error(`Image poll stage without providerJobId: ${dbJobId}`);

        // Если на submit-стадии случился fallback — используем его модель.
        const fbStateNow = readFallbackState();
        const effModel =
          (fbStateNow.effectiveProvider && findModelByProvider(fbStateNow.effectiveProvider)) ||
          modelMeta;
        if (!effModel) throw new Error(`Unknown image model: ${modelId}`);
        const effKeyProvider = resolveKeyProviderForModel(effModel);

        const acquired = await acquireForPoll(existingJob?.providerKeyId, effKeyProvider);
        const adapter = createImageAdapter(effModel, acquired);
        if (!adapter.poll) throw new Error(`Adapter ${modelId} has no poll()`);

        const pollResult = await adapter.poll(providerJobId);

        if (!pollResult) {
          // Not done yet — schedule the next poll with tiered interval.
          const elapsed = Date.now() - (job.data.pollStartedAt ?? Date.now());
          const interval = getIntervalForElapsed(elapsed);

          if (interval === null) {
            // 24 h hard cap — cancel and notify.
            await db.generationJob.update({
              where: { id: dbJobId },
              data: { status: "failed", error: "poll timeout (24h)", errorCode: POLL_TIMEOUT_CODE },
            });
            const timeoutMsg = t.errors.generationTimedOut24h.replace("{modelName}", modelName);
            if (telegramChatId !== null) {
              await telegram.sendMessage(telegramChatId, timeoutMsg).catch(() => void 0);
            } else {
              await apiNotifyError({
                section: "image",
                userId: userIdStr,
                dbJobId,
                userMessage: timeoutMsg,
                errorCode: POLL_TIMEOUT_CODE,
              }).catch(() => void 0);
            }
            throw new UnrecoverableError("poll timeout 24h");
          }

          if (job.data.lastIntervalMs !== undefined && interval !== job.data.lastIntervalMs) {
            // "still running" hint имеет смысл только в TG-чате; web-клиент видит статус processing напрямую.
            if (telegramChatId !== null) {
              await telegram
                .sendMessage(
                  telegramChatId,
                  t.errors.generationStillRunning.replace("{modelName}", modelName),
                )
                .catch(() => void 0);
            }
          }

          await delayJob(
            job,
            { ...job.data, stage: "poll", lastIntervalMs: interval },
            interval,
            token,
          );
          return; // unreachable — restores TS narrowing for pollResult
        }

        const imageResults: ImageResult[] = Array.isArray(pollResult) ? pollResult : [pollResult];
        // См. sync-adapter аналог выше — chargePerOutput для native batch
        // с per-image биллингом провайдера (Midjourney через Replicate).
        const nativeBatchCharge =
          modelMeta?.chargePerOutput && imageResults.length > 1 ? imageResults.length : undefined;
        if (
          !(await finalizeResults(
            imageResults,
            nativeBatchCharge ? { chargeMultiplier: nativeBatchCharge } : {},
          ))
        )
          return;
      }
    }

    // ── Stage 3: send to user ────────────────────────────────────────────
    const modelForCaption = AI_MODELS[modelId];
    const displayName = modelForCaption?.name ?? modelId;
    const buildCaption = (): string =>
      buildResultCaption(t, displayName, prompt, {
        cost: deductResult?.deducted,
        subscriptionBalance: deductResult?.subscriptionTokenBalance,
        tokenBalance: deductResult?.tokenBalance,
      });

    // K=0 для virtual batch — все sub-job'ы failed, mediaGroup нет, шлём
    // одно сообщение и выходим. Развилка по user-fault:
    //  - Если есть user-facing ошибка (content policy / unsupported image /
    //    invalid prompt и т.п.) → показываем юзеру эту ошибку, чтобы он
    //    понимал что нужно поправить. Берём первую — обычно root-cause
    //    одинаковый, дополнительные ошибки только засоряют экран.
    //  - Иначе (всё упало по нашей/инфра-стороне — KIE down, transient 5xx)
    //    → один из 3 рандомных «модель отдыхает» через
    //    pickGenerationFailedMessage. Юзер не виноват, ему нечего фиксить.
    // Per-sub-job детали в любом случае идут в ops через formatSubJobErrorReport.
    if (outputRecords.length === 0 && batchErrors.length > 0) {
      const text =
        userFacingBatchErrors.length > 0
          ? userFacingBatchErrors[0]!
          : pickGenerationFailedMessage(t, modelName, "design");
      if (telegramChatId !== null) {
        await telegram.sendMessage(telegramChatId, text).catch(() => void 0);
      } else {
        await apiNotifyError({
          section: "image",
          userId: userIdStr,
          dbJobId,
          userMessage: text,
        }).catch(() => void 0);
      }
      logger.info(
        {
          dbJobId,
          errors: batchErrors.length,
          userFacing: userFacingBatchErrors.length,
        },
        "Virtual batch all failed",
      );
      return;
    }

    // Batch: multiple outputs → send as media group
    if (outputRecords.length > 1) {
      if (telegramChatId !== null) {
        const mediaGroup: Array<{
          type: "photo";
          media: string | InstanceType<typeof InputFile>;
          caption?: string;
          parse_mode?: "HTML";
        }> = [];

        const batchCaption = buildCaption();
        const byteSizes: number[] = [];
        for (let i = 0; i < outputRecords.length; i++) {
          const rec = outputRecords[i];
          const filename = `image-${i + 1}.png`;
          const info = await resolveTelegramSource(rec.s3Key, rec.outputUrl ?? "");
          byteSizes.push(info.byteSize);
          const { source } = await prepareTelegramPhoto(info, rec.outputUrl ?? "", filename);
          mediaGroup.push({
            type: "photo",
            media: source,
            ...(i === 0 ? { caption: batchCaption, parse_mode: "HTML" as const } : {}),
          });
        }

        // 2 попытки — multipart upload в Telegram изредка падает на network
        // blip'ах. Single retry даёт безопасный второй шанс без double-send'а.
        await withRetry("image.sendMediaGroup", 2, () =>
          telegram.sendMediaGroup(telegramChatId, mediaGroup, replyToPrompt),
        );

        // Send a single message with refine + (orig|download) buttons for all outputs.
        // Per output: "{N}. 🔄" paired with "{N}. 📎" (≤50 MB) or "{N}. ⬇️" (>50 MB).
        {
          const buttons: InlineKeyboardButton[] = [];
          for (let i = 0; i < outputRecords.length; i++) {
            const rec = outputRecords[i];
            const n = i + 1;
            buttons.push({ text: `${n}. 🔄`, callback_data: `design_ref_${rec.id}` });
            if (byteSizes[i] <= TELEGRAM_DOC_MAX_BYTES) {
              buttons.push({ text: `${n}. 📎`, callback_data: `orig_${rec.id}` });
            } else if (rec.s3Key) {
              buttons.push(buildDownloadButton(`${n}. ⬇️`, rec.s3Key, userIdStr));
            }
          }
          // Layout: <3 pairs → 1 per row, even → 2 per row, odd → 3 per row
          const rows: InlineKeyboardButton[][] = [];
          const totalPairs = outputRecords.length;
          const pairsPerRow = totalPairs <= 3 ? 1 : totalPairs % 2 === 0 ? 2 : 3;
          const chunkSize = 2 * pairsPerRow;
          for (let i = 0; i < buttons.length; i += chunkSize) {
            rows.push(buttons.slice(i, i + chunkSize));
          }
          // Drop the "⬇️ Скачать" line from the legend when no output produced
          // a download button — happens whenever every photo fits under 50 MB
          // (the common case), so we don't tease a button the user can't see.
          const hasDownloadButton = buttons.some(
            (b) => "url" in b || ("web_app" in b && b.web_app !== undefined),
          );
          const hintText = hasDownloadButton
            ? t.design.batchActions
            : t.design.batchActionsNoDownload;
          await telegram.sendMessage(telegramChatId, hintText, {
            reply_markup: { inline_keyboard: rows },
          });
        }

        // Virtual-batch partial-success footer: K из N сгенерировано. Юзеру шлём
        // одно общее сообщение про неудавшиеся, не перечисляя per-sub-job (всё
        // равно один root-cause в 99% случаев — детали есть в ops alert).
        if (batchErrors.length > 0) {
          const errorMessage = t.design.batchSubJobFailedMessage.replace("{modelName}", modelName);
          const text = t.design.batchPartialFooter
            .replace("{success}", String(outputRecords.length))
            .replace("{total}", String(requestedN))
            .replace("{errors}", errorMessage);
          await telegram
            .sendMessage(telegramChatId, text)
            .catch((reason) => logger.warn(reason, "Could not send batch partial footer"));
        }
      } else {
        await apiNotifySuccess({
          section: "image",
          userId: userIdStr,
          dbJobId,
          outputs: outputRecords.map((r) => ({
            id: r.id,
            outputUrl: r.outputUrl ?? null,
            s3Key: r.s3Key ?? null,
          })),
          ...(batchErrors.length > 0
            ? { partial: { success: outputRecords.length, total: requestedN } }
            : {}),
        }).catch(() => void 0);
      }

      if (dialogId) {
        await db.message.create({
          data: { dialogId, role: "user", content: prompt, tokensUsed: 0 },
        });
        for (const rec of outputRecords) {
          await db.message.create({
            data: {
              dialogId,
              role: "assistant",
              content: "",
              mediaUrl: rec.outputUrl ?? "",
              mediaType: "image",
              tokensUsed: 0,
            },
          });
        }
      }

      logger.info({ dbJobId, batchSize: outputRecords.length }, "Image batch job completed");
      return;
    }

    // Single output path
    const rec = outputRecords[0];
    const outputUrl = rec?.outputUrl ?? "";
    const s3Key = rec?.s3Key ?? null;
    const outputId = rec?.id ?? dbJobId;

    const retryExt = s3Key?.split(".").pop() ?? "png";
    const finalImageResult = {
      url: outputUrl,
      filename: `${dbJobId}.${retryExt}`,
      contentType: `image/${retryExt}`,
    };
    if (dialogId) {
      const existingMsg = await db.message.findFirst({
        where: { dialogId, mediaUrl: outputUrl },
        select: { id: true },
      });
      if (!existingMsg) {
        await db.message.create({
          data: { dialogId, role: "user", content: prompt, tokensUsed: 0 },
        });
        await db.message.create({
          data: {
            dialogId,
            role: "assistant",
            content: "",
            mediaUrl: outputUrl,
            mediaType: "image",
            tokensUsed: 0,
          },
        });
      }
    }

    if (telegramChatId !== null) {
      const filename = finalImageResult.filename ?? "image.png";
      const info = await resolveTelegramSource(s3Key, finalImageResult.url);
      const { source: tgImageSource, isSvg } = await prepareTelegramPhoto(
        info,
        finalImageResult.url,
        filename,
      );

      const refineRow: InlineKeyboardButton[] = [
        { text: t.design.refine, callback_data: `design_ref_${outputId}` },
      ];
      const actionRow: InlineKeyboardButton[] | null =
        info.byteSize <= TELEGRAM_DOC_MAX_BYTES
          ? [{ text: t.common.sendOriginal, callback_data: `orig_${outputId}` }]
          : s3Key
            ? [buildDownloadButton(t.common.downloadFile, s3Key, userIdStr)]
            : null;
      const rows = [refineRow, actionRow].filter(Boolean) as InlineKeyboardButton[][];
      const replyMarkup = rows.length ? { inline_keyboard: rows } : undefined;

      const singleCaption = buildCaption();
      if (isSvg) {
        // 2 попытки — multipart upload в Telegram'е иногда падает на network
        // blip'ах. Single retry — безопасный второй шанс.
        await withRetry("image.sendDocument", 2, () =>
          telegram.sendDocument(telegramChatId, tgImageSource, {
            caption: singleCaption,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
            ...replyToPrompt,
          }),
        );
      } else {
        await withRetry("image.sendPhoto", 2, () =>
          telegram.sendPhoto(telegramChatId, tgImageSource, {
            caption: singleCaption,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
            ...replyToPrompt,
          }),
        );
      }

      // Virtual-batch partial-success c K=1 (один success + 1..3 failures).
      // К одиночному фото добавляем footer-сообщение с одним общим текстом
      // про неудавшиеся (mirror'ит mediaGroup-ветку выше, см. там комментарий).
      if (batchErrors.length > 0) {
        const errorMessage = t.design.batchSubJobFailedMessage.replace("{modelName}", modelName);
        const text = t.design.batchPartialFooter
          .replace("{success}", String(outputRecords.length))
          .replace("{total}", String(requestedN))
          .replace("{errors}", errorMessage);
        await telegram
          .sendMessage(telegramChatId, text)
          .catch((reason) => logger.warn(reason, "Could not send batch partial footer"));
      }
    } else {
      await apiNotifySuccess({
        section: "image",
        userId: userIdStr,
        dbJobId,
        outputs: [
          {
            id: outputId,
            outputUrl: outputUrl || null,
            s3Key: s3Key,
          },
        ],
        ...(batchErrors.length > 0
          ? { partial: { success: outputRecords.length, total: requestedN } }
          : {}),
      }).catch(() => void 0);
    }

    logger.info({ dbJobId }, "Image job completed");
  } catch (err) {
    if (err instanceof DelayedError) throw err;
    if (isRateLimitLongWindowError(err)) {
      const msg = pickGenerationFailedMessage(t, modelName, "design");
      await db.generationJob.update({
        where: { id: dbJobId },
        data: { status: "failed", error: msg, errorCode: "RATE_LIMIT_LONG" },
      });
      if (telegramChatId !== null) {
        await telegram.sendMessage(telegramChatId, msg).catch(() => void 0);
      } else {
        await apiNotifyError({
          section: "image",
          userId: userIdStr,
          dbJobId,
          userMessage: msg,
          errorCode: "RATE_LIMIT_LONG",
        }).catch(() => void 0);
      }
      throw new UnrecoverableError(msg);
    }
    // Provider-side rate-limit/overload (например KIE 422 "high demand") —
    // defer'им job на cooldownMs+jitter, BullMQ retry после паузы. Throws
    // DelayedError если rescheduled; returns silently если не rate-limit
    // или budget исчерпан → fall through. existingJob — closure внутри try,
    // здесь refetch'аем sticky providerKeyId (per-key throttle применится
    // на ближайший submit'е acquireKey'ем).
    const dbJobForRl = await db.generationJob
      .findUnique({ where: { id: dbJobId }, select: { providerKeyId: true } })
      .catch(() => null);

    // ── Poll-stage re-submit на per-account long-window 429 ─────────────
    // Провайдеры (KIE/evolink, Google и т.п.) иногда сообщают billing-quota
    // только в poll-ответе. Сама генерация ещё не выполнялась — кредиты
    // юзера не списаны (deductTokens вызывается на финализации после успеха).
    // Маркаем sticky-ключ как throttled и re-enqueue'им job на submit-стадию:
    // acquireKey priority-логикой возьмёт другой ключ из пула.
    if (stage === "poll" && dbJobForRl?.providerKeyId) {
      const cls = classifyRateLimit(err, modelMeta?.provider);
      if (cls.isRateLimit && cls.isLongWindow && cls.cooldownMs <= LONG_WINDOW_THRESHOLD_MS) {
        await markRateLimited(dbJobForRl.providerKeyId, cls.cooldownMs, cls.reason);
        logger.warn(
          {
            dbJobId,
            modelId,
            keyId: dbJobForRl.providerKeyId,
            cooldownMs: cls.cooldownMs,
            reason: cls.reason,
          },
          "Image poll: per-account long-window quota — re-enqueuing on submit stage with fresh key",
        );
        await db.generationJob.update({
          where: { id: dbJobId },
          data: { providerJobId: null, providerKeyId: null },
        });
        await delayJob(
          job,
          {
            ...job.data,
            stage: undefined,
            pollStartedAt: undefined,
            lastIntervalMs: undefined,
          },
          1000,
          token,
        );
      }
    }

    // ── Poll-stage re-submit на provider temporary unavailable ──────────
    // KIE 422 "high demand" / "service is currently unavailable" и т.п. —
    // узел провайдера перегружен; defer + retry на том же провайдере не помогает.
    // Если есть неиспользованный fallback-кандидат (другая модель/провайдер) —
    // переключаемся на него: чистим providerJobId/Key + добавляем текущий
    // effective в attemptedProviders + re-enqueue на submit-стадию. Submit
    // через skipProviders пропустит примари и возьмёт следующего кандидата.
    // Без fallback fall-through на rate-limit defer-цикл (legacy behavior).
    if (stage === "poll" && isProviderTemporaryUnavailable(err) && modelMeta) {
      const requestedN = job.data.numImages ?? 1;
      const isVirtualBatchNow = requestedN > 1 && (modelMeta?.nativeBatchMax ?? 1) === 1;
      if (!isVirtualBatchNow) {
        const dbJob = await db.generationJob.findUnique({
          where: { id: dbJobId },
          select: { inputData: true },
        });
        const inputData = (dbJob?.inputData as Record<string, unknown> | null | undefined) ?? {};
        const fbStateNow =
          (inputData.fallback as
            | { effectiveProvider?: string; attemptedProviders?: string[] }
            | undefined) ?? {};
        const currentEff = fbStateNow.effectiveProvider ?? modelMeta.provider;
        const alreadyAttempted = new Set(fbStateNow.attemptedProviders ?? []);
        alreadyAttempted.add(currentEff);

        const fallbackCandidatesNow = getFallbackCandidates(modelId, "design").filter((m) =>
          isFallbackCompatible(m, job.data.mediaInputs),
        );
        const nextCandidate = fallbackCandidatesNow.find((m) => !alreadyAttempted.has(m.provider));

        if (!nextCandidate) {
          logger.warn(
            {
              dbJobId,
              modelId,
              currentEff,
              attempted: Array.from(alreadyAttempted),
              registeredFallbacks: fallbackCandidatesNow.map((m) => m.provider),
              errMessage: err instanceof Error ? err.message : String(err),
            },
            "Image poll: provider temporary unavailable — fallback skipped (no eligible candidate)",
          );
        } else {
          logger.warn(
            { dbJobId, modelId, currentEff, next: nextCandidate.provider },
            "Image poll: provider temporary unavailable — re-enqueuing on fallback",
          );
          await notifyFallback({
            section: "image",
            modelId,
            primaryProvider: modelMeta.provider,
            fallbackProvider: nextCandidate.provider,
            reason: "persistent_5xx",
            jobId: dbJobId,
            userId: userIdStr,
          });

          const merged = {
            ...inputData,
            fallback: {
              primaryProvider: modelMeta.provider,
              attemptedProviders: Array.from(alreadyAttempted),
            },
          };
          await db.generationJob.update({
            where: { id: dbJobId },
            data: {
              providerJobId: null,
              providerKeyId: null,
              inputData: merged as unknown as Prisma.InputJsonValue,
            },
          });

          await delayJob(
            job,
            {
              ...job.data,
              stage: undefined,
              pollStartedAt: undefined,
              lastIntervalMs: undefined,
            },
            1000,
            token,
          );
        }
      }
    }

    await deferIfRateLimitOverload({
      err,
      job,
      token,
      section: "image",
      modelId,
      provider: modelMeta?.provider,
      keyId: dbJobForRl?.providerKeyId ?? null,
    });
    // Throws DelayedError if rescheduled (re-thrown by next iteration of catch).
    // Returns silently otherwise → fall through to user-facing failure handling.
    await deferIfTransientNetworkError({ err, job, token, section: "image" });
    const userMsg = resolveUserFacingMessage(err, t);
    if (userMsg !== null) {
      logger.warn({ dbJobId, err }, "Image job rejected: user-facing error");
      await db.generationJob.update({
        where: { id: dbJobId },
        data: { status: "failed", error: userMsg, errorCode: classifyError(err) },
      });
      if (shouldNotifyOps(err)) {
        await notifyTechError(err, {
          jobId: dbJobId,
          modelId,
          section: "image",
          userId: userIdStr,
          attempt: job.attemptsMade,
        });
      }
      if (telegramChatId !== null) {
        await telegram.sendMessage(telegramChatId, userMsg).catch(() => void 0);
      } else {
        await apiNotifyError({
          section: "image",
          userId: userIdStr,
          dbJobId,
          userMessage: userMsg,
          errorCode: classifyError(err),
        }).catch(() => void 0);
      }
      throw new UnrecoverableError(userMsg);
    }

    logger.error({ dbJobId, err }, "Image job failed");

    const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1) - 1;

    // ── Poll-stage fallback на KIE 5xx (single-shot path) ───────────────
    // KIE при 5xx terminal не перезапускает генерацию у себя. Если retry'и
    // BullMQ исчерпаны и есть неиспользованный fallback — пере-enqueue:
    // stage→generate, providerJobId→null, attemptedProviders ← +effective.
    // Virtual batch path тут не покрыт (там per-sub-job state'ы — отдельная
    // задача).
    if (stage === "poll" && isLastAttempt && isKieTransientError(err) && modelMeta) {
      const requestedN = job.data.numImages ?? 1;
      const isVirtualBatchNow = requestedN > 1 && (modelMeta?.nativeBatchMax ?? 1) === 1;
      // Virtual batch не покрыт — там per-sub-job state'ы, отдельная задача.
      if (!isVirtualBatchNow) {
        // readFallbackState/writeFallbackState — closures внутри try-блока.
        // В catch refetch'аем напрямую: получаем свежий inputData и мерджим.
        const dbJob = await db.generationJob.findUnique({
          where: { id: dbJobId },
          select: { inputData: true },
        });
        const inputData = (dbJob?.inputData as Record<string, unknown> | null | undefined) ?? {};
        const fbStateNow =
          (inputData.fallback as
            | { effectiveProvider?: string; attemptedProviders?: string[] }
            | undefined) ?? {};
        const currentEff = fbStateNow.effectiveProvider ?? modelMeta.provider;
        const alreadyAttempted = new Set(fbStateNow.attemptedProviders ?? []);
        alreadyAttempted.add(currentEff);

        const fallbackCandidatesNow = getFallbackCandidates(modelId, "design").filter((m) =>
          isFallbackCompatible(m, job.data.mediaInputs),
        );
        const nextCandidate = fallbackCandidatesNow.find((m) => !alreadyAttempted.has(m.provider));

        if (!nextCandidate) {
          logger.warn(
            {
              dbJobId,
              modelId,
              currentEff,
              attempted: Array.from(alreadyAttempted),
              registeredFallbacks: fallbackCandidatesNow.map((m) => m.provider),
              errMessage: err instanceof Error ? err.message : String(err),
            },
            "Image poll: KIE 5xx terminal — fallback skipped (no eligible candidate)",
          );
        } else {
          logger.warn(
            { dbJobId, modelId, currentEff, next: nextCandidate.provider },
            "Image poll: KIE 5xx terminal — re-enqueuing on fallback",
          );
          await notifyFallback({
            section: "image",
            modelId,
            primaryProvider: modelMeta.provider,
            fallbackProvider: nextCandidate.provider,
            reason: "persistent_5xx",
            jobId: dbJobId,
            userId: userIdStr,
          });

          // Чистим providerJobId + мерджим обновлённый fallback.attemptedProviders.
          const merged = {
            ...inputData,
            fallback: {
              primaryProvider: modelMeta.provider,
              attemptedProviders: Array.from(alreadyAttempted),
            },
          };
          await db.generationJob.update({
            where: { id: dbJobId },
            data: {
              providerJobId: null,
              providerKeyId: null,
              inputData: merged as unknown as Prisma.InputJsonValue,
            },
          });

          await delayJob(
            job,
            {
              ...job.data,
              stage: undefined,
              pollStartedAt: undefined,
              lastIntervalMs: undefined,
            },
            1000,
            token,
          );
        }
      }
    }

    if (isLastAttempt) {
      // Diagnostics: если fallback не сработал на последней попытке, фиксируем
      // явную причину (mirror'ит video processor). Помогает понять, почему
      // job упал в "generic generation failed" вместо переключения провайдера.
      if (stage !== "poll") {
        logger.warn(
          { dbJobId, modelId, stage, errMessage: err instanceof Error ? err.message : String(err) },
          "Image fallback skipped: not poll stage (submit-stage failures handled by submitWithFallback)",
        );
      } else if (!modelMeta) {
        logger.warn(
          { dbJobId, modelId },
          "Image fallback skipped: modelMeta missing (model not in AI_MODELS)",
        );
      } else if (!isKieTransientError(err) && !isProviderTemporaryUnavailable(err)) {
        logger.warn(
          {
            dbJobId,
            modelId,
            provider: modelMeta.provider,
            registeredFallbacks: fallbackCandidates.map((m) => m.provider),
            errMessage: err instanceof Error ? err.message : String(err),
          },
          "Image fallback skipped: error type not eligible (need KIE transient or provider-unavailable)",
        );
      } else if (fallbackCandidates.length === 0) {
        logger.warn(
          {
            dbJobId,
            modelId,
            provider: modelMeta.provider,
            mediaInputs: job.data.mediaInputs ? Object.keys(job.data.mediaInputs) : [],
            errMessage: err instanceof Error ? err.message : String(err),
          },
          "Image fallback skipped: no compatible candidates (filtered by isFallbackCompatible)",
        );
      }

      // Refund: токены списываются на финализации ДО отправки результата юзеру.
      // Если отправка/буфер-фетч упали (провайдер 404'ит outputUrl, S3 файл
      // потерян, sendPhoto Telegram'а отбит) — у юзера списано, а изображения
      // он не увидел. Возвращаем `tokensSpent`. Если deduct ещё не случался
      // (submit/poll упал до Stage 2) — `tokensSpent` будет null/0 → no-op.
      const dbJobNow = await db.generationJob
        .findUnique({ where: { id: dbJobId }, select: { tokensSpent: true } })
        .catch(() => null);
      const tokensSpent = dbJobNow?.tokensSpent ? Number(dbJobNow.tokensSpent) : 0;

      await db.generationJob.update({
        where: { id: dbJobId },
        data: { status: "failed", error: String(err), errorCode: classifyError(err) },
      });

      if (tokensSpent > 0) {
        await refundTokens(BigInt(userIdStr), tokensSpent, modelId, "ai_image_undelivered").catch(
          (refundErr) =>
            logger.error({ refundErr, dbJobId, tokensSpent }, "Image failed: refund attempt threw"),
        );
        logger.warn({ dbJobId, tokensSpent }, "Image failed after deduct: tokens refunded to user");
      }

      await notifyTechError(err, {
        jobId: dbJobId,
        modelId,
        section: "image",
        userId: userIdStr,
        attempt: job.attemptsMade,
      });

      const failureMsg = pickGenerationFailedMessage(t, modelName, "design");
      if (telegramChatId !== null) {
        await telegram.sendMessage(telegramChatId, failureMsg).catch(() => void 0);
      } else {
        await apiNotifyError({
          section: "image",
          userId: userIdStr,
          dbJobId,
          userMessage: failureMsg,
        }).catch(() => void 0);
      }
    }

    throw err;
  }
}

type TelegramImageInfo =
  | { kind: "url"; url: string; byteSize: number }
  | { kind: "buffer"; buffer: Buffer; byteSize: number };

/**
 * Returns the best source info for sending an image to Telegram:
 * 1. S3 presigned URL if HEAD confirms reachability + size (Telegram can fetch directly).
 * 2. S3 presigned URL downloaded as a buffer (when HEAD fails / lacks content-length,
 *    e.g. some S3-compat stores omit it on presigned responses).
 * 3. Provider URL as a last resort — only when S3 isn't configured or we never
 *    stored the file. Provider URLs from fal / Google (nano banana 2) are often
 *    single-use or short-lived and will 409/410 on re-fetch by this point.
 */
async function resolveTelegramSource(
  s3Key: string | null,
  providerUrl: string,
): Promise<TelegramImageInfo> {
  if (s3Key) {
    const s3Url = await getFileUrl(s3Key).catch(() => null);
    if (s3Url) {
      const head = await fetch(s3Url, { method: "HEAD" }).catch(() => null);
      if (head?.ok) {
        const contentLength = head.headers.get("content-length");
        const byteSize = contentLength ? parseInt(contentLength, 10) : NaN;
        if (!isNaN(byteSize) && byteSize > 0) {
          return { kind: "url", url: s3Url, byteSize };
        }
      }
      // HEAD not usable — GET the S3 copy directly instead of re-fetching
      // the (possibly single-use / expired) provider URL. С retry'ями на
      // разовые 5xx/network blip'ы — после fail-through уйдём на provider URL.
      const buffer = await withRetry("image.fetchS3", 3, async () => {
        const r = await fetch(s3Url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
      }).catch(() => null);
      if (buffer && buffer.byteLength > 0) {
        return { kind: "buffer", buffer, byteSize: buffer.byteLength };
      }
    }
  }
  // Provider URL fallback с retry'ями — последний шанс достать байты.
  const buffer = await withRetry("image.fetchProvider", 3, async () => {
    const r = await fetch(providerUrl);
    if (!r.ok) throw new Error(`Failed to fetch image from provider: ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  });
  return { kind: "buffer", buffer, byteSize: buffer.byteLength };
}

/** Telegram photo limits: 5MB for URL-based sendPhoto, 10MB for multipart upload. */
const PHOTO_URL_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_BUFFER_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Prepares a Telegram photo source. If the image exceeds photo size limits
 * (and isn't SVG), it's re-encoded in-memory to a JPEG that fits, so we can
 * still deliver it as a photo instead of a document. The re-encoded bytes
 * are not persisted — original S3 copy stays intact.
 */
async function prepareTelegramPhoto(
  info: TelegramImageInfo,
  providerUrl: string,
  filename: string,
): Promise<{ source: string | InstanceType<typeof InputFile>; isSvg: boolean }> {
  const isSvg = filename.toLowerCase().endsWith(".svg");
  if (isSvg) {
    const src = info.kind === "url" ? info.url : new InputFile(info.buffer, filename);
    return { source: src, isSvg: true };
  }

  if (info.kind === "url" && info.byteSize <= PHOTO_URL_MAX_BYTES) {
    return { source: info.url, isSvg: false };
  }
  if (info.kind === "buffer" && info.byteSize <= PHOTO_BUFFER_MAX_BYTES) {
    return { source: new InputFile(info.buffer, filename), isSvg: false };
  }

  // Too large for sendPhoto — download (if URL) and compress in memory.
  let buffer: Buffer;
  if (info.kind === "buffer") {
    buffer = info.buffer;
  } else {
    const res = await fetch(info.url).catch(() => null);
    if (!res || !res.ok) {
      // Fallback to provider URL if S3 fetch fails.
      const fallback = await fetch(providerUrl);
      if (!fallback.ok) throw new Error(`Failed to fetch image: ${fallback.status}`);
      buffer = Buffer.from(await fallback.arrayBuffer());
    } else {
      buffer = Buffer.from(await res.arrayBuffer());
    }
  }
  const compressed = await compressForTelegramPhoto(buffer);
  const jpegName = filename.replace(/\.[^.]+$/, "") + ".jpg";
  return { source: new InputFile(compressed, jpegName), isSvg: false };
}
