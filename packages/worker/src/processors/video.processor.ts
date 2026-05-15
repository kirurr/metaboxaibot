import { UnrecoverableError, DelayedError } from "bullmq";
import type { Job } from "bullmq";
import { delayJob } from "../utils/delay-job.js";
import { resolveUserFacingMessage, shouldNotifyOps } from "../utils/user-facing-error.js";
import { isHeyGenProviderUnavailable } from "@metabox/api/utils/heygen-error";
import { getIntervalForElapsed } from "../utils/poll-schedule.js";
import { Api } from "grammy";
import type { VideoJobData } from "@metabox/api/queues";
import { getVideoQueue } from "@metabox/api/queues";
import { db } from "@metabox/api/db";
import { createVideoAdapter } from "@metabox/api/ai/video";
import { ElevenLabsAdapter, CartesiaAdapter } from "@metabox/api/ai/audio";
import {
  deductTokens,
  refundTokens,
  calculateCost,
  calculateProviderCostUsd,
  computeVideoTokens,
  translatePromptIfNeeded,
  usdToTokens,
} from "@metabox/api/services";
import { getModelMultiplier } from "@metabox/api/services/pricing-config";
import type { DeductResult } from "@metabox/api/services";
import {
  buildS3Key,
  buildThumbnailKey,
  sectionMeta,
  uploadBuffer,
  getFileUrl,
  generateVideoThumbnail,
  generateVideoJpegThumbnail,
  remuxToFaststart,
} from "@metabox/api/services/s3";
import { buildDownloadButton } from "@metabox/api/utils/download-token";
import { isUniqueViolation } from "../utils/prisma-errors.js";
import { InputFile } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import { parseMp4Info } from "@metabox/api/utils/mp4-duration";
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
import { notifyTechError, notifyFallback } from "../utils/notify-error.js";
import { isKieTransientError } from "@metabox/api/utils/kie-error";
import { isProviderTemporaryUnavailable } from "@metabox/api/utils/provider-unavailable-error";
import { submitWithThrottle, isRateLimitLongWindowError } from "../utils/submit-with-throttle.js";
import { submitWithFallback } from "../utils/submit-with-fallback.js";
import { computeSeedance2BillableUsd } from "../utils/seedance2-billing.js";
import {
  acquireForSubmit,
  acquireForPoll,
  acquireForSubmitSticky,
} from "../utils/acquire-for-processor.js";
import { resolveKeyProvider, resolveKeyProviderForModel } from "@metabox/api/ai/key-provider";
import { acquireById, markRateLimited } from "@metabox/api/services/key-pool";
import {
  classifyRateLimit,
  isFiveXxError,
  LONG_WINDOW_THRESHOLD_MS,
} from "@metabox/api/utils/rate-limit-error";
import type { AcquiredKey } from "@metabox/api/services/key-pool";
import type { Prisma } from "@prisma/client";
import { userAvatarService } from "@metabox/api/services/user-avatar";
import { resolveVoiceForTTS } from "@metabox/api/services/user-voice";
import { deferIfTransientNetworkError } from "../utils/defer-transient.js";
import { deferIfRateLimitOverload } from "../utils/defer-rate-limit.js";
import { withRetry } from "../utils/with-retry.js";
import { UserFacingError } from "@metabox/shared";
import { classifyError, POLL_TIMEOUT_CODE } from "../utils/classify-error.js";
import { apiNotifySuccess, apiNotifyError } from "../utils/api-notify.js";
import { fetchVideoUrl } from "../utils/fetch-video.js";

const INITIAL_POLL_INTERVAL_MS = 5000;

const telegram = new Api(config.bot.token);

