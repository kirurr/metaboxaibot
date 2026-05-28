// Types
export type { Language, BotState, Section, UserDto, UserStateDto } from "./types/user.js";
export type {
  MessageRole,
  MediaType,
  JobStatus,
  ContextStrategy,
  DialogDto,
  MessageDto,
  GenerationJobDto,
} from "./types/dialog.js";
export type { TransactionType, TransactionReason, TokenTransactionDto } from "./types/token.js";
export {
  JOB_NOTIFICATIONS_CHANNEL,
  jobNotificationMessageSchema,
  jobNotificationSuccessSchema,
  jobNotificationErrorSchema,
} from "./types/job-notifications.js";
export type {
  JobNotificationMessage,
  JobNotificationSuccess,
  JobNotificationError,
} from "./types/job-notifications.js";
export type {
  AIModel,
  MediaInputMode,
  MediaInputSlot,
  MediaInputConstraints,
  ModelMode,
  ModelFamily,
  ModelFamilyMember,
  ModelSettingDef,
  ModelSettingOption,
  ModelSettingType,
  VideoShot,
  ChatInput,
  ChatOutput,
  GenerationInput,
  GenerationOutput,
} from "./types/ai.js";
export type { PromptRefCapabilities } from "./prompt-refs/canonical.js";
export { AT_TOKEN_RE, ELEMENT_CI_RE, IMAGE_CI_RE, VIDEO_CI_RE } from "./prompt-refs/canonical.js";

// Constants
export { SUPPORTED_LANGUAGES, LANGUAGE_LABELS, RTL_LANGUAGES } from "./constants/languages.js";
export { AI_MODELS, MODELS_BY_SECTION } from "./constants/models.js";
export { getModelDefaultDuration } from "./constants/models/_helpers.js";
export { FALLBACK_DESIGN_MODELS } from "./constants/models/design.models.js";
export { FALLBACK_VIDEO_MODELS } from "./constants/models/video.models.js";
export { getFallbackCandidates, isFallbackCompatible } from "./constants/models/fallback.js";
export type { FallbackSection } from "./constants/models/fallback.js";
export {
  MODEL_FAMILIES,
  FAMILIES_BY_SECTION,
  MODEL_TO_FAMILY,
} from "./constants/model-families.js";
export { BOT_STATES, SECTION_BY_STATE, WELCOME_BONUS_TOKENS } from "./constants/states.js";
export { FACE_SWAP_BUFFER_MODEL_ID } from "./constants/face-swap.js";
export {
  SUNO_NON_CUSTOM_PROMPT_MAX,
  NANO_BANANA_PROMPT_MAX,
  getSunoLimits,
  validateSunoInput,
  validateNanoBananaPromptLength,
} from "./constants/model-limits.js";
export type { SunoValidationInput } from "./constants/model-limits.js";
export { CLOTHING_TRYON_BUFFER_MODEL_ID } from "./constants/clothing-tryon.js";
export {
  PHOTO_UPSCALE_BUFFER_MODEL_ID,
  VIDEO_UPSCALE_BUFFER_MODEL_ID,
  PHOTO_UPSCALE_MODEL_ID,
  VIDEO_UPSCALE_MODEL_ID,
  VIDEO_UPSCALE_FACTORS,
  videoResolutionTier,
  videoFpsTier,
} from "./constants/upscale.js";
export {
  OBJECT_REMOVAL_MODEL_ID,
  OBJECT_REMOVAL_BUFFER_MODEL_ID,
  OBJECT_REMOVAL_PROMPT_MAX_CHARS,
  OBJECT_REMOVAL_SETTINGS,
  buildObjectRemovalPrompt,
} from "./constants/object-removal.js";
export {
  PHOTO_ANIMATE_MODEL_ID,
  PHOTO_ANIMATE_DURATION_SEC,
  PHOTO_ANIMATE_RESOLUTION,
  PHOTO_ANIMATE_PROMPT,
  snapAspectRatio,
} from "./constants/photo-animate.js";
export {
  MULTISHOT_MAX_SHOTS,
  MULTISHOT_SHOT_DURATION_MIN,
  MULTISHOT_SHOT_DURATION_MAX,
  MULTISHOT_TOTAL_DURATION_MIN,
  MULTISHOT_TOTAL_DURATION_MAX,
  MULTISHOT_PROMPT_MAX_LENGTH,
  parseVideoShots,
  sumShotDuration,
} from "./constants/multishot.js";
export {
  COPY_MOTION_MODEL_ID,
  COPY_MOTION_BUFFER_MODEL_ID,
  COPY_MOTION_SLOT_IMAGE,
  COPY_MOTION_SLOT_VIDEO,
  COPY_MOTION_IMAGE_MAX_BYTES,
  COPY_MOTION_VIDEO_MAX_BYTES,
  COPY_MOTION_VIDEO_MIN_SEC,
  COPY_MOTION_VIDEO_MAX_SEC,
} from "./constants/copy-motion.js";
export {
  PHOTO_CREATE_MODEL_ID,
  PHOTO_CREATE_BUFFER_MODEL_ID,
  PHOTO_CREATE_PROMPT_MAX_CHARS,
  PHOTO_CREATE_AR_OPTIONS,
  PHOTO_CREATE_RES_OPTIONS,
  snapPhotoCreateAr,
} from "./constants/photo-create.js";
export type { PhotoCreateArOption, PhotoCreateResOption } from "./constants/photo-create.js";
export { PLANS } from "./constants/plans.js";
export type { Plan } from "./constants/plans.js";
export { ONE_SHOT_SETTING_KEYS } from "./constants/model-settings-keys.js";
export {
  VOICE_CLONE_RETURN_TTL_SECONDS,
  voiceCloneReturnRedisKey,
} from "./constants/voice-clone-return.js";
export type { VoiceCloneReturnTarget } from "./constants/voice-clone-return.js";
export {
  KIE_ELEVENLABS_VOICES,
  KIE_ELEVENLABS_VOICE_IDS,
  KIE_ELEVENLABS_DEFAULT_VOICE_ID,
  kieElevenLabsVoicePreviewUrl,
} from "./constants/kie-elevenlabs-voices.js";
export type { KieElevenLabsVoice } from "./constants/kie-elevenlabs-voices.js";

