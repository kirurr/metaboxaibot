/**
 * Полная классификация ошибки джобы → `GenerationErrorCode` для записи в
 * `GenerationJob.errorCode`. Назначение: статистика по видам отказов
 * (GROUP BY errorCode), фильтры в админке, dashboards.
 *
 * Порядок проверок ВАЖЕН: более специфичные раньше общих, иначе провалится
 * на fallback. Например, RateLimit обязан проверяться раньше "HTTP 4xx →
 * INPUT_VALIDATION", т.к. 429 — тоже 4xx.
 *
 * Возвращает константу из `GENERATION_ERROR_CODES`. Дефолт — `UNKNOWN`,
 * чтобы непокрытые случаи были видны в статистике как отдельный bucket
 * (а не размывались в INTERNAL_ERROR).
 */

import {
  type GenerationErrorCode,
  classifyUserFacingError,
  UserFacingError,
  ProviderInputIncompatibleError,
} from "@metabox/shared";
import {
  classifyRateLimit,
  isFiveXxError,
  isTransientNetworkError,
  isInvalidImageError,
} from "@metabox/api/utils/rate-limit-error";
import { isProviderTemporaryUnavailable } from "@metabox/api/utils/provider-unavailable-error";
import { isPoolExhaustedError } from "@metabox/api/utils/pool-exhausted-error";
import { HeyGenApiError, isHeyGenUserFacingError } from "@metabox/api/utils/heygen-error";
import { isRunwayUserFacingError } from "@metabox/api/utils/runway-error";
import { isMinimaxUserFacingError } from "@metabox/api/utils/minimax-error";
import { isLumaUserFacingError } from "@metabox/api/utils/luma-error";
import { isReplicateUserFacingError } from "@metabox/api/utils/replicate-error";
import { hasFalUserFacingError, parseFalModelErrors } from "@metabox/api/utils/fal-error";

/** Маппинг HeyGen `code` → наш `GenerationErrorCode`. Полный список codes — в `heygen-error.ts`. */
function classifyHeyGen(err: HeyGenApiError): GenerationErrorCode {
  // Provider-wide insufficient credit (наш аккаунт). НЕ через type-guard
  // `isHeyGenProviderUnavailable` — он narrow'ит err до never в else-ветке,
  // т.к. param уже HeyGenApiError.
  if (err.enumName === "MOVIO_PAYMENT_INSUFFICIENT_CREDIT") {
    return "PROVIDER_INSUFFICIENT_CREDIT";
  }

  switch (err.code) {
    // Moderation
    case 400105: // BLOCKED_WORDS_DETECTED
    case 400168: // INAPPROPRIATE_CONTENT
    case 400625: // CELEBRITY_CONTENT
    case 402007: // CHILD_SAFETY_MODERATION_FAILED
    case 402008: // CELEBRITY_MODERATION_FAILED
    case 402009: // INAPPROPRIATE_CONTENT_MODERATION_FAILED
    case 401003: // MODERATION_POLICY_VIOLATED
    case 400680: // UNSAFE_PROMPT
      return "INPUT_MODERATION";
    // Face detection / quality
    case 40004:
    case 40005:
    case 40006:
      return "INPUT_MEDIA_QUALITY";
    // Format
    case 40010:
    case 40044:
    case 40002:
    case 400543:
    case 400111:
      return "INPUT_MEDIA_FORMAT";
    // Validation: text/duration
    case 40039:
    case 400165:
    case 400150:
    case 400128:
    case 1000022:
    case 401035:
      return "INPUT_VALIDATION";
    // Avatar/voice not found
    case 400144:
    case 400174:
    case 40090:
    case 400116:
    case 400548:
    case 400552:
    case 400551:
    case 400634:
      return "AVATAR_VOICE_NOT_FOUND";
    // Usage limits / blocks
    case 400664: // TRIAL_VIDEO_LIMIT_EXCEEDED
      return "RATE_LIMIT_LONG";
    case 400685: // AVATAR_USAGE_NOT_PERMITTED
    case 400631: // USER_BLOCKED
    case 400599: // TIER_NOT_SUPPORT
      return "USER_BLOCKED";
    default:
      // Generic HeyGen reject, текстовый паттерн уже отработан в isHeyGenUserFacingError
      return "UNKNOWN";
  }
}

/** FAL: определяем по типу первой user-facing ошибки в structured array. */
function classifyFal(err: unknown): GenerationErrorCode {
  const details = parseFalModelErrors(err);
  if (!details) return "UNKNOWN";
  const first = details.find((d) =>
    [
      "content_policy_violation",
      "no_media_generated",
      "image_too_small",
      "image_too_large",
      "image_load_error",
      "file_download_error",
      "face_detection_error",
      "file_too_large",
      "feature_not_supported",
      "invalid_archive",
      "archive_file_count_below_minimum",
      "archive_file_count_exceeds_maximum",
      "audio_duration_too_long",
      "audio_duration_too_short",
      "unsupported_audio_format",
      "unsupported_image_format",
      "unsupported_video_format",
      "video_duration_too_long",
      "video_duration_too_short",
      "string_too_short",
      "string_too_long",
      "sequence_too_short",
      "sequence_too_long",
      "greater_than",
      "greater_than_equal",
      "less_than",
      "less_than_equal",
      "multiple_of",
      "one_of",
    ].includes(d?.type),
  );
  if (!first) return "UNKNOWN";
  switch (first.type) {
    case "content_policy_violation":
      return "INPUT_MODERATION";
    case "no_media_generated":
      return "NO_RESULT";
    case "image_too_small":
    case "image_too_large":
    case "file_too_large":
      return "INPUT_MEDIA_SIZE";
    case "image_load_error":
    case "file_download_error":
      return "INPUT_MEDIA_FORMAT";
    case "face_detection_error":
      return "INPUT_MEDIA_QUALITY";
    case "unsupported_audio_format":
    case "unsupported_image_format":
    case "unsupported_video_format":
    case "invalid_archive":
      return "INPUT_MEDIA_FORMAT";
    case "feature_not_supported":
      return "FEATURE_NOT_SUPPORTED";
    default:
      return "INPUT_VALIDATION";
  }
}

