/**
 * Provider-level fallback wrapper для submit-стадии image/video processor'ов.
 *
 * Идея: у одной и той же модели (modelId) может быть зарегистрировано
 * несколько AIModel-определений с разными provider'ами — primary в
 * AI_MODELS, плюс fallbacks в FALLBACK_*_MODELS. Когда primary недоступен,
 * мы пробуем fallback'ов по очереди: для каждого вызываем acquireKey + submit.
 * Первый успешный submit возвращается с указанием effectiveProvider; processor
 * сохраняет его в inputData.fallback и использует на poll-стадии.
 *
 * Билинг всегда по primary — fallback прозрачен для пользователя.
 *
 * Триггеры fallback (consrative, согласовано с пользователем):
 *   - PoolExhaustedError (все ключи провайдера в cooldown)
 *   - long-window 429 (cooldownMs > LONG_WINDOW_THRESHOLD_MS)
 *   - persistent 5xx (когда `attemptsMade >= 2`, т.е. 3-я попытка BullMQ)
 *
 * НЕ триггеры (defer same job, как submitWithThrottle):
 *   - short-window 429 — дефёрим job, BullMQ retry с другим ключом из пула
 *
 * Pre-check long-cooldown: для каждого кандидата сначала проверяем
 * provider-wide маркер в Redis. Если выставлен — пропускаем без acquireKey'a.
 *
 * Env-only режим (acquired.keyId === null): на любой 429 дополнительно к
 * ключевому throttle тригерим model-level gate (`tripThrottle(modelId)`),
 * чтобы избежать thundering herd на env-only моделях (раньше это делал
 * submitWithThrottle).
 */

import type { Job } from "bullmq";
import type { AIModel } from "@metabox/shared";
import { ProviderInputIncompatibleError, UserFacingError } from "@metabox/shared";
import {
  acquireKey,
  markRateLimited,
  recordSuccess,
  recordError,
  type AcquiredKey,
} from "@metabox/api/services/key-pool";
import {
  isProviderInLongCooldown,
  markProviderLongCooldown,
  getProviderLongCooldownRemaining,
  tripThrottle,
} from "@metabox/api/services/throttle";
import { isPoolExhaustedError } from "@metabox/api/utils/pool-exhausted-error";
import {
  classifyRateLimit,
  isFiveXxError,
  LONG_WINDOW_THRESHOLD_MS,
} from "@metabox/api/utils/rate-limit-error";
import { resolveKeyProviderForModel } from "@metabox/api/ai/key-provider";
import { isProviderTemporaryUnavailable } from "@metabox/api/utils/provider-unavailable-error";
import { isKieCreditsExhausted } from "@metabox/api/utils/kie-error";
import {
  isOpenAiBillingExhaustion,
  OPENAI_BILLING_KEY_COOLDOWN_MS,
  MAX_BILLING_KEY_RETRIES,
} from "@metabox/api/utils/openai-billing-error";
import { maskKey } from "@metabox/shared";
import { logger } from "../logger.js";
import { delayJob } from "./delay-job.js";
import { notifyRateLimit, notifyFallback, notifyTechErrorThrottled } from "./notify-error.js";
import { RateLimitLongWindowError } from "./submit-with-throttle.js";

/** На какой попытке (BullMQ attemptsMade) разрешён fallback по 5xx. */
const PERSISTENT_5XX_ATTEMPT_THRESHOLD = 2;

const MIN_DEFER_MS = 1_000;
const JITTER_MS = 2_000;
function withJitter(ms: number): number {
  return Math.max(MIN_DEFER_MS, ms + Math.floor(Math.random() * JITTER_MS));
}

/**
 * UX cap на длительность одного defer-цикла. Без cap'а юзер мог бы ждать часами,
 * пока истечёт TTL primary'ного long-cooldown маркера (например, 100 мин). С cap'ом
 * BullMQ просыпается каждые ≤10 мин, перепроверяет состояние провайдера, и если
 * primary всё ещё лежит — defer'ит снова (counter инкрементится).
 */
const MAX_FALLBACK_DEFER_MS = 10 * 60 * 1000;

