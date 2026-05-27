/**
 * Структурированные коды видов ошибок для `GenerationJob.errorCode`.
 *
 * Назначение: статистика и фильтрация в админке/аналитике.
 * - `error` (text) хранит понятное юзеру / провайдерское сообщение для UI.
 * - `errorCode` хранит машинно-читаемую категорию для GROUP BY / алертинга.
 *
 * Категории намеренно плоские (~20 штук). Поднимать гранулярность через
 * sub-codes — отдельная история (см. план обсуждения, было отвергнуто).
 *
 * Расширение: добавлять новую категорию ТОЛЬКО когда:
 *  - класс ошибок встречается в проде регулярно,
 *  - текущие категории не дают полезной агрегации,
 *  - есть конкретный actionable use-case (фильтр в админке, алерт).
 */

import { UserFacingError } from "./errors.js";

export const GENERATION_ERROR_CODES = [
  /** Промпт/инпут отклонены модерацией ДО генерации (BLOCKED_WORDS, NSFW prompt, copyright, public figure). */
  "INPUT_MODERATION",
  /** Сгенерированный output заблокирован модерацией (gpt-image moderation, luma image moderation). */
  "OUTPUT_MODERATION",
  /** Валидация юзер-инпута: prompt длина, обязательные поля, duration/aspect-ratio bounds. */
  "INPUT_VALIDATION",
  /** Неподдерживаемый формат/codec входного медиа (heygenVideoFormat, recraftImg2imgSvg). */
  "INPUT_MEDIA_FORMAT",
  /** Размер/dimensions входа: too small, too large, file too large. */
  "INPUT_MEDIA_SIZE",
  /** Качество входа: no face detected, multiple faces, bad image quality. */
  "INPUT_MEDIA_QUALITY",
  /** Несовместимая комбинация инпутов для конкретной модели (ProviderInputIncompatibleError). */
  "INPUT_INCOMPATIBLE",
  /** Модель структурно не поддерживает запрашиваемую фичу (img2img, syntax, language). */
  "FEATURE_NOT_SUPPORTED",
  /** 429 короткое окно (per-minute burst). После cooldown повтор обычно проходит. */
  "RATE_LIMIT_SHORT",
  /** Дневной/месячный quota, trial exhausted, tier limit. Cooldown ≥1ч. */
  "RATE_LIMIT_LONG",
  /** Провайдер недоступен: 5xx, "high demand", "service busy", task execute failed. */
  "PROVIDER_UNAVAILABLE",
  /** PoolExhaustedError, invalid API key, все ключи провайдера в cooldown. */
  "PROVIDER_AUTH",
  /** У нашего аккаунта на провайдере кончились кредиты (heygenInsufficientCredit, soulOutOfCredits). */
  "PROVIDER_INSUFFICIENT_CREDIT",
  /** Юзер забанен на провайдере или ему недоступна фича по tier'у (USER_BLOCKED, AVATAR_USAGE_NOT_PERMITTED). */
  "USER_BLOCKED",
  /** Avatar/voice удалён или не найден на стороне провайдера (avatarOrphaned, VOICE_NOT_FOUND). */
  "AVATAR_VOICE_NOT_FOUND",
  /** Транзиентный сетевой сбой: TCP/DNS/socket, undici "terminated". */
  "NETWORK_TRANSIENT",
  /** 24ч watchdog: провайдер так и не вернул результат, job завис в poll-стадии. */
  "POLL_TIMEOUT",
  /** Провайдер вернул успех, но без media (no_media_generated, пустой outputs). */
  "NO_RESULT",
  /** Наша внутренняя ошибка: S3 upload fail, doc extract fail, send original fail, неожиданный exception. */
  "INTERNAL_ERROR",
  /** Не удалось классифицировать. Fallthrough для опаковых провайдерских ошибок. */
  "UNKNOWN",
] as const;

export type GenerationErrorCode = (typeof GENERATION_ERROR_CODES)[number];

/**
 * Маппинг `UserFacingError.key` → `GenerationErrorCode`.
 * Покрывает все ключи, которые сейчас бросаются throw'ом в коде. Новые ключи
 * без явного маппинга вернут `null` — caller должен зафолбэчить на UNKNOWN
 * или дополнить таблицу. Тест `error-codes.test.ts` (TODO) можно повесить на
 * полноту: вычитать i18n keys + проверить что для каждого есть маппинг.
 */