/** HTTP-статус из произвольной ошибки (без deps на конкретный SDK). */
function getHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const v = e.status ?? e.statusCode ?? e.response?.status;
  return typeof v === "number" ? v : undefined;
}

/**
 * Главная функция классификации. Returns one of `GENERATION_ERROR_CODES`.
 * Никогда не бросает.
 */
export function classifyError(err: unknown): GenerationErrorCode {
  // ── 1. Наши кастомные классы (specific → general) ───────────────────────
  if (err instanceof ProviderInputIncompatibleError) return "INPUT_INCOMPATIBLE";
  if (isPoolExhaustedError(err)) return "PROVIDER_AUTH";

  if (isHeyGenUserFacingError(err)) return classifyHeyGen(err);
  if (err instanceof HeyGenApiError && err.enumName === "MOVIO_PAYMENT_INSUFFICIENT_CREDIT") {
    return "PROVIDER_INSUFFICIENT_CREDIT";
  }

  if (isRunwayUserFacingError(err)) {
    const code = err.failureCode ?? "";
    if (code.startsWith("SAFETY.INPUT.") || code === "INPUT_PREPROCESSING.SAFETY.TEXT") {
      return "INPUT_MODERATION";
    }
    if (code === "ASSET.INVALID") return "INPUT_MEDIA_FORMAT";
    return "UNKNOWN";
  }

  if (isMinimaxUserFacingError(err)) {
    switch (err.statusCode) {
      case 1026:
        return "INPUT_MODERATION";
      case 1027:
        return "OUTPUT_MODERATION";
      case 1042:
      case 2013:
        return "INPUT_VALIDATION";
      case 2056:
        return "RATE_LIMIT_LONG";
      default:
        return "UNKNOWN";
    }
  }

  if (isLumaUserFacingError(err)) {
    const lower = err.detail.toLowerCase();
    if (
      lower.includes("blacklisted words") ||
      lower.includes("frame moderation failed") ||
      lower.includes("advanced prompt moderation failed") ||
      lower.includes("prompt not allowed") ||
      lower.includes("contains ip")
    ) {
      return "INPUT_MODERATION";
    }
    if (lower.includes("failed to read user input frames")) return "INPUT_MEDIA_FORMAT";
    if (lower.includes("loop is not supported")) return "FEATURE_NOT_SUPPORTED";
    return "INPUT_VALIDATION";
  }

  if (isReplicateUserFacingError(err)) {
    switch (err.code) {
      case "E005":
      case "E006":
        return "INPUT_MODERATION";
      case "E1001":
        return "INPUT_MEDIA_SIZE"; // OOM обычно от слишком большого инпута
      case "E9243":
        return "INPUT_VALIDATION";
      case "E9825":
        return "INPUT_MEDIA_SIZE";
      default:
        return "UNKNOWN";
    }
  }

  if (hasFalUserFacingError(err)) return classifyFal(err);

  // ── 2. UserFacingError (после provider-classes, т.к. provider helpers
  //       не оборачивают всё в UserFacingError) ────────────────────────────
  const ufCode = classifyUserFacingError(err);
  if (ufCode !== null) return ufCode;
  if (err instanceof UserFacingError) {
    // Известный key мог не сматчиться — fallback: смотрим на cause
    if (err.cause !== undefined) {
      const causeCode = classifyError(err.cause);
      if (causeCode !== "UNKNOWN") return causeCode;
    }
    return "UNKNOWN";
  }

  // ── 3. Сетевые / HTTP-уровневые признаки ────────────────────────────────
  if (isTransientNetworkError(err)) return "NETWORK_TRANSIENT";

  // Rate-limit раньше generic 4xx (429 — тоже 4xx)
  const rl = classifyRateLimit(err);
  if (rl.isRateLimit) {
    return rl.isLongWindow ? "RATE_LIMIT_LONG" : "RATE_LIMIT_SHORT";
  }

  if (isProviderTemporaryUnavailable(err)) return "PROVIDER_UNAVAILABLE";
  if (isFiveXxError(err)) return "PROVIDER_UNAVAILABLE";

  if (isInvalidImageError(err)) return "INPUT_MEDIA_FORMAT";

  const status = getHttpStatus(err);
  if (status !== undefined) {
    if (status === 401 || status === 403) return "PROVIDER_AUTH";
    if (status === 404) return "AVATAR_VOICE_NOT_FOUND"; // обычно "model/voice/avatar not found"
    if (status === 413) return "INPUT_MEDIA_SIZE"; // Request Entity Too Large
    if (status >= 400 && status < 500) return "INPUT_VALIDATION";
  }

  // ── 4. Опаковая ошибка — не наша, и нам нечего сказать ──────────────────
  return "UNKNOWN";
}

/**
 * Удобный хелпер: распознать taймаут polling-стадии (24ч).
 * Используется в processor'ах, где fail вызван не throw'ом ошибки, а
 * явным таймаутом — там err недоступен, но мы знаем причину.
 */
export const POLL_TIMEOUT_CODE: GenerationErrorCode = "POLL_TIMEOUT";

/** Watchdog: orphan job в poll-стадии. */
export const WATCHDOG_ORPHAN_CODE: GenerationErrorCode = "POLL_TIMEOUT";