/**
 * Circuit breaker: после N defer'ов подряд для одного и того же job'а отказываемся
 * и фейлим терминально через RateLimitLongWindowError. Защита от бесконечного
 * loop'а когда provider chain полностью dead.
 *
 * `delayJob` использует `moveToDelayed`, который НЕ инкрементирует BullMQ
 * `attemptsMade` — настройка `attempts: N` на queue не сработала бы. Поэтому
 * считаем сами через `inputData.fallbackDeferCount`.
 *
 * 6 × 10 мин ≈ 1 час максимум — достаточно для большинства реальных
 * recovery-сценариев, после чего юзер получит ошибку и попробует позже сам.
 */
const MAX_FALLBACK_DEFERS = 6;

export type FallbackReason =
  | "pool_exhausted"
  | "long_window_rate_limit"
  | "persistent_5xx"
  | "provider_long_cooldown_marker"
  | "kie_credits_exhausted"
  | "openai_billing_exhausted"
  | "unknown_error";

export interface FallbackCandidateAttempt {
  provider: string;
  outcome:
    | "success"
    | "skipped_long_cooldown"
    | "pool_exhausted"
    | "long_window"
    | "persistent_5xx"
    | "provider_unavailable"
    | "incompatible_input"
    | "kie_credits_exhausted"
    | "openai_billing_exhausted"
    | "unknown_error";
  error?: string;
}

export interface SubmitWithFallbackResult<T> {
  /** Что вернул успешный submit/generate. */
  result: T;
  /** Acquired key для этого успешного запроса (нужен для providerKeyId attribution). */
  acquired: AcquiredKey;
  /** Provider строка модели, на которой был успех (`primary.provider` или `fallback.provider`). */
  effectiveProvider: string;
  /** Сама AIModel, на которой случился успех — нужна для poll-стадии createAdapter. */
  effectiveModel: AIModel;
  /** Был ли это fallback (effectiveProvider !== primary.provider). */
  usedFallback: boolean;
  /** История попыток (для логов / debug). */
  attempts: FallbackCandidateAttempt[];
}

interface SubmitWithFallbackOptions<T, D extends object> {
  primaryModel: AIModel;
  /** Кандидаты-fallback'ы. Передаются уже отфильтрованные по совместимости (mediaInputs). */
  fallbacks: AIModel[];
  /** "image" | "video" — для логов и нотификаций. */
  section: string;
  /** BullMQ job — нужен для defer'а. */
  job: Job<D>;
  token?: string;
  /** Доступен ли fallback по persistent 5xx? Передаётся `job.attemptsMade >= 2`. */
  allowFiveXxFallback: boolean;
  /** ID DB job'а — для алертов/логов. */
  jobId?: string;
  /** User ID для алертов. */
  userId?: string;
  /**
   * Set provider'ов для пропуска. Используется при poll-stage re-submit'е, когда
   * primary уже доказал что с ним проблема (KIE 5xx terminal failure) — в новой
   * BullMQ-задаче submit-stage должен скипнуть его и сразу взять fallback.
   * Передаётся через `inputData.fallback.attemptedProviders`.
   */
  skipProviders?: Set<string>;
  /**
   * Реальный submit-вызов. Принимает acquired key + модель для инстанцирования
   * адаптера. Должен либо вернуть результат, либо бросить ошибку (PoolExhausted,
   * 429, 5xx, etc.) — НЕ дефёрить и НЕ оборачивать ошибки.
   */
  submit: (model: AIModel, acquired: AcquiredKey) => Promise<T>;
}

/**
 * Пробует primary, потом каждого fallback'а. На каждом кандидате:
 *  1. Если provider-wide long-cooldown маркер выставлен → пропустить (set
 *     lastPoolExhausted с актуальным TTL для defer'а в конце).
 *  2. acquireKey → если PoolExhausted → пропустить (set lastPoolExhausted).
 *  3. submit() → если успех → вернуть SubmitWithFallbackResult.
 *  4. На 429: classifyRateLimit + markRateLimited на ключе.
 *     - long-window → markProviderLongCooldown, notify, переход на следующего.
 *     - short window → defer SAME job (как submitWithThrottle), бросаем
 *       DelayedError. На fallback'ах short-window тоже defer (мы уже коммитнулись
 *       не трогать primary дальше; даём короткую паузу на восстановление ключей).
 *  5. На 5xx (если allowFiveXxFallback) → пропустить.
 *  6. На любую другую ошибку → бросить наверх.
 *
 * Если ВСЕ кандидаты упали без short-429-defer:
 *  - Если хоть один был long-window/PoolExhausted/marker → defer job.
 *  - Иначе (все 5xx с allowFiveXxFallback) бросаем последнюю ошибку наверх.
 */
