import { UnrecoverableError, DelayedError, type Job } from "bullmq";
import { delayJob } from "../utils/delay-job.js";
import { Api, InputFile } from "grammy";
import type { AudioJobData } from "@metabox/api/queues";
import { getAudioQueue } from "@metabox/api/queues";
import { db } from "@metabox/api/db";
import { createAudioAdapter } from "@metabox/api/ai/audio";
import { deductTokens, calculateCost, translatePromptIfNeeded } from "@metabox/api/services";
import type { DeductResult } from "@metabox/api/services";
import { buildS3Key, uploadBuffer, uploadFromUrl, getFileUrl } from "@metabox/api/services/s3";
import { logger } from "../logger.js";
import {
  config,
  AI_MODELS,
  getT,
  buildResultCaption,
  pickGenerationFailedMessage,
  getFallbackCandidates,
  type AIModel,
} from "@metabox/shared";
import type { Prisma } from "@prisma/client";
import { notifyTechError, notifyTechErrorThrottled } from "../utils/notify-error.js";
import {
  resolveUserFacingMessage,
  shouldNotifyOps,
  getOpsAlertDedupKey,
} from "../utils/user-facing-error.js";
import { getIntervalForElapsed } from "../utils/poll-schedule.js";
import { submitWithThrottle, isRateLimitLongWindowError } from "../utils/submit-with-throttle.js";
import { submitWithFallback } from "../utils/submit-with-fallback.js";
import {
  acquireForSubmit,
  acquireForPoll,
  acquireForSubmitSticky,
} from "../utils/acquire-for-processor.js";
import { resolveKeyProvider, resolveKeyProviderForModel } from "@metabox/api/ai/key-provider";
import { isKieFiveXxError } from "@metabox/api/utils/kie-error";
import { isProviderTemporaryUnavailable } from "@metabox/api/utils/provider-unavailable-error";
import { notifyFallback } from "../utils/notify-error.js";
import { resolveVoiceForTTS } from "@metabox/api/services/user-voice";
import type { AcquiredKey } from "@metabox/api/services/key-pool";
import { deferIfTransientNetworkError } from "../utils/defer-transient.js";
import { isUniqueViolation } from "../utils/prisma-errors.js";

const INITIAL_POLL_INTERVAL_MS = 5000;

const telegram = new Api(config.bot.token);