// Errors
export {
  UserFacingError,
  resolveUserFacingError,
  ProviderInputIncompatibleError,
} from "./errors.js";
export { GENERATION_ERROR_CODES, classifyUserFacingError } from "./error-codes.js";
export type { GenerationErrorCode } from "./error-codes.js";

// Web token (URL-based auth for KeyboardButtonWebApp where initData is unavailable)
export { generateWebToken, verifyWebToken, WebTokenError } from "./webtoken.js";
export type { VerifyWebTokenResult, WebTokenErrorCode } from "./webtoken.js";

// Config
export { config } from "./config.js";
export type { Config } from "./config.js";

// Crypto: симметричное шифрование секретов (provider keys, proxy passwords)
export { encryptSecret, decryptSecret, maskKey } from "./crypto/secret-vault.js";

// Model modes: per-model operation modes (t2v / i2v / r2v) and slot filtering
export {
  getResolvedModes,
  defaultModeId,
  resolveActiveMode,
  getActiveSlots,
  isKnownModeId,
} from "./utils/model-modes.js";

// i18n
export {
  getT,
  preloadLocales,
  buildDialogHint,
  buildResultCaption,
  formatGenerationCostLine,
  pickGenerationFailedMessage,
  resolveUserFacingErrorVariant,
} from "./i18n/index.js";
export type { Translations, GenerationFailedSection } from "./i18n/index.js";
export {
  MODEL_TRANSLATIONS,
  SETTING_TRANSLATIONS,
  resolveModelDisplay,
} from "@metabox/shared-browser";
export type { ModelTranslation, SettingTranslation } from "@metabox/shared-browser";