export async function processVideoJob(job: Job<VideoJobData>, token?: string): Promise<void> {
  const {
    dbJobId,
    userId: userIdStr,
    modelId,
    prompt,
    imageUrl,
    mediaInputs,
    telegramChatId,
    sendOriginalLabel,
    aspectRatio,
    duration,
    modelSettings,
    promptMessageId,
  } = job.data;

  const stage = job.data.stage ?? "generate";

  /** Reply parameters used when sending the result so the user can match it to the original prompt message. */
  const replyToPrompt = promptMessageId
    ? {
        reply_parameters: {
          message_id: promptMessageId,
          allow_sending_without_reply: true,
        },
      }
    : undefined;

  logger.info({ dbJobId, modelId, stage }, "Processing video job");

  const userLang = (await db.user
    .findUnique({ where: { id: BigInt(userIdStr) }, select: { language: true } })
    .then((u) => u?.language ?? "ru")) as Parameters<typeof getT>[0];
  const t = getT(userLang);
  const modelMeta = AI_MODELS[modelId];
  const modelName = modelMeta?.name ?? modelId;
  const keyProvider = resolveKeyProvider(modelId);

  // Fallback кандидаты: если у задачи есть mediaInputs (image-to-video и т.п.),
  // fallback должен поддерживать те же слоты. HeyGen с user avatar и аналогичные
  // sticky-провайдеры не получают fallback (их fallback массив пуст).
  // Передаём duration чтобы isFallbackCompatible мог отсечь fallback'ов с
  // меньшим durationRange.max (e.g. FAL grok-imagine 1-10s, primary KIE 6-30s).
  const requestedDuration =
    typeof modelSettings?.duration === "number" ? modelSettings.duration : duration;
  const fallbackCandidates: AIModel[] = modelMeta
    ? getFallbackCandidates(modelId, "video").filter((m) =>
        isFallbackCompatible(m, mediaInputs, requestedDuration),
      )
    : [];

  /** Подобрать AIModel по provider строке (primary или один из fallback'ов). */
  const findModelByProvider = (provider: string): AIModel | undefined => {
    if (modelMeta?.provider === provider) return modelMeta;
    return fallbackCandidates.find((m) => m.provider === provider);
  };

  /**
   * State-shape `inputData.fallback`. Не вводим отдельный type — используем
   * inline-формат как в image processor'е.
   */
  interface FallbackState {
    primaryProvider: string;
    effectiveProvider?: string;
    attemptedProviders?: string[];
  }

  try {
    const existingJob = await db.generationJob.findUnique({
      where: { id: dbJobId },
      select: {
        providerJobId: true,
        providerKeyId: true,
        status: true,
        inputData: true,
        outputs: { orderBy: { index: "asc" as const }, take: 1 },
      },
    });

    /** Прочитать fallback state из inputData. */
    const readFallbackState = (): FallbackState => {
      const raw = (existingJob?.inputData as Record<string, unknown> | null | undefined)
        ?.fallback as FallbackState | undefined;
      return { primaryProvider: modelMeta?.provider ?? "", ...(raw ?? {}) };
    };

    /** Записать fallback state в inputData (мерджится). */
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

    let outputUrl: string;
    let s3Key: string | null;
    let outputId: string;
    let videoBuffer: Buffer | null = null;
    let videoResult: Awaited<ReturnType<ReturnType<typeof createVideoAdapter>["poll"]>> | null =
      null;
    let deductResult: DeductResult | undefined;
    let pollAdapter: ReturnType<typeof createVideoAdapter> | null = null;
    // Lifted на функциональный scope чтобы был доступен в Stage 3 (рендер
    // inline-кнопок) — там используется для решения «можно ли продлить»
    // (FAL extend требует source длиной 2-15s).
    let actualDuration: number | null = null;

    if (existingJob?.outputs?.length) {
      // Crash-recovery fast path. Atomic transition: only one runner wins.
      // count=1 → we resumed mid-finalize, deliver result + close row (no
      // deduct, cost context lost). count=0 → another runner already finished,
      // skip to avoid duplicate send.
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
      outputUrl = existingJob.outputs[0].outputUrl ?? "";
      s3Key = existingJob.outputs[0].s3Key ?? null;
      outputId = existingJob.outputs[0].id;
    } else if (stage === "generate") {
      // ── Stage 1: submit ────────────────────────────────────────────────
      await db.generationJob.update({
        where: { id: dbJobId },
        data: { status: "processing" },
      });

      let providerJobId: string;
      if (existingJob?.providerJobId) {
        providerJobId = existingJob.providerJobId;
        logger.info({ dbJobId, providerJobId }, "Resuming poll for existing provider job");
      } else {
        const effectivePrompt = await translatePromptIfNeeded(
          prompt,
          modelSettings,
          BigInt(userIdStr),
          modelId,
        );

        // HeyGen с user-avatar (talking_photo): аватар живёт на конкретном
        // ключе, на котором был создан. Sticky-acquire по providerKeyId аватара.
        // Если ключ удалён → markOrphaned + UserFacingError.
        let stickyAvatar: { acquired: AcquiredKey; userAvatarId: string } | null = null;
        if (modelId === "heygen") {
          const candidateAvatarId = (modelSettings?.avatar_id as string | undefined)?.trim();
          if (candidateAvatarId) {
            const userAvatar = await db.userAvatar.findFirst({
              where: {
                userId: BigInt(userIdStr),
                provider: "heygen",
                externalId: candidateAvatarId,
              },
              select: { id: true, providerKeyId: true, status: true },
            });
            if (userAvatar) {
              if (userAvatar.status === "orphaned") {
                throw new UserFacingError(`Avatar ${candidateAvatarId} is orphaned`, {
                  key: "avatarOrphaned",
                });
              }
              try {
                const stickKey = await acquireById(userAvatar.providerKeyId, "heygen");
                stickyAvatar = { acquired: stickKey, userAvatarId: userAvatar.id };
              } catch (e) {
                logger.warn(
                  { userAvatarId: userAvatar.id, keyId: userAvatar.providerKeyId, err: e },
                  "Video submit: HeyGen avatar key gone, marking orphaned",
                );
                await userAvatarService.markOrphaned(userAvatar.id);
                throw new UserFacingError(`Avatar key gone for ${candidateAvatarId}`, {
                  key: "avatarOrphaned",
                });
              }
            }
          }
        }

        // If voice_id is a local UserVoice.id (modern picker format) resolve
        // it to the current external voice_id here so the provider adapter
        // (HeyGen / D-ID) receives a voice_id it can actually use.
        // Records saved before this migration store the externalId directly —
        // both shapes are accepted via the two-pass findFirst below (no
        // provider filter, поскольку UserVoice может быть Cartesia или legacy EL).
        //
        // Special case for HeyGen: HeyGen has its own voice catalog and не
        // принимает Cartesia/EL voice_id'ы (вернёт 400 "Invalid voice_id"). Поэтому
        // если модель — HeyGen и юзер выбрал клонированный голос, заранее
        // генерируем TTS через провайдера голоса (Cartesia или legacy EL),
        // аплоадим в S3 и кладём presigned URL в `mediaInputs.voice_audio` —
        // HeyGen.submit подхватит его и пойдёт через audio_asset_id flow (lip-sync).
        let effectiveModelSettings = modelSettings;
        let effectiveMediaInputs = mediaInputs;
        const requestedVoice = (modelSettings?.voice_id as string | undefined)?.trim();
        if (requestedVoice) {
          const userVoice =
            (await db.userVoice.findFirst({
              where: { id: requestedVoice },
              select: { id: true },
            })) ??
            (await db.userVoice.findFirst({
              where: { externalId: requestedVoice },
              select: { id: true },
            }));
          if (userVoice) {
            try {
              const resolved = await resolveVoiceForTTS(userVoice.id);
              if (modelMeta?.provider === "heygen") {
                // Reuse pre-generated audio if a previous attempt succeeded.
                // На retry submit TTS не генерим повторно — берём S3-ключ из inputData.
                const existingInputData =
                  (existingJob?.inputData as Record<string, unknown> | null | undefined) ?? {};
                const cachedAudio = existingInputData.preTtsAudio as
                  | { s3Key?: string; userVoiceId?: string }
                  | undefined;

                let voiceS3Key: string | null = null;
                if (cachedAudio?.s3Key && cachedAudio.userVoiceId === userVoice.id) {
                  voiceS3Key = cachedAudio.s3Key;
                } else {
                  // Provider-aware TTS: после force-migration practically всегда
                  // Cartesia, но legacy без audioS3Key могли остаться на EL.
                  const tts =
                    resolved.provider === "cartesia"
                      ? new CartesiaAdapter("tts-cartesia", resolved.acquired.apiKey)
                      : new ElevenLabsAdapter("tts-el", resolved.acquired.apiKey);
                  const audioResult = await tts.generate({
                    prompt: effectivePrompt,
                    modelSettings: {
                      voice_id: resolved.voiceId,
                      ...((modelSettings?.voice_settings as Record<string, unknown>) ?? {}),
                    },
                  });
                  if (!audioResult.buffer) {
                    throw new Error(`${resolved.provider} TTS returned no audio buffer`);
                  }
                  const audioKey = buildS3Key(
                    "audio",
                    userIdStr,
                    dbJobId,
                    audioResult.ext ?? "mp3",
                  );
                  voiceS3Key = await uploadBuffer(
                    audioKey,
                    audioResult.buffer,
                    audioResult.contentType ?? `audio/${audioResult.ext ?? "mpeg"}`,
                  );
                  if (!voiceS3Key) throw new Error("Failed to upload pre-TTS audio to S3");
                  // Persist для recovery — следующий retry submit'а не будет re-TTS'ить.
                  await db.generationJob
                    .update({
                      where: { id: dbJobId },
                      data: {
                        inputData: {
                          ...existingInputData,
                          preTtsAudio: { s3Key: voiceS3Key, userVoiceId: userVoice.id },
                        } as unknown as Prisma.InputJsonValue,
                      },
                    })
                    .catch((err) =>
                      logger.warn(
                        { dbJobId, err },
                        "Video submit: failed to persist preTtsAudio to inputData",
                      ),
                    );
                }

                const voiceUrl = await getFileUrl(voiceS3Key).catch(() => null);
                if (!voiceUrl) {
                  throw new Error("Failed to resolve fresh URL for pre-TTS audio");
                }
                effectiveMediaInputs = {
                  ...(effectiveMediaInputs ?? {}),
                  voice_audio: [voiceUrl],
                };
                effectiveModelSettings = { ...modelSettings, voice_id: undefined };
              } else {
                effectiveModelSettings = { ...modelSettings, voice_id: resolved.voiceId };
              }
            } catch (err) {
              logger.warn(
                { userVoiceId: userVoice.id, err },
                "Video submit: failed to resolve cloned voice, falling back to raw voice_id",
              );
            }
          }
        }

        let submittedKeyId: string | null = null;
        let effectiveProvider: string = modelMeta?.provider ?? "";

        if (stickyAvatar) {
          // HeyGen avatar — fallback не применяется (avatar bound to a single
          // provider/account). Sticky-acquire + submit как раньше.
          const acquired = await acquireForSubmitSticky({
            acquired: stickyAvatar.acquired,
            modelId,
            job,
            token,
            queue: getVideoQueue(),
          });
          const submitAdapter = createVideoAdapter(modelId, acquired);
          providerJobId = await submitWithThrottle({
            modelId,
            provider: modelMeta?.provider,
            section: "video",
            job,
            token,
            queue: getVideoQueue(),
            keyId: acquired.keyId,
            submit: () =>
              submitAdapter.submit({
                prompt: effectivePrompt,
                imageUrl,
                mediaInputs: effectiveMediaInputs,
                aspectRatio,
                duration,
                modelSettings: effectiveModelSettings,
                userId: BigInt(userIdStr),
              }),
          });
          submittedKeyId = acquired.keyId;
        } else if (modelMeta && fallbackCandidates.length > 0) {
          // У модели зарегистрированы fallback'и — идём через submitWithFallback.
          // Если jobs приехала после poll-stage re-submit'а (KIE 5xx terminal failure),
          // в inputData.fallback.attemptedProviders уже лежит primary — пропускаем
          // его и сразу берём fallback.
          const prevFallbackState = readFallbackState();
          const skipProviders =
            prevFallbackState.attemptedProviders && prevFallbackState.attemptedProviders.length > 0
              ? new Set(prevFallbackState.attemptedProviders)
              : undefined;
          const fbResult = await submitWithFallback<string, VideoJobData>({
            primaryModel: modelMeta,
            fallbacks: fallbackCandidates,
            section: "video",
            job,
            token,
            allowFiveXxFallback: job.attemptsMade >= 2,
            jobId: dbJobId,
            userId: userIdStr,
            skipProviders,
            submit: async (model, acquired) => {
              const adapter = createVideoAdapter(model, acquired);
              return adapter.submit({
                prompt: effectivePrompt,
                imageUrl,
                mediaInputs: effectiveMediaInputs,
                aspectRatio,
                duration,
                modelSettings: effectiveModelSettings,
                userId: BigInt(userIdStr),
              });
            },
          });
          providerJobId = fbResult.result;
          submittedKeyId = fbResult.acquired.keyId;
          effectiveProvider = fbResult.effectiveProvider;
          // Накопительно: prev attempted (из poll-fallback re-submit'а) + fresh
          // attempts из этого вызова. Без union теряем primary-marker и поллер
          // может попробовать его снова на следующей итерации.
          const accumulated = new Set([
            ...(prevFallbackState.attemptedProviders ?? []),
            ...fbResult.attempts.map((a) => a.provider),
          ]);
          await writeFallbackState({
            primaryProvider: modelMeta.provider,
            effectiveProvider,
            attemptedProviders: Array.from(accumulated),
          });
        } else {
          // Нет fallback'ов — обычный путь через submitWithThrottle.
          const acquired = await acquireForSubmit({
            provider: keyProvider,
            modelId,
            job,
            token,
            queue: getVideoQueue(),
          });
          const submitAdapter = createVideoAdapter(modelId, acquired);
          providerJobId = await submitWithThrottle({
            modelId,
            provider: modelMeta?.provider,
            section: "video",
            job,
            token,
            queue: getVideoQueue(),
            keyId: acquired.keyId,
            submit: () =>
              submitAdapter.submit({
                prompt: effectivePrompt,
                imageUrl,
                mediaInputs: effectiveMediaInputs,
                aspectRatio,
                duration,
                modelSettings: effectiveModelSettings,
                userId: BigInt(userIdStr),
              }),
          });
          submittedKeyId = acquired.keyId;
        }

        logger.info(
          { dbJobId, modelId, providerJobId, effectiveProvider },
          "Submitted video generation task",
        );
        await db.generationJob.update({
          where: { id: dbJobId },
          data: {
            providerJobId,
            providerKeyId: submittedKeyId,
            // Фиксируем момент перехода в poll-стадию: после Redis wipe
            // recovery восстановит таймер с этой точки, а не с нуля.
            pollStartedAt: new Date(),
          },
        });
      }

      logger.info({ dbJobId, providerJobId }, "Video poll scheduled");
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
      return; // unreachable — restores TS narrowing for s3Key/outputUrl/outputId
    } else {
      // ── Stage 2: poll ──────────────────────────────────────────────────
      const providerJobId = existingJob?.providerJobId;
      if (!providerJobId) throw new Error(`Video poll stage without providerJobId: ${dbJobId}`);

      // Если на submit-стадии случился fallback — используем его модель/keyProvider.
      const fbStateNow = readFallbackState();
      const effModel =
        (fbStateNow.effectiveProvider && findModelByProvider(fbStateNow.effectiveProvider)) ||
        modelMeta;
      if (!effModel) throw new Error(`Unknown video model: ${modelId}`);
      const effKeyProvider = resolveKeyProviderForModel(effModel);

      const acquired = await acquireForPoll(existingJob?.providerKeyId, effKeyProvider);
      pollAdapter = createVideoAdapter(effModel, acquired);

      videoResult = await pollAdapter.poll(providerJobId);

      if (!videoResult) {
        const elapsed = Date.now() - (job.data.pollStartedAt ?? Date.now());
        const interval = getIntervalForElapsed(elapsed);

        if (interval === null) {
          await db.generationJob.update({
            where: { id: dbJobId },
            data: { status: "failed", error: "poll timeout (24h)", errorCode: POLL_TIMEOUT_CODE },
          });
          const timeoutMsg = t.errors.generationTimedOut24h.replace("{modelName}", modelName);
          if (telegramChatId !== null) {
            await telegram.sendMessage(telegramChatId, timeoutMsg).catch(() => void 0);
          } else {
            await apiNotifyError({
              section: "video",
              userId: userIdStr,
              dbJobId,
              userMessage: timeoutMsg,
              errorCode: POLL_TIMEOUT_CODE,
            }).catch(() => void 0);
          }
          throw new UnrecoverableError("poll timeout 24h");
        }

        if (job.data.lastIntervalMs !== undefined && interval !== job.data.lastIntervalMs) {
          // "still running" hint имеет смысл только в TG-чате; web сам поллит статус.
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
        return; // unreachable — restores TS narrowing for videoResult
      }

      // videoResult present → finalize inline.
      const { ext, contentType } = sectionMeta("video");

      let actualWidth: number | null = null;
      let actualHeight: number | null = null;
      let actualFps: number | null = null;
      try {
        // 3 попытки с экспоненциальным backoff'ом — провайдер-CDN'ы
        // (e.g. evolink files) иногда блипуют 404/5xx, разовые сетевые
        // проблемы покрываются inner-retry без burning'а BullMQ attempt.
        const resultUrl = videoResult.url;
        const buf = await withRetry("video.fetchBuffer", 3, async () =>
          pollAdapter?.fetchBuffer
            ? pollAdapter.fetchBuffer(resultUrl)
            : await fetchVideoUrl(resultUrl, "video.fetchBuffer").then((r) =>
                r.arrayBuffer().then(Buffer.from),
              ),
        );
        videoBuffer = buf;
        const info = parseMp4Info(buf);
        actualDuration = info.duration;
        actualWidth = info.width;
        actualHeight = info.height;
        actualFps = info.fps;
      } catch {
        // non-fatal — продолжаем без буфера. Stage 3 (`resolveTelegramVideoBuffer`)
        // ещё раз попробует скачать с retry'ами уже для отправки в Telegram.
      }

      s3Key = videoBuffer
        ? await uploadBuffer(
            buildS3Key("video", userIdStr, dbJobId, ext),
            videoBuffer,
            contentType,
          ).catch(() => null)
        : null;

      let thumbnailS3Key: string | null = null;
      if (videoBuffer && s3Key) {
        const thumbBuf = await generateVideoThumbnail(videoBuffer);
        if (thumbBuf) {
          thumbnailS3Key = await uploadBuffer(
            buildThumbnailKey(s3Key),
            thumbBuf,
            "image/webp",
          ).catch(() => null);
        }
      }

      outputUrl = videoResult.url;

      try {
        const output = await db.generationJobOutput.create({
          data: { jobId: dbJobId, index: 0, outputUrl, s3Key, thumbnailS3Key },
        });
        outputId = output.id;
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Stalled-redelivery race: another runner wrote outputs first. Bail.
          logger.info(
            { dbJobId },
            "Video finalize: duplicate output detected — another runner is finalizing",
          );
          return;
        }
        throw err;
      }
      // Atomic transition: only one runner wins. Loser bails to avoid
      // double-deduct + duplicate user-send (stalled-redelivery race).
      const updated = await db.generationJob.updateMany({
        where: { id: dbJobId, status: { in: ["pending", "processing"] } },
        data: { status: "done", completedAt: new Date() },
      });
      if (updated.count === 0) {
        logger.info({ dbJobId }, "Video finalize: job already done by another runner");
        return;
      }

      const model = AI_MODELS[modelId];
      if (model) {
        // Providers that bill per whole second — round up so we never under-charge.
        const CEIL_DURATION_MODELS = new Set(["heygen"]);
        const rawDuration = actualDuration ?? duration ?? 5;
        let effectiveDuration = CEIL_DURATION_MODELS.has(modelId)
          ? Math.ceil(rawDuration)
          : rawDuration;

        // Wan 2.7 reference-to-video (first_clip): billable = min(inputDur, 5) + outputDur.
        if (modelId === "wan") {
          const firstClipUrl = (mediaInputs as Record<string, string[]> | undefined)
            ?.first_clip?.[0];
          if (firstClipUrl) {
            const inputSeconds = await fetchClipDurationSec(firstClipUrl).catch(() => 5);
            effectiveDuration += Math.min(inputSeconds, 5);
          }
        }
        const videoTokens = model.costUsdPerMVideoToken
          ? computeVideoTokens(
              model,
              aspectRatio,
              effectiveDuration,
              actualWidth ?? undefined,
              actualHeight ?? undefined,
              actualFps ?? undefined,
            )
          : undefined;
        const refVideos = (mediaInputs as Record<string, string[]> | undefined)?.ref_videos ?? [];
        const hasVideoInputs = refVideos.length > 0;

        // Seedance 2.0 evolink: с video input меняется ВСЯ per-second rate
        // (ниже базовой no-video) И billable_seconds = output + max(input_total, output).
        // costMatrix/costVariants отражают только no-video rates (для preview).
        // Здесь — runtime override когда ref_videos непусты.
        let internalCost: number;
        const isSeedance2Evolink =
          (modelId === "seedance-2" || modelId === "seedance-2-fast") &&
          model.provider === "evolink";

        if (isSeedance2Evolink && hasVideoInputs) {
          const inputDurations = await Promise.all(
            refVideos.map((u) => fetchClipDurationSec(u).catch(() => 0)),
          );
          const resolution = (modelSettings?.resolution as string | undefined) ?? "720p";
          const usd = computeSeedance2BillableUsd({
            modelId: modelId as "seedance-2" | "seedance-2-fast",
            resolution,
            outputDuration: effectiveDuration,
            inputVideoDurations: inputDurations,
          });
          if (usd !== null) {
            internalCost = usdToTokens(usd) * getModelMultiplier(modelId);
          } else {
            // Неизвестное разрешение — fallback на calculateCost (no-video matrix).
            internalCost = calculateCost(
              model,
              0,
              0,
              undefined,
              videoTokens,
              modelSettings,
              effectiveDuration,
              undefined,
              { hasVideoInputs },
            );
          }
        } else {
          internalCost = calculateCost(
            model,
            0,
            0,
            undefined,
            videoTokens,
            modelSettings,
            effectiveDuration,
            undefined,
            { hasVideoInputs },
          );
        }

        // Audit-метаданные: фактический provider (через fallback state) и
        // сырая USD-цена по нему. Для seedance-2 evolink с video inputs —
        // используем computeSeedance2BillableUsd (точная формула провайдера);
        // для остальных — calculateProviderCostUsd (стандартная модель).
        const fbStateActual = readFallbackState();
        const activeProvider = fbStateActual?.effectiveProvider ?? model.provider;
        const activeModel =
          activeProvider === model.provider
            ? model
            : (findModelByProvider(activeProvider) ?? model);
        let actualCostUsd: number | undefined;
        if (isSeedance2Evolink && hasVideoInputs && activeProvider === "evolink") {
          const inputDurations = await Promise.all(
            refVideos.map((u) => fetchClipDurationSec(u).catch(() => 0)),
          );
          const resolution = (modelSettings?.resolution as string | undefined) ?? "720p";
          const usd = computeSeedance2BillableUsd({
            modelId: modelId as "seedance-2" | "seedance-2-fast",
            resolution,
            outputDuration: effectiveDuration,
            inputVideoDurations: inputDurations,
          });
          if (usd !== null) actualCostUsd = usd;
        }
        if (actualCostUsd === undefined) {
          actualCostUsd = calculateProviderCostUsd(
            activeModel,
            0,
            0,
            undefined,
            videoTokens,
            modelSettings,
            effectiveDuration,
            undefined,
            { hasVideoInputs },
          );
        }

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
      }
    }

    // ── Stage 3: send to user ────────────────────────────────────────────
    const rawVideoBuf = await resolveTelegramVideoBuffer(s3Key, outputUrl, videoBuffer);

    // Remux to faststart (moov at front) so Telegram's head-only probe returns
    // correct width/height/duration for the inline preview. Stream-copy only,
    // no re-encoding — typical cost ~50-150 ms per clip.
    const videoBuf = await remuxToFaststart(rawVideoBuf);

    const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
    const tooLargeForTelegram = videoBuf.byteLength > VIDEO_MAX_BYTES;

    const actionRow: InlineKeyboardButton[] | null = tooLargeForTelegram
      ? s3Key
        ? [buildDownloadButton(t.common.downloadFile, s3Key, userIdStr)]
        : null
      : sendOriginalLabel
        ? [{ text: sendOriginalLabel, callback_data: `orig_${outputId}` }]
        : null;

    // «Продлить» — для всех Grok-видео (primary t2v/r2v + результат самого
    // extend'а), при условии что output укладывается в FAL-лимит на источник
    // (2-15s). Это даёт итеративное продление: 6s оригинал → 12s → 18s
    // (последний уже > 15s, кнопка не появится). Если actualDuration не
    // удалось распарсить — кнопку прячем (fail-safe: лучше не показать
    // легитимный extend, чем показать нерабочий и получить FAL-ошибку).
    const FAL_EXTEND_INPUT_MAX_S = 15;
    const FAL_EXTEND_INPUT_MIN_S = 2;
    const isGrokModel =
      modelId === "grok-imagine" ||
      modelId === "grok-imagine-r2v" ||
      modelId === "grok-imagine-extend";
    const canBeExtended =
      isGrokModel &&
      actualDuration !== null &&
      actualDuration >= FAL_EXTEND_INPUT_MIN_S &&
      actualDuration <= FAL_EXTEND_INPUT_MAX_S;
    const extendRow: InlineKeyboardButton[] | null = canBeExtended
      ? [{ text: t.video.extendButton, callback_data: `video_extend_${outputId}` }]
      : null;

    const replyRows = [actionRow, extendRow].filter(Boolean) as InlineKeyboardButton[][];
    const replyMarkup = replyRows.length ? { inline_keyboard: replyRows } : undefined;

    const model = AI_MODELS[modelId];
    const hasAudioDriver =
      !!mediaInputs?.voice_audio?.length ||
      !!mediaInputs?.driving_audio?.length ||
      !!mediaInputs?.reference_audios?.length;
    const caption = buildResultCaption(t, model?.name ?? modelId, prompt, {
      cost: deductResult?.deducted,
      subscriptionBalance: deductResult?.subscriptionTokenBalance,
      tokenBalance: deductResult?.tokenBalance,
      emptyPromptLabel: hasAudioDriver ? t.common.generationAudioPrompt : undefined,
    });

    if (telegramChatId !== null) {
      if (tooLargeForTelegram) {
        // t.errors.fileTooLargeForTelegram — i18n-строка без HTML-спецсимволов,
        // безопасно склеивать с HTML-caption'ом без экранирования.
        await telegram.sendMessage(
          telegramChatId,
          `${caption}\n\n${t.errors.fileTooLargeForTelegram}`,
          {
            parse_mode: "HTML",
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            ...replyToPrompt,
          },
        );
      } else {
        // Probe the remuxed buffer so the values we pass to Telegram match the
        // file it will actually receive.
        const info = parseMp4Info(videoBuf);
        const jpegThumb = await generateVideoJpegThumbnail(videoBuf);
        // 2 попытки — sendVideo (multipart upload в Telegram) на разовых
        // network blip'ах редко, но падает. Single retry даёт безопасный
        // второй шанс без сильного риска double-send (грамми падает до
        // получения подтверждения, поэтому retry безопасен на тех же байтах).
        // На permanent-ошибках (Bad Request) второй вызов падает быстро.
        await withRetry("video.sendVideo", 2, () =>
          telegram.sendVideo(telegramChatId, new InputFile(videoBuf, "video.mp4"), {
            caption,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
            supports_streaming: true,
            ...(info.width ? { width: info.width } : {}),
            ...(info.height ? { height: info.height } : {}),
            ...(info.duration ? { duration: Math.round(info.duration) } : {}),
            ...(jpegThumb ? { thumbnail: new InputFile(jpegThumb, "thumb.jpg") } : {}),
            ...replyToPrompt,
          }),
        );
      }
    } else {
      // Для web TG-лимит 50MB неприменим — отдаём один output с s3Key, фронт
      // сам решит как показать (preview/download по signed URL).
      await apiNotifySuccess({
        section: "video",
        userId: userIdStr,
        dbJobId,
        outputs: [{ id: outputId, outputUrl: outputUrl || null, s3Key: s3Key }],
      }).catch(() => void 0);
    }

    logger.info({ dbJobId }, "Video job completed");
  } catch (err) {
    if (err instanceof DelayedError) throw err;
    if (isRateLimitLongWindowError(err)) {
      const msg = pickGenerationFailedMessage(t, modelName, "video");
      await db.generationJob.update({
        where: { id: dbJobId },
        data: { status: "failed", error: msg, errorCode: "RATE_LIMIT_LONG" },
      });
      if (telegramChatId !== null) {
        await telegram.sendMessage(telegramChatId, msg).catch(() => void 0);
      } else {
        await apiNotifyError({
          section: "video",
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
    // DelayedError если rescheduled; иначе fall through.
    const dbJobForRl = await db.generationJob
      .findUnique({ where: { id: dbJobId }, select: { providerKeyId: true } })
      .catch(() => null);

    // ── Poll-stage re-submit на per-account long-window 429 ─────────────
    // Провайдеры (Google Veo и т.п.) иногда сообщают billing-quota только в
    // poll-ответе, а не на submit'е. Сама генерация ещё не выполнялась —
    // кредиты юзера не списаны (deductTokens вызывается после успеха в
    // Stage 3). Маркаем sticky-ключ как throttled и re-enqueue'им job на
    // submit-стадию: acquireKey priority-логикой возьмёт другой ключ из пула.
    //
    // Ограничения:
    //  - Только когда cooldownMs ≤ LONG_WINDOW_THRESHOLD_MS (per-account).
    //    cooldownMs > 1ч это provider-wide outage — попадёт в обычный
    //    deferIfRateLimitOverload + RateLimitLongWindowError flow.
    //  - Только если есть hint что другой ключ может помочь (есть keyId).
    //    Без keyId (env-fallback режим) re-submit ничего не поменяет.
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
          "Video poll: per-account long-window quota — re-enqueuing on submit stage with fresh key",
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
    // переключаемся: чистим providerJobId/Key + добавляем текущий effective
    // в attemptedProviders + re-enqueue на submit-стадию.
    if (stage === "poll" && isProviderTemporaryUnavailable(err) && modelMeta) {
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

      const nextCandidate = fallbackCandidates.find((m) => !alreadyAttempted.has(m.provider));

      if (nextCandidate) {
        logger.warn(
          { dbJobId, modelId, currentEff, next: nextCandidate.provider },
          "Video poll: provider temporary unavailable — re-enqueuing on fallback",
        );
        await notifyFallback({
          section: "video",
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
      } else {
        logger.warn(
          {
            dbJobId,
            modelId,
            currentEff,
            attempted: Array.from(alreadyAttempted),
            registeredFallbacks: fallbackCandidates.map((m) => m.provider),
            errMessage: err instanceof Error ? err.message : String(err),
          },
          "Video poll: provider temporary unavailable — fallback skipped (no eligible candidate)",
        );
      }
    }

    await deferIfRateLimitOverload({
      err,
      job,
      token,
      section: "video",
      modelId,
      provider: modelMeta?.provider,
      keyId: dbJobForRl?.providerKeyId ?? null,
    });
    // Throws DelayedError if rescheduled (propagates out → BullMQ moves job to delayed).
    // Returns silently otherwise → fall through to user-facing failure handling.
    await deferIfTransientNetworkError({ err, job, token, section: "video" });
    if (isHeyGenProviderUnavailable(err)) {
      const msg = pickGenerationFailedMessage(t, modelName, "video");
      await db.generationJob.update({
        where: { id: dbJobId },
        data: { status: "failed", error: String(err), errorCode: "PROVIDER_INSUFFICIENT_CREDIT" },
      });
      await notifyTechError(err, {
        jobId: dbJobId,
        modelId,
        section: "video",
        userId: userIdStr,
        attempt: job.attemptsMade,
      });
      if (telegramChatId !== null) {
        await telegram.sendMessage(telegramChatId, msg).catch(() => void 0);
      } else {
        await apiNotifyError({
          section: "video",
          userId: userIdStr,
          dbJobId,
          userMessage: msg,
          errorCode: "PROVIDER_INSUFFICIENT_CREDIT",
        }).catch(() => void 0);
      }
      throw new UnrecoverableError(msg);
    }
    const userMsg = resolveUserFacingMessage(err, t);
    if (userMsg !== null) {
      logger.warn({ dbJobId, err }, "Video job rejected: user-facing error");
      await db.generationJob.update({
        where: { id: dbJobId },
        data: { status: "failed", error: userMsg, errorCode: classifyError(err) },
      });
      if (shouldNotifyOps(err)) {
        await notifyTechError(err, {
          jobId: dbJobId,
          modelId,
          section: "video",
          userId: userIdStr,
          attempt: job.attemptsMade,
        });
      }
      if (telegramChatId !== null) {
        await telegram.sendMessage(telegramChatId, userMsg).catch(() => void 0);
      } else {
        await apiNotifyError({
          section: "video",
          userId: userIdStr,
          dbJobId,
          userMessage: userMsg,
          errorCode: classifyError(err),
        }).catch(() => void 0);
      }
      throw new UnrecoverableError(userMsg);
    }

    logger.error({ dbJobId, err }, "Video job failed");

    const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1) - 1;

    // ── Poll-stage fallback на 5xx от текущего провайдера ─────────────────
    // Условие: BullMQ retry'и исчерпаны (isLastAttempt) И ошибка — terminal
    // 5xx-сигнал текущего провайдера, который ретраи на нём не починят.
    // Покрываются ДВА класса ошибок (взаимно дополняющие, не пересекаются):
    //
    //  1. `isKieTransientError` — KIE 5xx + 422 task-id-blank + "client closed
    //     request". KIE-адаптер бросает plain Error БЕЗ `err.status`, поэтому
    //     детектится по тексту message ("KIE …").
    //
    //  2. `isFiveXxError` — generic HTTP 5xx по `err.status`. Покрывает прочие
    //     адаптеры, которые выставляют numeric status на throw'е (например
    //     evolink: 524 от Cloudflare; fal/replicate: 502/503). Эта ветка
    //     прицельно закрывает дыру кие→evolink→fal: раньше evolink-овые 5xx
    //     на poll-стадии не каскадировались на fal, и юзер получал generic
    //     "model is resting" + refund, хотя следующий fallback был свободен.
    //
    // Защита от поспешного каскада на ПЕРВОМ провайдере: `isLastAttempt` —
    // поодиночные 5xx-блипы (например Cloudflare 524 за одну poll-итерацию)
    // сначала проходят обычные BullMQ ретраи, и только потом если 5xx
    // стабильный — каскадим.
    //
    // ⚠ Caveat — нет грейсфул-degradation на ПОСЛЕДУЮЩИХ провайдерах:
    // `attemptsMade` не сбрасывается при cascade re-enqueue (delayJob /
    // moveToDelayed его сохраняют). Поэтому у задачи на fallback-провайдере
    // 0 BullMQ-ретраев в запасе: единичный блип у fal на сабмите или poll'е
    // → fail без повторной попытки. Это НЕ регрессия (до этого фикса юзер
    // вообще не доходил до fal'а), но и не «попробуем ещё раз через минуту».
    //
    // Защита от зацикливания: `currentEff` читается из inputData.fallback
    // (submit-with-fallback его пишет при каскаде на submit-стадии),
    // добавляется в attemptedProviders → submit-with-fallback на следующем
    // запуске skip'нет его через skipProviders. Цепочка терминируется когда
    // все зарегистрированные fallback-кандидаты в attemptedProviders.
    //
    // ⚠ НЕТ защиты от несовместимого input'а на следующем провайдере:
    // submitWithFallback ([:387]) формально умеет ловить
    // ProviderInputIncompatibleError, но на момент коммита НИ ОДИН video-
    // адаптер его не бросает. Если у fal-Kling другая структура
    // modelSettings/mediaInputs, чем у evolink-Kling — fal ответит 400 и
    // юзер получит generic failure. Trade-off принят сознательно: в худшем
    // случае результат тот же, что был до фикса (generic + refund), в
    // лучшем — fal отрабатывает и юзер получает видео.
    //
    // Пере-enqueue: stage сбрасываем на undefined (→ "generate" по умолчанию),
    // чистим providerJobId/Key. Затем delayJob throw'ит DelayedError →
    // outer-catch (выше) пере-кидает её → BullMQ переводит job в delayed-set.
    if (
      stage === "poll" &&
      isLastAttempt &&
      (isKieTransientError(err) || isFiveXxError(err)) &&
      modelMeta
    ) {
      // readFallbackState/writeFallbackState — closures внутри try-блока,
      // в catch недоступны. Refetch'аем напрямую.
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

      const nextCandidate = fallbackCandidates.find((m) => !alreadyAttempted.has(m.provider));

      if (nextCandidate) {
        logger.warn(
          { dbJobId, modelId, currentEff, next: nextCandidate.provider },
          "Video poll: provider 5xx after retries — re-enqueuing on fallback",
        );
        await notifyFallback({
          section: "video",
          modelId,
          primaryProvider: modelMeta.provider,
          fallbackProvider: nextCandidate.provider,
          reason: "persistent_5xx",
          jobId: dbJobId,
          userId: userIdStr,
        });

        // Чистим providerJobId + мерджим обновлённый fallback в одном update'е.
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

        // delayJob = updateData + moveToDelayed (НЕ инкрементит attemptsMade)
        // → throws DelayedError → BullMQ просыпается мгновенно и заходит
        // в processVideoJob с stage="generate" (default) → submit-fallback.
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
      } else {
        logger.warn(
          {
            dbJobId,
            modelId,
            currentEff,
            attempted: Array.from(alreadyAttempted),
            registeredFallbacks: fallbackCandidates.map((m) => m.provider),
            errMessage: err instanceof Error ? err.message : String(err),
          },
          "Video poll: provider 5xx after retries — fallback skipped (no eligible candidate)",
        );
      }
    }

    if (isLastAttempt) {
      // Diagnostics: если fallback не сработал на последней попытке, фиксируем
      // явную причину — иначе виден только generic "Job error" alert. Помогает
      // быстро понять "почему не падёт на fallback?": нет совместимых
      // кандидатов / тип ошибки не подходит / не poll-stage.
      if (stage !== "poll") {
        logger.warn(
          { dbJobId, modelId, stage, errMessage: err instanceof Error ? err.message : String(err) },
          "Video fallback skipped: not poll stage (submit-stage failures handled by submitWithFallback)",
        );
      } else if (!modelMeta) {
        logger.warn(
          { dbJobId, modelId },
          "Video fallback skipped: modelMeta missing (model not in AI_MODELS)",
        );
      } else if (
        !isKieTransientError(err) &&
        !isProviderTemporaryUnavailable(err) &&
        !isFiveXxError(err)
      ) {
        logger.warn(
          {
            dbJobId,
            modelId,
            provider: modelMeta.provider,
            registeredFallbacks: fallbackCandidates.map((m) => m.provider),
            errMessage: err instanceof Error ? err.message : String(err),
          },
          "Video fallback skipped: error type not eligible (need KIE transient / provider-unavailable / 5xx)",
        );
      } else if (fallbackCandidates.length === 0) {
        logger.warn(
          {
            dbJobId,
            modelId,
            provider: modelMeta.provider,
            mediaInputs: mediaInputs ? Object.keys(mediaInputs) : [],
            requestedDuration,
            errMessage: err instanceof Error ? err.message : String(err),
          },
          "Video fallback skipped: no compatible candidates (filtered by isFallbackCompatible — duration/required-slots/capacity)",
        );
      }

      // Refund: токены списываются на Stage 2 ДО фактической отправки
      // результата юзеру. Если отправка/буфер-фетч упали (например, провайдер
      // 404'ит outputUrl, S3 файл потерян, sendVideo Telegram'а отбит) — у
      // юзера списано, а видео он не увидел. Возвращаем ровно `tokensSpent`
      // сохранённый на job'е. Если deduct ещё не случался (submit/poll
      // упал до Stage 2) — `tokensSpent` будет null/0 и refund no-op.
      const dbJobNow = await db.generationJob
        .findUnique({ where: { id: dbJobId }, select: { tokensSpent: true } })
        .catch(() => null);
      const tokensSpent = dbJobNow?.tokensSpent ? Number(dbJobNow.tokensSpent) : 0;

      await db.generationJob.update({
        where: { id: dbJobId },
        data: { status: "failed", error: String(err), errorCode: classifyError(err) },
      });

      if (tokensSpent > 0) {
        await refundTokens(BigInt(userIdStr), tokensSpent, modelId, "ai_video_undelivered").catch(
          (refundErr) =>
            logger.error({ refundErr, dbJobId, tokensSpent }, "Video failed: refund attempt threw"),
        );
        logger.warn({ dbJobId, tokensSpent }, "Video failed after deduct: tokens refunded to user");
      }

      await notifyTechError(err, {
        jobId: dbJobId,
        modelId,
        section: "video",
        userId: userIdStr,
        attempt: job.attemptsMade,
      });

      const failureMsg = pickGenerationFailedMessage(t, modelName, "video");
      if (telegramChatId !== null) {
        await telegram.sendMessage(telegramChatId, failureMsg).catch(() => void 0);
      } else {
        await apiNotifyError({
          section: "video",
          userId: userIdStr,
          dbJobId,
          userMessage: failureMsg,
        }).catch(() => void 0);
      }
    }

    throw err;
  }
}

/** Downloads a clip and returns its duration in seconds (0 on failure). */
async function fetchClipDurationSec(url: string): Promise<number> {
  const res = await fetchVideoUrl(url, "video.fetchClipDuration");
  const buf = Buffer.from(await res.arrayBuffer());
  const info = parseMp4Info(buf);
  return info.duration ?? 0;
}

async function resolveTelegramVideoBuffer(
  s3Key: string | null,
  providerUrl: string,
  cachedBuffer: Buffer | null,
): Promise<Buffer> {
  // Always resolve to a buffer — passing URLs directly to Telegram
  // fails intermittently when Telegram servers can't reach the provider.
  if (cachedBuffer) return cachedBuffer;
  const url = s3Key ? ((await getFileUrl(s3Key).catch(() => null)) ?? providerUrl) : providerUrl;
  // 3 попытки с экспоненциальным backoff'ом — на разовых 404/timeout'ах
  // и других transient-сбоях CDN'а провайдера или S3 даём ещё шанс прежде
  // чем отдать ошибку наверх и сжечь BullMQ attempt'ы.
  return withRetry("video.fetchForTelegram", 3, async () => {
    const res = await fetchVideoUrl(url, "video.fetchForTelegram");
    return Buffer.from(await res.arrayBuffer());
  });
}
