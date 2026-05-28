import { UnrecoverableError, DelayedError, type Job } from "bullmq";
import { delayJob } from "../utils/delay-job.js";
import { withRetry } from "../utils/with-retry.js";
import { classifyError, POLL_TIMEOUT_CODE } from "../utils/classify-error.js";
import { apiNotifySuccess, apiNotifyError } from "../utils/api-notify.js";
import { Api, InputFile } from "grammy";
import type { AudioJobData } from "@metabox/api/queues";
import { getAudioQueue } from "@metabox/api/queues";
import { db } from "@metabox/api/db";
import { createAudioAdapter } from "@metabox/api/ai/audio";
import type { AudioResult, AudioInput } from "@metabox/api/ai/audio";
import {
  deductTokens,
  refundTokens,
  calculateCost,
  calculateProviderCostUsd,
  translatePromptIfNeeded,
} from "@metabox/api/services";
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
  getOpsAlertChannel,
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
import { isFiveXxError } from "@metabox/api/utils/rate-limit-error";
import { isProviderTemporaryUnavailable } from "@metabox/api/utils/provider-unavailable-error";
import { isOpenAiBillingExhaustion } from "@metabox/api/utils/openai-billing-error";
import { notifyFallback } from "../utils/notify-error.js";
import { resolveVoiceForTTS } from "@metabox/api/services/user-voice";
import type { AcquiredKey } from "@metabox/api/services/key-pool";
import { deferIfTransientNetworkError } from "../utils/defer-transient.js";
import { isUniqueViolation } from "../utils/prisma-errors.js";

const INITIAL_POLL_INTERVAL_MS = 5000;

const telegram = new Api(config.bot.token);

/**
 * Шлёт треки одной media-group'ой (если их 2+, иначе одиночным sendAudio),
 * затем — caption отдельным сообщением. Используется на финале audio-job'а.
 *
 * Если есть URL'ы без буферов — параллельно их скачиваем. Треки, которые
 * скачать не удалось, пропускаются (остальные доходят). Если caption пустой,
 * текстовое сообщение не отправляется.
 */