export async function submitWithFallback<T, D extends object>(
  opts: SubmitWithFallbackOptions<T, D>,
): Promise<SubmitWithFallbackResult<T>> {
  const allCandidates = [opts.primaryModel, ...opts.fallbacks];
  // Skip provider'ы из opts.skipProviders (poll-stage re-submit pattern: primary
  // уже терминально упал, в новой задаче не пробуем его повторно).
  const candidates = opts.skipProviders
    ? allCandidates.filter((m) => !opts.skipProviders!.has(m.provider))
    : allCandidates;
  const attempts: FallbackCandidateAttempt[] = [];
  let lastError: unknown;
  // Минимальный delay из всех кандидатов, готовых defer'нуть. MIN (а не MAX),
  // чтобы проснуться как только первый кандидат восстановится — иначе ждали
  // бы пока самый «лежачий» провайдер выйдет из cooldown'а.
  let lastDeferDelay: number | null = null;
  const updateDeferDelay = (candidateMs: number): void => {
    // Fix: PoolExhaustedError(provider, 0) бросается, когда у provider'а нет
    // активных ключей в пуле — это не "ждать 0мс", а "этот provider в принципе
    // не работает". Не позволяем такому 0 поглощать useful TTL других
    // candidates через MIN. Игнорируем noise-значения.
    if (candidateMs <= 0) return;
    lastDeferDelay = lastDeferDelay === null ? candidateMs : Math.min(lastDeferDelay, candidateMs);
  };

  candidateLoop: for (const candidate of candidates) {
    const isPrimary = candidate === opts.primaryModel;
    const candidateProvider = candidate.provider;
    const keyProvider = resolveKeyProviderForModel(candidate);

    // 1. Pre-check provider-wide long-cooldown marker.
    if (await isProviderInLongCooldown(keyProvider).catch(() => false)) {
      attempts.push({ provider: candidateProvider, outcome: "skipped_long_cooldown" });
      // Используем актуальный TTL для defer'а — иначе хардкод-60s заставит
      // BullMQ просыпаться слишком часто и каждый раз снова skip'аться.
      const remaining = await getProviderLongCooldownRemaining(keyProvider).catch(() => null);
      updateDeferDelay(remaining ?? 60_000);
      logger.info(
        { jobId: opts.jobId, modelId: opts.primaryModel.id, provider: keyProvider, remaining },
        "submitWithFallback: skipping candidate — provider in long cooldown",
      );
      continue candidateLoop;
    }

    // Key-level retry loop вокруг acquireKey + submit. При OpenAI billing на
    // ключе выводим его из ротации и берём ДРУГОЙ ключ того же провайдера
    // (acquireKey пропустит throttled) — `continue` к началу этого while.
    // Все остальные ошибки → `continue candidateLoop`/`throw` (к fallback-
    // кандидату или наверх) как раньше.
    let billingKeyAttempts = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // 2. acquireKey
      // Для gpt-image-1.5 берём ключ из low-priority группы первым делом
      // (модель раз в месяц юзается → иначе холодный ключ никогда не получит
      // трафика и tier у OpenAI не растёт). Fallback на high-priority встроен
      // в acquireKey, если все low-priority throttled — возьмёт обычным
      // порядком.
      let acquired: AcquiredKey;
      try {
        acquired =
          candidate.id === "gpt-image-1.5"
            ? await acquireKey(keyProvider, { inverted: true })
            : await acquireKey(keyProvider);
      } catch (err) {
        if (isPoolExhaustedError(err)) {
          attempts.push({ provider: candidateProvider, outcome: "pool_exhausted" });
          updateDeferDelay(err.retryAfterMs);
          logger.info(
            { jobId: opts.jobId, modelId: opts.primaryModel.id, provider: keyProvider },
            "submitWithFallback: candidate pool exhausted — trying next",
          );
          continue candidateLoop;
        }
        // Не PoolExhausted — это что-то системное. Бросаем наверх.
        throw err;
      }

      // 3. Submit.
      try {
        const result = await opts.submit(candidate, acquired);
        // Success.
        if (acquired.keyId) void recordSuccess(acquired.keyId);
        attempts.push({ provider: candidateProvider, outcome: "success" });

        if (!isPrimary) {
          const reason = inferFallbackReason(attempts);
          logger.warn(
            {
              jobId: opts.jobId,
              event: "provider_fallback",
              section: opts.section,
              modelId: opts.primaryModel.id,
              primaryProvider: opts.primaryModel.provider,
              fallbackProvider: candidateProvider,
              reason,
              attempts,
            },
            "submitWithFallback: switched to fallback provider",
          );
          void notifyFallback({
            section: opts.section,
            modelId: opts.primaryModel.id,
            primaryProvider: opts.primaryModel.provider,
            fallbackProvider: candidateProvider,
            reason,
            jobId: opts.jobId,
            userId: opts.userId,
          });
        }

        return {
          result,
          acquired,
          effectiveProvider: candidateProvider,
          effectiveModel: candidate,
          usedFallback: !isPrimary,
          attempts,
        };
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        const cls = classifyRateLimit(err, keyProvider);

        // OpenAI billing исчерпан — `billing_hard_limit_reached` (400) или
        // `insufficient_quota` (429). Не recordError'им (это не сбой ключа), НО
        // выводим ключ из ротации через markRateLimited на
        // OPENAI_BILLING_KEY_COOLDOWN_MS (per-key, НЕ provider-wide) и пробуем
        // ДРУГОЙ ключ того же провайдера (key-level retry) — спасает запрос даже
        // у моделей без fallback. Дедуп'нутый алерт в balance-тему. Если все
        // ключи провайдера billing-dead — следующий acquireKey бросит
        // PoolExhausted → уйдём к fallback-кандидату.
        if (isOpenAiBillingExhaustion(err)) {
          if (acquired.keyId) {
            void markRateLimited(acquired.keyId, OPENAI_BILLING_KEY_COOLDOWN_MS, "openai billing");
          }
          const billingDedupKey = acquired.keyId
            ? `openai-billing-exhaustion:${acquired.keyId}`
            : "openai-billing-exhaustion";
          void notifyTechErrorThrottled(
            err instanceof Error ? err : new Error(message),
            { section: opts.section, modelId: opts.primaryModel.id, jobId: opts.jobId },
            billingDedupKey,
            { channel: "balance" },
          );
          logger.warn(
            {
              jobId: opts.jobId,
              provider: candidateProvider,
              modelId: opts.primaryModel.id,
              keyId: acquired.keyId,
              keyMask: maskKey(acquired.apiKey),
              attempt: billingKeyAttempts + 1,
            },
            "submitWithFallback: OpenAI billing exhausted — key quarantined",
          );
          billingKeyAttempts++;
          if (billingKeyAttempts < MAX_BILLING_KEY_RETRIES) {
            continue; // key-level retry: следующий ключ того же провайдера
          }
          // Budget исчерпан → к fallback-кандидату.
          attempts.push({
            provider: candidateProvider,
            outcome: "openai_billing_exhausted",
            error: message.slice(0, 200),
          });
          continue candidateLoop;
        }

        // Provider temporarily unavailable (e.g. KIE 422 "high demand") — узел
        // провайдера перегружен, retry на том же или соседнем ключе того же
        // провайдера не помогает. Пробуем следующего кандидата (другую модель/
        // провайдера). Эти же паттерны матчатся и в RATE_LIMIT_PATTERNS — если
        // следующего кандидата нет (зацикливаемся на том же primary), управление
        // упадёт ниже в rate-limit defer-цикл и сохранится legacy behavior.
        if (isProviderTemporaryUnavailable(err)) {
          if (acquired.keyId) void recordError(acquired.keyId, message.slice(0, 500));
          attempts.push({
            provider: candidateProvider,
            outcome: "provider_unavailable",
            error: message.slice(0, 200),
          });
          logger.warn(
            {
              jobId: opts.jobId,
              provider: candidateProvider,
              err: message.slice(0, 200),
            },
            "submitWithFallback: provider temporarily unavailable — trying next candidate",
          );
          // Не выставляем lastDeferDelay — если все unavailable, бросим ошибку наверх.
          continue candidateLoop;
        }

        // KIE-аккаунт без кредитов (402) — provider-wide состояние, ни retry,
        // ни смена ключа, ни cooldown не помогут. Пробуем следующего кандидата
        // (fallback-провайдера). Параллельно — ops-алёрт в balance-канал (дедуп):
        // KIE надо пополнить независимо от того, спас ли fallback этот запрос.
        if (isKieCreditsExhausted(err)) {
          // НЕ вызываем recordError на ключе: 402 — account-wide состояние
          // (кончились кредиты), а не сбой конкретного ключа.
          attempts.push({
            provider: candidateProvider,
            outcome: "kie_credits_exhausted",
            error: message.slice(0, 200),
          });
          void notifyTechErrorThrottled(
            err instanceof Error ? err : new Error(message),
            { section: opts.section, modelId: opts.primaryModel.id, jobId: opts.jobId },
            "kie-credits-exhausted",
            { channel: "balance" },
          );
          logger.warn(
            { jobId: opts.jobId, provider: candidateProvider, modelId: opts.primaryModel.id },
            "submitWithFallback: KIE credits exhausted — trying next candidate",
          );
          continue candidateLoop;
        }

        if (cls.isRateLimit) {
          // Per-key throttle: bad key карантинится, остальные ключи провайдера
          // продолжают работу. notifyRateLimit вызываем всегда per-key (как делал
          // оригинальный submitWithThrottle). Для env-mode используем `tripThrottle`
          // с проверкой возврата чтобы не спамить tg-канал из нескольких workers.
          let shouldNotify = true;
          if (acquired.keyId) {
            void markRateLimited(acquired.keyId, cls.cooldownMs, cls.reason);
          } else {
            // Env-only режим — model-level gate (legacy thundering-herd protection).
            // tripThrottle через SETNX вернёт false если gate уже стоит → не дублируем нотификацию.
            shouldNotify = await tripThrottle(opts.primaryModel.id, cls.cooldownMs, cls.reason);
          }

          const isLong = cls.isLongWindow || cls.cooldownMs > LONG_WINDOW_THRESHOLD_MS;

          if (isLong) {
            // Provider-wide marker блокирует ВСЕ ключи провайдера на cooldownMs.
            // Ставим его ТОЛЬКО когда cooldownMs действительно длинный (>1ч) —
            // это надёжный signal что провайдер реально лежит (например, вернул
            // Retry-After: 3600+).
            //
            // Pattern-matched isLongWindow ("insufficient credits", "trial limit",
            // "out of credits", "account suspended" и т.п.) с коротким cooldown
            // (60с дефолт) — это per-account ошибка одного ключа, НЕ отказ всего
            // провайдера. У соседних ключей того же провайдера деньги/доступ
            // могут быть в порядке. Не блокируем их ради per-key проблемы —
            // markRateLimited на конкретный keyId уже изолирует "плохой" ключ,
            // следующий submit acquireKey'ем подберёт здоровый.
            if (cls.cooldownMs > LONG_WINDOW_THRESHOLD_MS) {
              void markProviderLongCooldown(keyProvider, cls.cooldownMs, cls.reason);
            }
            if (shouldNotify) {
              void notifyRateLimit({
                section: opts.section,
                modelId: opts.primaryModel.id,
                cooldownMs: cls.cooldownMs,
                reason: cls.reason,
                isLongWindow: true,
                err,
                jobId: opts.jobId,
              });
            }
            attempts.push({
              provider: candidateProvider,
              outcome: "long_window",
              error: cls.reason,
            });
            updateDeferDelay(cls.cooldownMs);
            continue candidateLoop;
          }

          // Short-window 429: НЕ триггер fallback'а (consrative). Дефёрим текущий
          // job — BullMQ retry с другим ключом из того же пула. То же поведение
          // что у оригинального submitWithThrottle.
          if (shouldNotify) {
            void notifyRateLimit({
              section: opts.section,
              modelId: opts.primaryModel.id,
              cooldownMs: cls.cooldownMs,
              reason: cls.reason,
              isLongWindow: false,
              err,
              jobId: opts.jobId,
            });
          }
          const delay = withJitter(cls.cooldownMs);
          logger.info(
            {
              jobId: opts.jobId,
              modelId: opts.primaryModel.id,
              provider: candidateProvider,
              delay,
              reason: cls.reason,
            },
            "submitWithFallback: short-window 429 — deferring (no fallback for short window)",
          );
          await delayJob(opts.job, opts.job.data as Record<string, unknown>, delay, opts.token);
          throw new Error("unreachable: delayJob did not throw");
        }

        // Adapter signals this input is structurally incompatible with the provider
        // but another candidate can handle it — skip immediately, no key penalty.
        if (err instanceof ProviderInputIncompatibleError) {
          attempts.push({ provider: candidateProvider, outcome: "incompatible_input" });
          logger.info(
            { jobId: opts.jobId, provider: candidateProvider, reason: err.message },
            "submitWithFallback: provider incompatible with input — skipping to next candidate",
          );
          continue candidateLoop;
        }

        // 5xx — fallback только если этот BullMQ job уже несколько раз пытался.
        if (isFiveXxError(err) && opts.allowFiveXxFallback) {
          if (acquired.keyId) void recordError(acquired.keyId, message.slice(0, 500));
          attempts.push({
            provider: candidateProvider,
            outcome: "persistent_5xx",
            error: message.slice(0, 200),
          });
          logger.warn(
            {
              jobId: opts.jobId,
              provider: candidateProvider,
              attemptsMade: opts.allowFiveXxFallback,
              err: message.slice(0, 200),
            },
            "submitWithFallback: 5xx after retries — trying fallback",
          );
          // Не выставляем lastDeferDelay — если все 5xx-ят, бросим оригинальную ошибку наверх.
          continue candidateLoop;
        }

        // 5xx на ранних попытках (allowFiveXxFallback=false) — известная категория,
        // НЕ fallback. Пробрасываем наверх, чтобы BullMQ ретраил job с другим ключом
        // того же провайдера. На attemptsMade >= threshold ветка выше уже даст
        // fallback'у шанс.
        //
        // UserFacingError-guard на recordError: пользовательская ошибка (пустой
        // ввод, content policy, невалидный формат) — ключ работал исправно,
        // отказался обрабатывать сам провайдер на уровне content'а запроса.
        // Без guard'а здоровые ключи помечались бы как сбойные на каждом таком
        // запросе.
        if (isFiveXxError(err)) {
          if (acquired.keyId && !(err instanceof UserFacingError)) {
            void recordError(acquired.keyId, message.slice(0, 500));
          }
          throw err;
        }

        // Unknown / unclassified error (4xx non-429, validation, content policy,
        // network reset, неизвестные строки в теле ответа, etc.). Раньше throw'или
        // сразу — пользователь получал failure, даже если соседний провайдер мог бы
        // справиться. Теперь best-effort: пробуем следующего кандидата, плюс шлём
        // burst-throttled алерт в tech-чат (дедуп по provider + первым 80 символам
        // сообщения) — чтобы ops видели «фактически неклассифицированную» категорию
        // и могли добавить classifier при повторении паттерна. Если все кандидаты
        // упали так же — lastError пробросится наверх ниже (`throw lastError`),
        // юзер получит обычную failure-кнопку, processor добавит свой top-level
        // notifyTechError.
        //
        // UserFacingError-guard на recordError — см. комментарий в 5xx-ветке выше.
        if (acquired.keyId && !(err instanceof UserFacingError)) {
          void recordError(acquired.keyId, message.slice(0, 500));
        }
        attempts.push({
          provider: candidateProvider,
          outcome: "unknown_error",
          error: message.slice(0, 200),
        });
        void notifyTechErrorThrottled(
          err instanceof Error ? err : new Error(message),
          {
            section: opts.section,
            modelId: opts.primaryModel.id,
            jobId: opts.jobId,
            userId: opts.userId,
          },
          `unknown-error:${candidateProvider}:${message.slice(0, 80)}`,
        );
        logger.warn(
          {
            jobId: opts.jobId,
            provider: candidateProvider,
            modelId: opts.primaryModel.id,
            err: message.slice(0, 200),
          },
          "submitWithFallback: unknown error — trying next candidate",
        );
        continue candidateLoop;
      }
    }
  }

  // Все кандидаты упали без явного defer'а через short 429.
  logger.error(
    {
      jobId: opts.jobId,
      event: "provider_fallback",
      section: opts.section,
      modelId: opts.primaryModel.id,
      primaryProvider: opts.primaryModel.provider,
      attempts,
    },
    "submitWithFallback: all candidates exhausted",
  );
  // Если последняя ошибка — OpenAI billing-исчерпание, шлём all_candidates_failed
  // в balance тему (а не в fallback тему). Иначе при пустом OpenAI billing'е
  // эти алерты спамят общий fallback-канал вперемешку с обычными fallback'ами.
  // Дополнительно к этому per-attempt дедуп выше через notifyTechErrorThrottled
  // ("openai-billing-exhaustion") уже подавит большую часть шума, но здесь
  // алерт фокусируется на «все кандидаты упали».
  const allCandidatesChannel = isOpenAiBillingExhaustion(lastError) ? "balance" : undefined;
  void notifyFallback({
    section: opts.section,
    modelId: opts.primaryModel.id,
    primaryProvider: opts.primaryModel.provider,
    fallbackProvider: null,
    reason: "all_candidates_failed",
    jobId: opts.jobId,
    userId: opts.userId,
    channel: allCandidatesChannel,
  });

  // Если хоть один кандидат указал, что готов defer'нуть (PoolExhausted /
  // long-window / cooldown marker) — defer job.
  if (lastDeferDelay !== null) {
    // Fix: circuit breaker. delayJob использует moveToDelayed, который НЕ
    // инкрементирует BullMQ attemptsMade — без своего счётчика job был бы в
    // бесконечном loop'е если provider chain полностью dead. Считаем defer'ы
    // в inputData.fallbackDeferCount, после MAX — терминально фейлим job через
    // RateLimitLongWindowError (processor покажет user-facing "model unavailable").
    const jobData = opts.job.data as Record<string, unknown>;
    const currentDeferCount =
      typeof jobData.fallbackDeferCount === "number" ? jobData.fallbackDeferCount : 0;
    const newDeferCount = currentDeferCount + 1;

    if (newDeferCount >= MAX_FALLBACK_DEFERS) {
      logger.error(
        {
          jobId: opts.jobId,
          modelId: opts.primaryModel.id,
          deferCount: newDeferCount,
          maxDefers: MAX_FALLBACK_DEFERS,
        },
        "submitWithFallback: max defers exceeded — failing job terminally",
      );
      throw new RateLimitLongWindowError(opts.primaryModel.id, lastDeferDelay);
    }

    // Fix: cap defer delay на 10 мин. Без cap'а юзер мог бы ждать часами,
    // пока истечёт TTL primary'ного long-cooldown маркера. Cap → BullMQ просыпается
    // каждые ≤10 мин и перепроверяет состояние; если provider всё ещё лежит —
    // defer'ит снова (counter инкрементится в сторону MAX_FALLBACK_DEFERS).
    const cappedDelay = Math.min(lastDeferDelay, MAX_FALLBACK_DEFER_MS);
    const delay = withJitter(cappedDelay);

    logger.info(
      {
        jobId: opts.jobId,
        modelId: opts.primaryModel.id,
        delay,
        rawDelay: lastDeferDelay,
        capped: lastDeferDelay > MAX_FALLBACK_DEFER_MS,
        deferCount: newDeferCount,
      },
      "submitWithFallback: defering job (all candidates pool-exhausted/long-cooldown)",
    );
    await delayJob(opts.job, { ...jobData, fallbackDeferCount: newDeferCount }, delay, opts.token);
    throw new Error("unreachable: delayJob did not throw");
  }

  // Все 5xx — бросаем оригинальную ошибку (BullMQ retries / failure).
  // long-window/PoolExhausted/marker уже выставили lastDeferDelay → ушли в defer выше.
  if (lastError) throw lastError;
  throw new Error(`submitWithFallback: no candidates available for ${opts.primaryModel.id}`);
}

function inferFallbackReason(attempts: FallbackCandidateAttempt[]): FallbackReason {
  // Берём outcome первого кандидата (primary) как причину.
  const primaryOutcome = attempts[0]?.outcome;
  if (primaryOutcome === "skipped_long_cooldown") return "provider_long_cooldown_marker";
  if (primaryOutcome === "pool_exhausted") return "pool_exhausted";
  if (primaryOutcome === "long_window") return "long_window_rate_limit";
  if (primaryOutcome === "persistent_5xx") return "persistent_5xx";
  if (primaryOutcome === "kie_credits_exhausted") return "kie_credits_exhausted";
  if (primaryOutcome === "openai_billing_exhausted") return "openai_billing_exhausted";
  if (primaryOutcome === "unknown_error") return "unknown_error";
  return "pool_exhausted";
}

// Re-export для удобства caller'ов, которые хотят определить allowFiveXxFallback.
export { PERSISTENT_5XX_ATTEMPT_THRESHOLD };