async function sendAudio(
  chatId: number,
  result: { buffer?: Buffer; url?: string; ext: string; contentType: string },
  caption: string,
): Promise<void> {
  let buf = result.buffer;
  if (!buf && result.url) {
    const res = await fetch(result.url);
    if (!res.ok) throw new Error(`Failed to fetch audio from provider: ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  if (buf) {
    await telegram.sendAudio(chatId, new InputFile(buf, `audio.${result.ext}`), {
      caption,
      parse_mode: "HTML",
    });
  } else {
    throw new Error("Audio result has neither buffer nor URL");
  }
}

export async function processAudioJob(job: Job<AudioJobData>, token?: string): Promise<void> {
  const {
    dbJobId,
    userId: userIdStr,
    modelId,
    prompt,
    voiceId,
    sourceAudioUrl,
    telegramChatId,
    modelSettings,
  } = job.data;

  const stage = job.data.stage ?? "generate";

  logger.info({ dbJobId, modelId, stage }, "Processing audio job");

  const userLang = (await db.user
    .findUnique({ where: { id: BigInt(userIdStr) }, select: { language: true } })
    .then((u) => u?.language ?? "ru")) as Parameters<typeof getT>[0];
  const t = getT(userLang);
  const modelMeta = AI_MODELS[modelId];
  const modelName = modelMeta?.name ?? modelId;
  const keyProvider = resolveKeyProvider(modelId);

  // Fallback кандидаты для модели. Сейчас зарегистрированы только для Suno
  // (kie primary → apipass fallback). Sticky-voice path (TTS с user-cloned
  // voice) у моделей tts-* — fallback не подключаем (голос привязан к
  // конкретному ключу/аккаунту провайдера).
  const fallbackCandidates: AIModel[] = modelMeta ? getFallbackCandidates(modelId, "audio") : [];

  /** Подобрать AIModel по provider строке (primary или один из fallback'ов). */
  const findModelByProvider = (provider: string): AIModel | undefined => {
    if (modelMeta?.provider === provider) return modelMeta;
    return fallbackCandidates.find((m) => m.provider === provider);
  };

  /** State-shape `inputData.fallback`. Inline-формат как в video.processor. */
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

    let audioResult: { buffer?: Buffer; url?: string; ext: string; contentType: string } | null =
      null;
    let s3Key: string | null = null;
    let deductResult: DeductResult | undefined;
    const existingOutput = existingJob?.outputs?.[0];

    if (existingOutput) {
      // Crash-recovery fast path. Atomic transition: only one runner wins.
      // count=1 → resumed mid-finalize, deliver result + close row (no deduct).
      // count=0 → already finished, skip to avoid duplicate send.
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
      const ext = existingOutput.s3Key?.split(".").pop() ?? "mp3";
      const resolvedUrl = existingOutput.s3Key
        ? ((await getFileUrl(existingOutput.s3Key).catch(() => null)) ??
          existingOutput.outputUrl ??
          undefined)
        : (existingOutput.outputUrl ?? undefined);
      audioResult = { url: resolvedUrl, ext, contentType: `audio/${ext}` };
      s3Key = existingOutput.s3Key ?? null;
    } else if (stage === "generate") {
      // ── Stage 1: submit (or sync-generate) ────────────────────────────
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

      // Cloned-voice path: TTS с user-cloned voice. Voice_id живёт на
      // конкретном ключе → нужен sticky key. resolveVoiceForTTS принудительно
      // мигрирует EL-голоса на Cartesia при первом обращении и возвращает
      // фактический provider (cartesia | elevenlabs).
      //
      // Современный пикер шлёт `UserVoice.id` (стабильный local cuid). Старые
      // записи в modelSettings могут хранить голый externalId — пробуем и так
      // для backward-compat (без provider-фильтра, любые голоса юзера). Если
      // совпадений нет — это official voice (EL preset), проходит без sticky.
      let stickyVoice: {
        voiceId: string;
        acquired: AcquiredKey;
        provider: "cartesia" | "elevenlabs";
      } | null = null;
      if (modelId === "tts-el" || modelId === "voice-clone" || modelId === "tts-cartesia") {
        const requestedVoice = (modelSettings?.voice_id as string | undefined) ?? voiceId ?? null;
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
            const resolved = await resolveVoiceForTTS(userVoice.id);
            stickyVoice = {
              voiceId: resolved.voiceId,
              acquired: resolved.acquired,
              provider: resolved.provider,
            };
          }
        }
      }

      // submitWithFallback path: async-модель с зарегистрированными
      // fallback'ами и без sticky-аккаунта. Sticky-voice (TTS-модели) — это
      // привязка к конкретному ключу/провайдеру голоса; fallback там не
      // применяем. Resume (existingJob.providerJobId) тоже не идёт через
      // fallback — продолжаем поллить тот же task.
      const useSubmitWithFallback =
        !stickyVoice &&
        !existingJob?.providerJobId &&
        modelMeta?.isAsync === true &&
        fallbackCandidates.length > 0 &&
        modelMeta !== undefined;

      // Если был re-clone — подменяем voice_id, чтобы адаптер дернул свежий.
      const effectiveVoiceId = stickyVoice?.voiceId ?? voiceId;
      const effectiveModelSettings = stickyVoice
        ? { ...(modelSettings ?? {}), voice_id: stickyVoice.voiceId }
        : modelSettings;

      if (useSubmitWithFallback && modelMeta) {
        // Async submit через provider fallback. Acquire ключа делает сам
        // submitWithFallback — внешний acquireForSubmit не нужен.
        const prevFallbackState = readFallbackState();
        const skipProviders =
          prevFallbackState.attemptedProviders && prevFallbackState.attemptedProviders.length > 0
            ? new Set(prevFallbackState.attemptedProviders)
            : undefined;

        const fbResult = await submitWithFallback<string, AudioJobData>({
          primaryModel: modelMeta,
          fallbacks: fallbackCandidates,
          section: "audio",
          job,
          token,
          allowFiveXxFallback: job.attemptsMade >= 2,
          jobId: dbJobId,
          userId: userIdStr,
          skipProviders,
          submit: async (model, acquired) => {
            const adapter = createAudioAdapter(model, acquired);
            if (!adapter.submit) throw new Error(`Adapter ${model.id} has no submit()`);
            return adapter.submit({
              prompt: effectivePrompt,
              voiceId: effectiveVoiceId,
              sourceAudioUrl,
              modelSettings: effectiveModelSettings,
            });
          },
        });

        const providerJobId = fbResult.result;
        const submittedKeyId = fbResult.acquired.keyId;
        // Накопительно: prev attempted (из poll-stage re-submit'а) + fresh
        // attempts из этого вызова. Без union теряем primary-marker и поллер
        // может попробовать его снова на следующей итерации.
        const accumulated = new Set([
          ...(prevFallbackState.attemptedProviders ?? []),
          ...fbResult.attempts.map((a) => a.provider),
        ]);
        await writeFallbackState({
          primaryProvider: modelMeta.provider,
          effectiveProvider: fbResult.effectiveProvider,
          attemptedProviders: Array.from(accumulated),
        });

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

        logger.info(
          { dbJobId, providerJobId, effectiveProvider: fbResult.effectiveProvider },
          "Audio poll scheduled (with fallback support)",
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

      // Legacy path: sticky-voice / sync TTS / resume — без fallback.
      const acquired = stickyVoice
        ? await acquireForSubmitSticky({
            acquired: stickyVoice.acquired,
            modelId,
            job,
            token,
            queue: getAudioQueue(),
          })
        : await acquireForSubmit({
            provider: keyProvider,
            modelId,
            job,
            token,
            queue: getAudioQueue(),
          });

      // Если sticky-voice выбран — adapter подбираем по фактическому провайдеру
      // голоса, не по модели. Это позволяет через `tts-el` UI воспроизводить
      // клонированные голоса которые после миграции лежат на Cartesia: внутри
      // мы тихо переключаемся на CartesiaAdapter с Cartesia-ключом.
      const effectiveModelId = stickyVoice
        ? stickyVoice.provider === "cartesia"
          ? "tts-cartesia"
          : "tts-el"
        : modelId;
      const adapter = createAudioAdapter(effectiveModelId, acquired);

      if (!adapter.isAsync && adapter.generate) {
        // Sync adapter — generate inline, then fall through to finalize.
        audioResult = await submitWithThrottle({
          modelId,
          provider: modelMeta?.provider,
          section: "audio",
          job,
          token,
          queue: getAudioQueue(),
          keyId: acquired.keyId,
          submit: () =>
            adapter.generate!({
              prompt: effectivePrompt,
              voiceId: effectiveVoiceId,
              sourceAudioUrl,
              modelSettings: effectiveModelSettings,
            }),
        });
      } else {
        // Async adapter (Suno) — submit then schedule poll. Этот путь
        // достижим только при resume (existingJob.providerJobId есть)
        // или у моделей без fallback'ов.
        if (!adapter.submit) throw new Error(`Adapter ${modelId} has no submit()`);

        let providerJobId: string;
        if (existingJob?.providerJobId) {
          providerJobId = existingJob.providerJobId;
          logger.info({ dbJobId, providerJobId }, "Resuming poll for existing provider job");
        } else {
          providerJobId = await submitWithThrottle({
            modelId,
            provider: modelMeta?.provider,
            section: "audio",
            job,
            token,
            queue: getAudioQueue(),
            keyId: acquired.keyId,
            submit: () =>
              adapter.submit!({
                prompt: effectivePrompt,
                voiceId: effectiveVoiceId,
                sourceAudioUrl,
                modelSettings: effectiveModelSettings,
              }),
          });
          await db.generationJob.update({
            where: { id: dbJobId },
            data: {
              providerJobId,
              providerKeyId: acquired.keyId,
              // Фиксируем момент перехода в poll-стадию: после Redis wipe
              // recovery восстановит таймер с этой точки, а не с нуля.
              pollStartedAt: new Date(),
            },
          });
          // Записываем effectiveProvider в inputData.fallback даже на legacy
          // пути — иначе после смены primary в каталоге poll-стадия не сможет
          // определить, на каком провайдере шёл submit (acquireForPoll получит
          // mismatch keyId↔provider).
          if (modelMeta) {
            await writeFallbackState({
              primaryProvider: modelMeta.provider,
              effectiveProvider: modelMeta.provider,
            });
          }
        }

        logger.info({ dbJobId, providerJobId }, "Audio poll scheduled");
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
    } else {
      // ── Stage 2: poll ──────────────────────────────────────────────────
      const providerJobId = existingJob?.providerJobId;
      if (!providerJobId) throw new Error(`Audio poll stage without providerJobId: ${dbJobId}`);

      // Если на submit-стадии случился fallback — используем его модель/keyProvider.
      const fbStateNow = readFallbackState();
      let resolvedEffectiveProvider = fbStateNow.effectiveProvider;
      // Legacy in-flight: job засабмичен до подключения inputData.fallback —
      // определяем провайдера по ключу, на котором был submit.
      if (!resolvedEffectiveProvider && existingJob?.providerKeyId) {
        const pk = await db.providerKey
          .findUnique({
            where: { id: existingJob.providerKeyId },
            select: { provider: true },
          })
          .catch(() => null);
        resolvedEffectiveProvider = pk?.provider;
      }
      const effModel =
        (resolvedEffectiveProvider && findModelByProvider(resolvedEffectiveProvider)) || modelMeta;
      const effKeyProvider = effModel ? resolveKeyProviderForModel(effModel) : keyProvider;

      const acquired = await acquireForPoll(existingJob?.providerKeyId, effKeyProvider);
      const adapter = createAudioAdapter(effModel ?? modelId, acquired);
      if (!adapter.poll) throw new Error(`Adapter ${modelId} has no poll()`);

      audioResult = await adapter.poll(providerJobId);

      if (!audioResult) {
        const elapsed = Date.now() - (job.data.pollStartedAt ?? Date.now());
        const interval = getIntervalForElapsed(elapsed);

        if (interval === null) {
          await db.generationJob.update({
            where: { id: dbJobId },
            data: { status: "failed", error: "poll timeout (24h)" },
          });
          await telegram
            .sendMessage(
              telegramChatId,
              t.errors.generationTimedOut24h.replace("{modelName}", modelName),
            )
            .catch(() => void 0);
          throw new UnrecoverableError("poll timeout 24h");
        }

        if (job.data.lastIntervalMs !== undefined && interval !== job.data.lastIntervalMs) {
          await telegram
            .sendMessage(
              telegramChatId,
              t.errors.generationStillRunning.replace("{modelName}", modelName),
            )
            .catch(() => void 0);
        }

        await delayJob(
          job,
          { ...job.data, stage: "poll", lastIntervalMs: interval },
          interval,
          token,
        );
      }
    }

    if (!audioResult) {
      throw new Error(`Audio job ${dbJobId}: no result after stage ${stage}`);
    }

    // ── Stage 3: upload + deduct (when not already persisted) ───────────
    if (!existingOutput) {
      const audioKey = buildS3Key("audio", userIdStr, dbJobId, audioResult.ext ?? "mp3");
      s3Key = await (
        audioResult.buffer
          ? uploadBuffer(audioKey, audioResult.buffer, `audio/${audioResult.ext ?? "mpeg"}`)
          : audioResult.url
            ? uploadFromUrl(audioKey, audioResult.url, `audio/${audioResult.ext ?? "mpeg"}`)
            : Promise.resolve(null)
      ).catch(() => null);

      try {
        await db.generationJobOutput.create({
          data: { jobId: dbJobId, index: 0, outputUrl: audioResult.url ?? null, s3Key },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Stalled-redelivery race: another runner wrote outputs first. Bail.
          logger.info(
            { dbJobId },
            "Audio finalize: duplicate output detected — another runner is finalizing",
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
        logger.info({ dbJobId }, "Audio finalize: job already done by another runner");
        return;
      }

      const model = AI_MODELS[modelId];
      if (model) {
        const internalCost = calculateCost(
          model,
          0,
          0,
          undefined,
          undefined,
          modelSettings,
          undefined,
          prompt.length,
        );
        deductResult = await deductTokens(BigInt(userIdStr), internalCost, modelId);
        await db.generationJob.update({
          where: { id: dbJobId },
          data: { tokensSpent: internalCost },
        });
      }
    }

    const audioModel = AI_MODELS[modelId];
    const audioCaption = buildResultCaption(t, audioModel?.name ?? modelId, prompt, {
      cost: deductResult?.deducted,
      subscriptionBalance: deductResult?.subscriptionTokenBalance,
      tokenBalance: deductResult?.tokenBalance,
    });
    await sendAudio(telegramChatId, audioResult, audioCaption);

    logger.info({ dbJobId }, "Audio job completed");
  } catch (err) {
    if (err instanceof DelayedError) throw err;
    if (isRateLimitLongWindowError(err)) {
      const msg = pickGenerationFailedMessage(t, modelName, "audio");
      await db.generationJob.update({
        where: { id: dbJobId },
        data: { status: "failed", error: msg },
      });
      await telegram.sendMessage(telegramChatId, msg).catch(() => void 0);
      throw new UnrecoverableError(msg);
    }
    // ── Poll-stage re-submit на provider temporary unavailable ──────────
    // KIE 422 "high demand" / "service is currently unavailable" и т.п. —
    // узел провайдера перегружен; defer + retry на том же провайдере не
    // помогает. Если есть неиспользованный fallback-кандидат — переключаемся:
    // чистим providerJobId/Key + добавляем текущий effective в attemptedProviders
    // + re-enqueue на submit-стадию.
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
          "Audio poll: provider temporary unavailable — re-enqueuing on fallback",
        );
        await notifyFallback({
          section: "audio",
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

    // Throws DelayedError if rescheduled (propagates → BullMQ delays job).
    // Returns silently otherwise → fall through to user-facing failure handling.
    await deferIfTransientNetworkError({ err, job, token, section: "audio" });
    const providerMsg = resolveUserFacingMessage(err, t);
    if (providerMsg !== null) {
      logger.warn({ dbJobId, err }, "Audio job rejected: user-facing error");
      await db.generationJob.update({
        where: { id: dbJobId },
        data: { status: "failed", error: providerMsg },
      });
      if (shouldNotifyOps(err)) {
        const ctx = {
          jobId: dbJobId,
          modelId,
          section: "audio",
          userId: userIdStr,
          attempt: job.attemptsMade,
        };
        const dedupKey = getOpsAlertDedupKey(err);
        if (dedupKey) {
          await notifyTechErrorThrottled(err, ctx, dedupKey);
        } else {
          await notifyTechError(err, ctx);
        }
      }
      await telegram.sendMessage(telegramChatId, providerMsg).catch(() => void 0);
      throw new UnrecoverableError(providerMsg);
    }

    logger.error({ dbJobId, err }, "Audio job failed");

    const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1) - 1;

    // ── Poll-stage fallback на KIE 5xx ──────────────────────────────────
    // KIE при 5xx terminal failure НЕ перезапускает генерацию у себя. Если
    // BullMQ retry'и исчерпаны и есть неиспользованный fallback-кандидат —
    // пере-enqueue через delayJob: stage сбрасываем на "generate", чистим
    // providerJobId, в attemptedProviders добавляем текущий effective provider.
    // Submit-stage прочтёт attemptedProviders и через skipProviders пропустит
    // primary, сразу возьмёт fallback.
    if (stage === "poll" && isLastAttempt && isKieFiveXxError(err) && modelMeta) {
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
          "Audio poll: KIE 5xx terminal — re-enqueuing on fallback",
        );
        await notifyFallback({
          section: "audio",
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

        // delayJob = updateData + moveToDelayed (НЕ инкрементит attemptsMade)
        // → throws DelayedError → BullMQ просыпается мгновенно и заходит
        // в processAudioJob с stage="generate" (default) → submit-fallback.
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

    if (isLastAttempt) {
      await db.generationJob.update({
        where: { id: dbJobId },
        data: { status: "failed", error: String(err) },
      });

      const errMsg = err instanceof Error ? err.message : String(err);

      let userMessage: string | null = null;
      if (errMsg.includes("SENSITIVE_WORD_ERROR")) {
        userMessage = t.errors.audioSensitiveWord;
      } else if (errMsg.includes("GENERATE_AUDIO_FAILED")) {
        userMessage = t.errors.audioGenerateFailed;
      } else if (errMsg.includes("CREATE_TASK_FAILED")) {
        userMessage = t.errors.audioCreateTaskFailed;
      } else if (errMsg.includes("Timed out")) {
        userMessage = t.errors.generationTimeout;
      }

      const isKnownError = userMessage !== null;

      if (!isKnownError) {
        await notifyTechError(err, {
          jobId: dbJobId,
          modelId,
          section: "audio",
          userId: userIdStr,
          attempt: job.attemptsMade,
        });
      }

      await telegram
        .sendMessage(
          telegramChatId,
          userMessage ?? pickGenerationFailedMessage(t, modelName, "audio"),
        )
        .catch(() => void 0);
    }

    throw err;
  }
}