async function sendAudioBatch(
  chatId: number,
  tracks: Array<{ buffer?: Buffer; url?: string; ext: string; contentType: string }>,
  caption: string,
  promptMessageId?: number,
): Promise<void> {
  const replyToPrompt = promptMessageId
    ? {
        reply_parameters: {
          message_id: promptMessageId,
          allow_sending_without_reply: true,
        },
      }
    : undefined;
  const ready = (
    await Promise.all(
      tracks.map(async (t, i) => {
        let buf: Buffer | null = t.buffer ?? null;
        if (!buf && t.url) {
          // 3 попытки — провайдер-CDN'ы (Suno/Cartesia/EL) изредка блипуют
          // 404/5xx; разовые сетевые проблемы покрываются inner-retry без
          // burning'а BullMQ attempt'а.
          const url = t.url;
          buf = await withRetry(`audio.fetchTrack[${i}]`, 3, async () => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
          }).catch((err) => {
            logger.warn({ err, trackIndex: i }, "sendAudioBatch: track fetch failed after retries");
            return null;
          });
          if (!buf) return null;
        }
        return buf ? { buf, ext: t.ext } : null;
      }),
    )
  ).filter((x): x is { buf: Buffer; ext: string } => !!x);

  // 2 попытки — multipart upload в Telegram'е иногда падает на network
  // blip'ах. Single retry — безопасный второй шанс без double-send'а.
  if (ready.length === 1) {
    await withRetry("audio.sendAudio", 2, () =>
      telegram.sendAudio(
        chatId,
        new InputFile(ready[0].buf, `audio.${ready[0].ext}`),
        replyToPrompt,
      ),
    );
  } else if (ready.length >= 2) {
    // Telegram лимит media-group: 2-10 элементов. Suno возвращает 2, в лимит
    // мы не упрёмся, но slice(0, 10) защитит на будущее.
    const media = ready.slice(0, 10).map((r, i) => ({
      type: "audio" as const,
      media: new InputFile(r.buf, `audio_${i + 1}.${r.ext}`),
    }));
    await withRetry("audio.sendMediaGroup", 2, () =>
      telegram.sendMediaGroup(chatId, media, replyToPrompt),
    );
  }
  // ready.length === 0: ни один трек не скачался — caption всё равно отправим,
  // юзер увидит хотя бы текст с информацией о генерации.

  if (caption) {
    await telegram
      .sendMessage(chatId, caption, { parse_mode: "HTML", ...replyToPrompt })
      .catch((err) => logger.warn({ err, chatId }, "sendAudioBatch: caption send failed"));
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
    promptMessageId,
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
        // Берём все outputs (а не только первый) — нужно для multi-track Suno
        // на resume mid-finalize: иначе при recovery второй трек не пере-
        // отправили бы юзеру.
        outputs: { orderBy: { index: "asc" as const } },
      },
    });

    /** Прочитать fallback state из inputData. */
    const readFallbackState = (): FallbackState => {
      const raw = (existingJob?.inputData as Record<string, unknown> | null | undefined)
        ?.fallback as FallbackState | undefined;
      return { primaryProvider: modelMeta?.provider ?? "", ...(raw ?? {}) };
    };

    /** Мерджит произвольные поля в inputData (read-merge-write). */
    const mergeInputData = async (patch: Record<string, unknown>): Promise<void> => {
      const current = await db.generationJob.findUnique({
        where: { id: dbJobId },
        select: { inputData: true },
      });
      const merged = {
        ...((current?.inputData as Record<string, unknown> | null | undefined) ?? {}),
        ...patch,
      };
      await db.generationJob.update({
        where: { id: dbJobId },
        data: { inputData: merged as unknown as Prisma.InputJsonValue },
      });
      if (existingJob) {
        (existingJob.inputData as unknown) = merged;
      }
    };

    /** Записать fallback state в inputData (мерджится). */
    const writeFallbackState = async (next: FallbackState): Promise<void> => {
      await mergeInputData({ fallback: next });
    };

    let audioResult: AudioResult | null = null;
    let deductResult: DeductResult | undefined;
    const existingOutputs = existingJob?.outputs ?? [];
    const existingOutput = existingOutputs[0];

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

      // Резолвим все сохранённые outputs (для Suno их может быть >1).
      // Первый кладём в основной audioResult, остальные — в `extras` так что
      // дальнейшая логика рассылки one-pass обработает все.
      const buildResultFromOutput = async (
        output: (typeof existingOutputs)[number],
      ): Promise<{ url?: string; ext: string; contentType: string }> => {
        const ext = output.s3Key?.split(".").pop() ?? "mp3";
        const resolvedUrl = output.s3Key
          ? ((await getFileUrl(output.s3Key).catch(() => null)) ?? output.outputUrl ?? undefined)
          : (output.outputUrl ?? undefined);
        return { url: resolvedUrl, ext, contentType: `audio/${ext}` };
      };
      const primary = await buildResultFromOutput(existingOutput);
      const restResolved = await Promise.all(
        existingOutputs.slice(1).map((o) => buildResultFromOutput(o)),
      );
      audioResult = {
        ...primary,
        ...(restResolved.length > 0 ? { extras: restResolved } : {}),
      };
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
          // Sticky-voice path: effective adapter/key может быть Cartesia даже у
          // kie-provider модели (tts-el с клонированным голосом). Throttle
          // ключим на ФАКТИЧЕСКОМ провайдере, иначе rate-limit Cartesia ушёл бы
          // в long-cooldown всему провайдеру kie.
          provider: AI_MODELS[effectiveModelId]?.provider ?? modelMeta?.provider,
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
          // Сохраняем (возможно переведённый) промпт в inputData — poll-стадия
          // восстанавливает из него AudioInput для EL-фолбэка KieElevenLabsAdapter.
          // Остальные поля AudioInput (voiceId / sourceAudioUrl / modelSettings)
          // уже лежат в job.data.
          await mergeInputData({ effectivePrompt });
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
      // Видимость фолбэка: KieElevenLabsAdapter дёргает этот колбэк на каждый
      // EL-фолбэк (failed=false — EL вытянул, failed=true — EL тоже упал).
      // notifyFallback шлёт в fallback-канал, как и Suno-фолбэк процессора.
      const onElFallback = (failed: boolean): Promise<void> =>
        notifyFallback({
          section: "audio",
          modelId,
          primaryProvider: modelMeta?.provider ?? keyProvider,
          fallbackProvider: failed ? null : "elevenlabs",
          reason: failed ? "all_candidates_failed" : "primary_failed",
          jobId: dbJobId,
          userId: userIdStr,
        });
      const adapter = createAudioAdapter(effModel ?? modelId, acquired, onElFallback);
      if (!adapter.poll) throw new Error(`Adapter ${modelId} has no poll()`);

      // Реконструируем AudioInput — адаптеры с фолбэком (KieElevenLabsAdapter →
      // прямой ElevenLabs) используют его для регенерации. effectivePrompt был
      // сохранён на submit-стадии; остальное лежит в job.data. Suno poll второй
      // аргумент игнорирует.
      const persistedPrompt = (existingJob?.inputData as Record<string, unknown> | null | undefined)
        ?.effectivePrompt as string | undefined;
      const pollInput: AudioInput = {
        prompt: persistedPrompt ?? prompt,
        voiceId,
        sourceAudioUrl,
        modelSettings,
      };
      audioResult = await adapter.poll(providerJobId, pollInput);

      if (!audioResult) {
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
              section: "audio",
              userId: userIdStr,
              dbJobId,
              userMessage: timeoutMsg,
              errorCode: POLL_TIMEOUT_CODE,
            }).catch(() => void 0);
          }
          // 24h-таймаут — не UserFacingError: poll крутился сутки (провайдер
          // завис / баг). Шлём tech-alert — иначе сбой тихо тонет у ops.
          await notifyTechError(new Error(`Audio poll timeout (24h): ${dbJobId}`), {
            jobId: dbJobId,
            modelId,
            section: "audio",
            userId: userIdStr,
          });
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
      }
    }

    if (!audioResult) {
      throw new Error(`Audio job ${dbJobId}: no result after stage ${stage}`);
    }

    // ── Stage 3: upload + deduct (when not already persisted) ───────────
    // Suno за один запрос может вернуть несколько треков — `audioResult.extras`
    // содержит дополнительные дорожки. Объединяем primary + extras в единый
    // список и сохраняем/шлём каждую как отдельный output.
    const tracks: Array<Omit<AudioResult, "extras">> = [
      {
        buffer: audioResult.buffer,
        url: audioResult.url,
        ext: audioResult.ext,
        contentType: audioResult.contentType,
      },
      ...(audioResult.extras ?? []),
    ];

    if (!existingOutput) {
      // Параллельный upload всех треков. Index 0 → исходный dbJobId как key
      // (back-compat с одно-output моделями); index >0 → суффикс _N.
      const uploaded = await Promise.all(
        tracks.map(async (track, i) => {
          const ext = track.ext ?? "mp3";
          const ct = `audio/${ext === "mp3" ? "mpeg" : ext}`;
          const suffix = i === 0 ? dbJobId : `${dbJobId}_${i + 1}`;
          const key = buildS3Key("audio", userIdStr, suffix, ext);
          const uploadedKey = await (
            track.buffer
              ? uploadBuffer(key, track.buffer, ct)
              : track.url
                ? uploadFromUrl(key, track.url, ct)
                : Promise.resolve(null)
          ).catch(() => null);
          return { track, s3Key: uploadedKey };
        }),
      );

      // Index 0 пишем первым — это race-detector. Если уже есть запись с
      // (jobId, 0), значит другой runner уже финализирует → бейлим без
      // double-send / double-deduct.
      try {
        await db.generationJobOutput.create({
          data: {
            jobId: dbJobId,
            index: 0,
            outputUrl: uploaded[0].track.url ?? null,
            s3Key: uploaded[0].s3Key,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          logger.info(
            { dbJobId },
            "Audio finalize: duplicate output detected — another runner is finalizing",
          );
          return;
        }
        throw err;
      }

      // Дополнительные треки. Уникальный конфликт на index>0 = тот же другой
      // runner — пропускаем; прочие ошибки пробрасываем.
      for (let i = 1; i < uploaded.length; i++) {
        try {
          await db.generationJobOutput.create({
            data: {
              jobId: dbJobId,
              index: i,
              outputUrl: uploaded[i].track.url ?? null,
              s3Key: uploaded[i].s3Key,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) continue;
          throw err;
        }
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

        // Audit-метаданные: фактический provider (через fallback state) и
        // сырая USD-цена по нему БЕЗ pricing-коэффициентов.
        const fbStateActual = readFallbackState();
        // audioResult.actualProvider ставится адаптером, когда джоба ушла не на
        // primary (KieElevenLabsAdapter → "elevenlabs" при EL-фолбэке) — он
        // приоритетнее fallback-state.
        const activeProvider =
          audioResult.actualProvider ?? fbStateActual?.effectiveProvider ?? model.provider;
        const activeModel =
          activeProvider === model.provider
            ? model
            : (findModelByProvider(activeProvider) ?? model);
        const actualCostUsd = calculateProviderCostUsd(
          activeModel,
          0,
          0,
          undefined,
          undefined,
          modelSettings,
          undefined,
          prompt.length,
        );

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

    const audioModel = AI_MODELS[modelId];
    const audioCaption = buildResultCaption(t, audioModel?.name ?? modelId, prompt, {
      cost: deductResult?.deducted,
      subscriptionBalance: deductResult?.subscriptionTokenBalance,
      tokenBalance: deductResult?.tokenBalance,
    });

    if (telegramChatId !== null) {
      // Шлём треки одной media-group'ой (или одиночным sendAudio для 1 трека),
      // caption — отдельным сообщением сразу после.
      try {
        await sendAudioBatch(telegramChatId, tracks, audioCaption, promptMessageId);
      } catch (sendErr) {
        logger.warn({ err: sendErr, dbJobId }, "Audio finalize: failed to send tracks");
      }
    } else {
      // Web: достаём финальные output-записи из БД (uploaded не в scope здесь,
      // т.к. определён внутри `if (!existingOutput)` блока выше).
      const outputs = await db.generationJobOutput
        .findMany({
          where: { jobId: dbJobId },
          select: { id: true, outputUrl: true, s3Key: true },
          orderBy: { index: "asc" },
        })
        .catch(() => []);
      await apiNotifySuccess({
        section: "audio",
        userId: userIdStr,
        dbJobId,
        outputs: outputs.map((o) => ({
          id: o.id,
          outputUrl: o.outputUrl,
          s3Key: o.s3Key,
        })),
      }).catch(() => void 0);
    }

    logger.info({ dbJobId }, "Audio job completed");
  } catch (err) {
    if (err instanceof DelayedError) throw err;
    // 24h poll-timeout уже полностью обработан in-place (DB + сообщение юзеру +
    // tech-alert) — не прогоняем через общий error-handling повторно, иначе при
    // isLastAttempt терминальный блок перезатёр бы errorCode/errorUserMessage
    // generic-значениями и продублировал бы сообщение и алерт.
    if (err instanceof UnrecoverableError && err.message === "poll timeout 24h") throw err;
    if (isRateLimitLongWindowError(err)) {
      const msg = pickGenerationFailedMessage(t, modelName, "audio");
      await db.generationJob.update({
        where: { id: dbJobId },
        data: {
          status: "failed",
          error: String(err),
          errorUserMessage: msg,
          errorCode: "RATE_LIMIT_LONG",
        },
      });
      if (telegramChatId !== null) {
        await telegram.sendMessage(telegramChatId, msg).catch(() => void 0);
      } else {
        await apiNotifyError({
          section: "audio",
          userId: userIdStr,
          dbJobId,
          userMessage: msg,
          errorCode: "RATE_LIMIT_LONG",
        }).catch(() => void 0);
      }
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
        data: { status: "failed", error: providerMsg, errorCode: classifyError(err) },
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
        // channel: "balance" роутит алерт в тему BALANCE (напр. EL quota_exceeded),
        // по умолчанию "alerts" — общая тема tech-ошибок.
        const channel = getOpsAlertChannel(err);
        if (dedupKey) {
          await notifyTechErrorThrottled(err, ctx, dedupKey, { channel });
        } else {
          await notifyTechError(err, ctx, channel);
        }
      }
      if (telegramChatId !== null) {
        await telegram.sendMessage(telegramChatId, providerMsg).catch(() => void 0);
      } else {
        await apiNotifyError({
          section: "audio",
          userId: userIdStr,
          dbJobId,
          userMessage: providerMsg,
          errorCode: classifyError(err),
        }).catch(() => void 0);
      }
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
      // Refund: токены списываются на финализации ДО фактической отправки
      // результата юзеру. Если отправка/буфер-фетч упали (провайдер 404'ит
      // outputUrl, S3 файл потерян, sendAudio Telegram'а отбит) — у юзера
      // списано, а аудио он не получил. Возвращаем `tokensSpent`. Если
      // deduct ещё не случался (submit/poll упал до Stage 2) — `tokensSpent`
      // будет null/0 → no-op.
      const dbJobNow = await db.generationJob
        .findUnique({ where: { id: dbJobId }, select: { tokensSpent: true } })
        .catch(() => null);
      const tokensSpent = dbJobNow?.tokensSpent ? Number(dbJobNow.tokensSpent) : 0;

      // Локализованное user-facing сообщение вычисляем ДО update'а, чтобы
      // записать его в `errorUserMessage` одним запросом вместе с `error`.
      const errMsg = err instanceof Error ? err.message : String(err);

      // SENSITIVE_WORD_ERROR — контент-модерация: юзер ввёл запрещённый контент
      // (копирайт / ограниченные слова) и получит понятное «измените описание».
      // Это вина юзера, а не сбой системы — единственная терминальная ошибка,
      // которую трактуем как user-facing и НЕ шлём в tech-канал.
      const isUserContentRejection = errMsg.includes("SENSITIVE_WORD_ERROR");

      let userMessage: string | null = null;
      if (isFiveXxError(err)) {
        // 5xx от Suno-провайдера (kie или apipass — оба проставляют `status`
        // через providerHttpError) — серверный сбой, не вина юзера и не
        // content-фильтр. НЕ маппим в audioGenerateFailed («измените запрос»):
        // оставляем userMessage=null → generic «временно недоступен».
      } else if (isUserContentRejection) {
        userMessage = t.errors.audioSensitiveWord;
      } else if (errMsg.includes("GENERATE_AUDIO_FAILED")) {
        userMessage = t.errors.audioGenerateFailed;
      } else if (errMsg.includes("CREATE_TASK_FAILED")) {
        userMessage = t.errors.audioCreateTaskFailed;
      } else if (errMsg.includes("Timed out")) {
        userMessage = t.errors.generationTimeout;
      }

      const finalMsg = userMessage ?? pickGenerationFailedMessage(t, modelName, "audio");

      await db.generationJob.update({
        where: { id: dbJobId },
        data: {
          status: "failed",
          error: String(err),
          errorUserMessage: finalMsg,
          errorCode: classifyError(err),
        },
      });

      if (tokensSpent > 0) {
        await refundTokens(BigInt(userIdStr), tokensSpent, modelId, "ai_audio_undelivered").catch(
          (refundErr) =>
            logger.error({ refundErr, dbJobId, tokensSpent }, "Audio failed: refund attempt threw"),
        );
        logger.warn({ dbJobId, tokensSpent }, "Audio failed after deduct: tokens refunded to user");
      }

      // Все НЕ-юзерфейсинг ошибки в терминале шлём в tech-канал — даже когда
      // юзеру показано специфичное сообщение (audioGenerateFailed и т.п.),
      // иначе провайдерские и системные сбои тихо тонут у ops. UserFacingError
      // сюда не доходят (отработаны выше в resolveUserFacingMessage-ветке со
      // своим ops-алертом). Контент-модерацию исключаем — это вина юзера.
      if (!isUserContentRejection) {
        await notifyTechError(
          err,
          {
            jobId: dbJobId,
            modelId,
            section: "audio",
            userId: userIdStr,
            attempt: job.attemptsMade,
          },
          isOpenAiBillingExhaustion(err) ? "balance" : "alerts",
        );
      }
      if (telegramChatId !== null) {
        await telegram.sendMessage(telegramChatId, finalMsg).catch(() => void 0);
      } else {
        await apiNotifyError({
          section: "audio",
          userId: userIdStr,
          dbJobId,
          userMessage: finalMsg,
        }).catch(() => void 0);
      }
    }

    throw err;
  }
}