const USER_FACING_KEY_TO_CODE: Record<string, GenerationErrorCode> = {
  // Модерация входа (промпт/референс отклонены до генерации)
  contentPolicyViolation: "INPUT_MODERATION",
  copyrightViolation: "INPUT_MODERATION",
  publicFigureViolation: "INPUT_MODERATION",
  identityPreservationNotAllowed: "INPUT_MODERATION",
  audioSensitiveWord: "INPUT_MODERATION",

  // Модерация выхода (контент сгенерирован, но post-filter отверг)
  gptImageModerationBlocked: "OUTPUT_MODERATION",

  // Валидация юзер-инпута
  promptRequired: "INPUT_VALIDATION",
  promptTooLong: "INPUT_VALIDATION",
  elevenlabsPromptTooLong: "INPUT_VALIDATION",
  sunoPromptTooLong: "INPUT_VALIDATION",
  sunoPromptTooLongNoLyrics: "INPUT_VALIDATION",
  promptNotEnglish: "INPUT_VALIDATION",
  kieImageAspectRatioOutOfRange: "INPUT_VALIDATION",
  kieVideoDurationOutOfRange: "INPUT_VALIDATION",
  klingLastFrameNeedsFirst: "INPUT_VALIDATION",
  klingMotionImageRequired: "INPUT_VALIDATION",
  klingMotionVideoRequired: "INPUT_VALIDATION",
  multishotEmpty: "INPUT_VALIDATION",
  multishotTooManyShots: "INPUT_VALIDATION",
  multishotEmptyShotPrompt: "INPUT_VALIDATION",
  multishotShotPromptTooLong: "INPUT_VALIDATION",
  multishotShotDurationOutOfRange: "INPUT_VALIDATION",
  multishotTotalDurationOutOfRange: "INPUT_VALIDATION",
  mediaSlotExpired: "INPUT_VALIDATION",

  // Формат входной медиа
  chatInvalidImage: "INPUT_MEDIA_FORMAT",
  recraftImg2imgSvgUnsupported: "INPUT_MEDIA_FORMAT",

  // Размер входа
  imageTooLarge: "INPUT_MEDIA_SIZE",
  runwayImageTooLarge: "INPUT_MEDIA_SIZE",
  kieImageTooSmall: "INPUT_MEDIA_SIZE",

  // Качество входа (face detection и т.п.)
  klingMotionImageRecognitionFailed: "INPUT_MEDIA_QUALITY",

  // Несовместимость инпутов с моделью
  midjourneySyntaxNotSupported: "FEATURE_NOT_SUPPORTED",
  modelDoesNotSupportImg2img: "FEATURE_NOT_SUPPORTED",
  modelDoesNotSupportImages: "FEATURE_NOT_SUPPORTED",

  // Avatar/voice не найдены
  avatarOrphaned: "AVATAR_VOICE_NOT_FOUND",
  soulMissingAvatar: "AVATAR_VOICE_NOT_FOUND",
  ttsVoiceUnavailable: "AVATAR_VOICE_NOT_FOUND",

  // Провайдер недоступен
  modelTemporarilyUnavailable: "PROVIDER_UNAVAILABLE",
  soulProviderUnavailable: "PROVIDER_UNAVAILABLE",

  // Сетевой сбой
  chatStreamInterrupted: "NETWORK_TRANSIENT",

  // Провайдер вернул пустоту
  generationNoResult: "NO_RESULT",

  // AI-classifier не смог сматчить — оставляем UNKNOWN, чтобы видеть таких в статистике
  aiClassifiedError: "UNKNOWN",
};

/**
 * Классификация по `UserFacingError.key`. Возвращает `null`, если err не
 * UserFacingError или key не в маппинге — caller дополняет своими проверками
 * (HeyGen/FAL/etc. через provider-classes, остаток → fallback).
 */
export function classifyUserFacingError(err: unknown): GenerationErrorCode | null {
  if (!(err instanceof UserFacingError)) return null;
  if (!err.key) return null;
  return USER_FACING_KEY_TO_CODE[err.key] ?? null;
}
