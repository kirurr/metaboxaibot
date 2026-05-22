import type { Section } from "./user.js";
import type { ContextStrategy } from "./dialog.js";
import type { PromptRefCapabilities } from "../prompt-refs/canonical.js";

// ── Model settings condition types ───────────────────────────────────────────

/** Atomic condition: matches based on the value of another setting key. */
export interface SettingCondition {
  /** Key of another setting to inspect. */
  key: string;
  /** Unavailable when the value strictly equals this. */
  eq?: unknown;
  /** Unavailable when the value does NOT strictly equal this. */
  neq?: unknown;
  /** Unavailable when the key has a meaningful value (non-empty string / true / non-zero number / non-empty array). */
  present?: true;
  /** Unavailable when the key is falsy / empty. */
  absent?: true;
}

export interface AndCondition {
  and: UnavailableRule[];
}
export interface OrCondition {
  or: UnavailableRule[];
}

/** Composable condition tree used in `ModelSettingDef.unavailableIf`. */
export type UnavailableRule = SettingCondition | AndCondition | OrCondition;

// ── Model settings types ──────────────────────────────────────────────────────

export type ModelSettingType =
  | "select"
  | "dropdown"
  | "slider"
  | "toggle"
  | "text"
  | "number"
  | "voice-picker"
  | "did-voice-picker"
  | "elevenlabs-voice-picker"
  | "openai-voice-picker"
  | "cartesia-voice-picker"
  | "color"
  | "avatar-picker"
  | "motion-picker"
  | "soul-picker"
  | "soul-style-picker";

export interface ModelSettingOption {
  value: string | number | boolean;
  label: string;
  /** When this rule evaluates to true the option is shown disabled in the UI. */
  unavailableIf?: UnavailableRule;
}

/**
 * Describes a single configurable parameter for a model.
 * The frontend renders the appropriate control based on `type`.
 */
export interface ModelSettingDef {
  key: string;
  /** Human-readable label shown in the UI. */
  label: string;
  /** Plain-language explanation of what this setting does (shown as hint below the control). */
  description?: string;
  type: ModelSettingType;
  /** Options list — required for "select" type. */
  options?: ModelSettingOption[];
  /** Min value — for "slider" and "number" types. */
  min?: number;
  /** Max value — for "slider" and "number" types. */
  max?: number;
  /** Step — for "slider" type. */
  step?: number;
  /** Default value shown when the user has not saved a preference. null = empty/unset. */
  default: string | number | boolean | null;
  /** When this rule evaluates to true the setting is hidden in the UI. */
  unavailableIf?: UnavailableRule;
  /** When true the setting is rendered inside a collapsible "Advanced" section. */
  advanced?: boolean;
  /**
   * Conditional visibility: setting is hidden until another setting (`key`)
   * holds the given `value`. Used to gate a slider behind a toggle so users
   * don't see a number that has no effect until they opt in.
   */
  dependsOn?: { key: string; value: string | number | boolean };
}

// ── Media input slot types ───────────────────────────────────────────────────

export type MediaInputMode =
  | "first_frame"
  | "last_frame"
  | "reference"
  | "edit"
  | "style_reference"
  | "reference_element"
  | "reference_image"
  | "reference_video"
  | "reference_audio"
  | "driving_audio"
  | "first_clip"
  | "motion_video";

/**
 * Per-slot media validation constraints. Enforced on upload so the user gets
 * immediate feedback instead of a provider error mid-generation.
 */
export interface MediaInputConstraints {
  /** Minimum video/audio duration in seconds (inclusive). */
  minDurationSec?: number;
  /** Maximum video/audio duration in seconds (inclusive). */
  maxDurationSec?: number;
  /** Maximum file size in bytes — rejected before download is attempted. */
  maxFileSizeBytes?: number;
  /** Minimum image/video width in pixels (inclusive). */
  minWidth?: number;
  /** Maximum image/video width in pixels (inclusive). */
  maxWidth?: number;
  /** Minimum image/video height in pixels (inclusive). */
  minHeight?: number;
  /** Maximum image/video height in pixels (inclusive). */
  maxHeight?: number;
  /**
   * Minimum aspect ratio (width / height). E.g. `0.4` = крайний портрет 1:2.5.
   * Изображения уже́ этого лимита отбраковываются.
   */
  minAspectRatio?: number;
  /**
   * Maximum aspect ratio (width / height). E.g. `2.5` = крайний landscape 2.5:1.
   * Изображения шире этого лимита отбраковываются.
   */
  maxAspectRatio?: number;
  /**
   * Минимальное произведение width × height (frame pixels). Дополняет
   * `minWidth`/`minHeight`: бывает, что обе стороны проходят, но суммарная
   * площадь кадра ниже минимума (например, Evolink Seedance r2v требует
   * ≥409,600 пикселей на кадр reference-видео).
   */
  minFramePixels?: number;
  /**
   * Максимальное произведение width × height. Особенно актуально для
   * reference-видео — 4K-видео с телефона имеет ~8.3M пикселей на кадр и
   * выходит за лимит Seedance (~2.08M). Width/height по отдельности при
   * этом проходят (3840 ≤ 6000, 2160 ≤ 6000), а площадь — нет.
   */
  maxFramePixels?: number;
}

export interface MediaInputSlot {
  /** Unique key for this slot within the model, used as storage key. */
  slotKey: string;
  /** What role the uploaded image plays. */
  mode: MediaInputMode;
  /** i18n label key resolved against t.mediaInput.* */
  labelKey: string;
  /** Maximum number of images this slot accepts (default 1). */
  maxImages?: number;
  /** When true the slot must be filled before generation can start. */
  required?: boolean;
  /**
   * Mutually exclusive group tag. Slots in different groups cannot be used
   * together — once any slot in a group is filled, slots from other groups
   * are hidden until the filled slot is cleared.
   */
  exclusiveGroup?: string;
  /**
   * When true, only photos are accepted — videos are rejected immediately with
   * a user-facing error. Overrides the default `reference_element` behaviour
   * which normally allows a single video in place of images.
   */
  imagesOnly?: boolean;
  /**
   * Upload-time validation rules (duration, file size). When a constraint is
   * violated, the upload is rejected with a user-facing error built from
   * `t.errors.mediaSlot*` strings. Reusable across models — e.g. Kling motion
   * enforces 3–30 s on `motion_video`.
   */
  constraints?: MediaInputConstraints;
  /**
   * Прогрессивный reveal: кнопка слота скрыта в slot keyboard'е до тех пор,
   * пока слот с `slotKey === revealAfter` не заполнен. Нужно для случаев когда
   * provider'у нельзя передать «последний» без «первого» (например KIE Kling
   * принимает first_frame и last_frame одним массивом image_urls — last
   * standalone не имеет смысла).
   */
  revealAfter?: string;
}

// ── Model family types ───────────────────────────────────────────────────────

/** One specific model variant that belongs to a family (e.g. recraft-v4-pro). */
export interface ModelFamilyMember {
  modelId: string;
  /** Display label for the version dimension, e.g. "v3", "v4", "2". */
  versionLabel?: string;
  /** Display label for the variant dimension, e.g. "Standard", "Pro", "Vector". */
  variantLabel?: string;
  /** Replaces the base family description for this specific model variant. */
  descriptionOverride?: string;
}

/**
 * A family groups related model variants under one name shown in the bot menu.
 * Users pick the family in the bot; version/variant/settings are configured in the mini-app.
 */
export interface ModelFamily {
  id: string;
  name: string;
  /** Base description shown unless a member provides descriptionOverride. */
  description: string;
  section: Section;
  /** Model ID used when the family is first activated (no saved preference). */
  defaultModelId: string;
  members: ModelFamilyMember[];
}

/**
 * One operation mode of a model (e.g. "t2v", "i2v", "r2v").
 *
 * Modes filter which `mediaInputs` slots are exposed to the user. A model with
 * `modes` defined ALWAYS goes through a mode picker after activation; without
 * `modes`, all `mediaInputs` are shown (legacy single-mode behavior).
 *
 * `requiredSlotKeys` overrides the intrinsic `slot.required` flag for this
 * mode — e.g. a slot that is optional in one mode may be mandatory in another.
 * If absent, the slot's own `required` value is used.
 */
export interface ModelMode {
  /** Stable identifier persisted in user state, e.g. "t2v", "i2v", "r2v". */
  id: string;
  /** i18n key resolved against `t.modelModes.*` for the picker label. */
  labelKey: string;
  /** Slots from the model's `mediaInputs` that are active in this mode. */
  slotKeys: string[];
  /** Subset of `slotKeys` that are required to start generation in this mode. */
  requiredSlotKeys?: string[];
  /** Pure text-to-* mode with no media slots. Skips slot menu entirely. */
  textOnly?: boolean;
  /** Selected by default if the user has not chosen a mode yet. */
  default?: boolean;
}

export interface AIModel {
  id: string;
  name: string;
  /** Short model description shown to users (1–2 sentences). */
  description: string;
  section: Section;
  provider: string;
  /** If set, this model belongs to the named family (e.g. "recraft", "flux"). */
  familyId?: string;
  /** Version label within the family, e.g. "v3", "v4". */
  versionLabel?: string;
  /** Variant label within the family, e.g. "Standard", "Pro", "Vector". */
  variantLabel?: string;
  /** Replaces the family description in the Management UI for this specific variant. */
  descriptionOverride?: string;
  /**
   * Provider cost in USD per request (break-even cost).
   * For LLM models this is 0 — cost is driven entirely by per-token pricing below.
   * For media generation (image/audio/video) this is the mid-range provider price.
   */
  costUsdPerRequest: number;
  /**
   * USD per 1 million INPUT tokens (LLM models only, 0 for media).
   */
  inputCostUsdPerMToken: number;
  /**
   * USD per 1 million CACHED INPUT tokens. Set when the provider bills cached
   * context (e.g. OpenAI Responses API with `previous_response_id`) at a
   * discounted rate. When unset, cached tokens are billed at the full
   * `inputCostUsdPerMToken` rate (no provider-side discount available).
   */
  cachedInputCostUsdPerMToken?: number;
  /**
   * USD per 1 million OUTPUT tokens (LLM models only, 0 for media).
   */
  outputCostUsdPerMToken: number;
  supportsImages: boolean;
  supportsVoice: boolean;
  supportsWeb: boolean; // выход в интернет
  supportsVideo?: boolean;
  /**
   * Structured media input slots this model accepts (images, keyframes, references).
   * When set, the bot shows per-slot upload buttons after model activation.
   * When absent, falls back to legacy single-image behavior based on supportsImages.
   */
  mediaInputs?: MediaInputSlot[];
  /**
   * Operation modes (e.g. text-to-video, image-to-video, reference-to-video).
   * When defined, the bot/webapp asks the user to pick a mode after activation
   * and only the slots referenced by that mode are shown / accepted.
   * When absent, all `mediaInputs` are visible (legacy behavior).
   */
  modes?: ModelMode[];
  /**
   * Model accepts PDF documents natively via content blocks (OpenAI Responses `input_file`,
   * Anthropic `document`). When set, the chat service forwards attachment s3Keys to the
   * adapter unchanged and the provider tokenises the PDF itself.
   */
  supportsDocuments?: boolean;
  /**
   * Model supports a thinking/reasoning mode (extended thinking, reasoning effort, etc.).
   * When enabled responses may take significantly longer (up to 10 minutes).
   */
  supportsThinking?: boolean;
  /**
   * Model does NOT accept PDFs natively — the chat service extracts text from each PDF
   * on the server (via pdf-parse) and inlines it into the prompt as
   * `<document name="...">...</document>` blocks before invoking the adapter.
   * Set for Gemini / DeepSeek / Qwen / Grok / Perplexity and similar text-only chat models.
   */
  documentTextExtractFallback?: boolean;
  /**
   * When true, the model can be submitted without a text prompt.
   * The bot shows a "Start generation" button once all required media slots are filled.
   */
  promptOptional?: boolean;
  /**
   * When true (in combination with `promptOptional`), the "Start generation" button only
   * appears once at least one media slot is filled. Used by Higgsfield Soul, where a
   * reference image is required to auto-generate the prompt via vision LLM.
   */
  promptOptionalRequiresMedia?: boolean;
  isAsync: boolean; // требует очереди (для image/video/audio)
  /**
   * Скрыть модель из общей карусели выбора моделей (бот + webapp). Используется
   * для моделей, доступных только через специальные сценарии — например,
   * `grok-imagine-extend` активируется только по кнопке «Продлить» под
   * результатом, в обычной карусели её показывать не нужно.
   */
  hiddenFromCarousel?: boolean;
  /**
   * Отдавать результат пользователю файлом (`sendDocument`), а не фото.
   * Нужно для апскейла: увеличенное изображение превышает лимиты Telegram
   * `sendPhoto` по размерам (PHOTO_INVALID_DIMENSIONS), а документ сохраняет
   * полное разрешение — что и требуется от апскейлера.
   */
  deliverAsDocument?: boolean;
  /**
   * Сколько изображений модель отдаёт за один API-call (native batch). Если 1 (или
   * не задано) — модель — single-only и может получить virtual batch через
   * `maxVirtualBatch`. Если >1 — провайдер сам поддерживает batch (KIE
   * nano-banana и т.п.); virtual batch для таких моделей НЕ применяется.
   */
  nativeBatchMax?: number;
  /**
   * Максимум для virtual batch (1 или undefined = picker `num_images` не показываем).
   * Применяется только когда `nativeBatchMax` равен 1/undefined. Воркер запустит
   * до N последовательных submit'ов внутри одной GenerationJob, объединит результаты
   * в существующий multi-output UX и спишет только за успешные.
   */
  maxVirtualBatch?: number;
  /**
   * Native batch с per-output биллингом: провайдер берёт деньги за каждое
   * сгенерированное изображение отдельно (Replicate Midjourney и т.п.).
   * При >1 outputs из одного API-call'а финал умножит cost на K (count).
   * По умолчанию false — это означает, что `costUsdPerRequest` уже покрывает
   * весь call независимо от количества изображений (KIE nano-banana и т.п.).
   */
  chargePerOutput?: boolean;
  contextStrategy: ContextStrategy;
  contextMaxMessages: number; // актуально для db_history: сколько сообщений отправлять
  /**
   * Physical context window of the model in tokens. Used by the chat service to
   * truncate history before sending and to power the user-configurable
   * `context_window` setting (which defaults to this value).
   */
  contextWindow?: number;
  /**
   * Realistic ceiling for output tokens per turn. Drives the `max_tokens`
   * slider's upper bound + acts as the implicit cap for providers that
   * require `max_tokens` in every request (Anthropic Messages API). When the
   * user's "Ограничить длину ответа" toggle is OFF, the chat service either
   * skips the field entirely (OpenAI Responses, Gemini, OpenAI-compatible)
   * or substitutes this value (Anthropic — required field).
   */
  maxOutputTokens?: number;
  /**
   * USD per megapixel for models with per-megapixel billing (e.g. FLUX).
   * When set, costUsdPerRequest must be 0; actual cost = ceil(px/1_000_000) × this rate.
   * The megapixels value is computed from the actual output image dimensions.
   */
  costUsdPerMPixel?: number;
  /**
   * Fixed base USD cost added before the per-megapixel component.
   * When set together with costUsdPerMPixel, the total formula becomes:
   *   cost = costUsdPerMPixelBase + ceil(megapixels) × costUsdPerMPixel
   * Example (FLUX.2 Pro): base=$0.015, perMP=$0.015 →
   *   1 MP = $0.03, 2 MP = $0.045, 0.25 MP (→ ceil 1) = $0.03
   */
  costUsdPerMPixelBase?: number;
  /**
   * Megapixel estimate for the up-front balance check of per-MP models
   * (cost-preview), before the real output size is known. Defaults to 1.0
   * when unset. Set higher for models whose output is never that small
   * (e.g. face swap on real photos) so a near-empty balance can't slip a
   * generation through and then settle negative.
   */
  estimatedMegapixels?: number;
  /**
   * Provider-specific model identifier. Used when one logical model `id` maps
   * to several distinct provider-side models — e.g. two Replicate face-swap
   * fallbacks share `id: "face-swap-classic"` + `provider: "replicate"` but
   * call different Replicate models. When set, the adapter uses this string
   * instead of its internal modelId→provider-model map.
   */
  providerModelId?: string;
  /**
   * USD per megapixel of the INPUT image for image-to-image models (e.g. FLUX).
   * Added to the cost only when an input image is present.
   *
   * If `costUsdPerMPixelInputFixed === true`, the caller-provided
   * `inputMegapixels` is ignored and the charge is added as a flat rate
   * (used for providers that resize every input to 1 MP, e.g. FLUX.2 standard
   * which always bills $0.012 regardless of actual input size).
   *
   * Otherwise the charge is `ceil(inputMegapixels) × costUsdPerMPixelInput`
   * (e.g. FLUX.2 Pro: $0.015 per ceil-MP of the real input).
   */
  costUsdPerMPixelInput?: number;
  /** See `costUsdPerMPixelInput`. When true, acts as a flat per-request fee for any input image. */
  costUsdPerMPixelInputFixed?: boolean;
  /**
   * USD per 1 million video tokens for models with per-video-token billing (e.g. Seedance).
   * When set, costUsdPerRequest must be 0.
   * videoTokens = (width × height × fps × duration) / 1024
   */
  costUsdPerMVideoToken?: number;
  /**
   * USD per second for models with per-duration billing (e.g. Kling, Pika, Sora, Veo, Runway, Wan).
   * When set, costUsdPerRequest must be 0; actual cost = durationSeconds × this rate.
   * Use costVariants to adjust the rate based on settings (quality, audio, resolution).
   * The base value must match the DEFAULT settings combination.
   *
   * For audio SFX (sounds-el): when costUsdPerSecond is set but durationSeconds is not passed
   * to calculateCost, the duration is automatically read from modelSettings.duration_seconds.
   * If duration_seconds is null/absent, costUsdPerRequest is used (AI-determines-duration mode).
   */
  costUsdPerSecond?: number;
  /**
   * USD per 1000 characters of input text, for character-based billing (TTS, voice clone).
   * When set, costUsdPerRequest must be 0; actual cost = charCount / 1000 × this rate.
   * Use costVariants to adjust the rate based on model setting (tts-1 vs tts-1-hd, etc.).
   * The base value must match the DEFAULT model setting.
   */
  costUsdPerKChar?: number;
  /** FPS assumed for video token billing. Required when costUsdPerMVideoToken is set. */
  videoFps?: number;
  /**
   * Supported aspect ratios for image/video generation models.
   * null = model does not support aspect ratio customization.
   * Ratios are in "W:H" string format, e.g. "16:9", "1:1", "9:16".
   */
  supportedAspectRatios?: string[] | null;
  /**
   * Supported clip durations in seconds for video generation models.
   * null = model does not support duration selection (fixed).
   * Use supportedDurations for discrete presets, durationRange for continuous slider.
   */
  supportedDurations?: number[] | null;
  /**
   * Continuous duration range for models that accept any integer value between min and max.
   * When set, a slider is shown instead of preset buttons.
   */
  durationRange?: { min: number; max: number } | null;
  /**
   * When the cost depends on a user-chosen setting value, maps each possible value to a cost
   * override applied at billing time.
   *
   * For media models (fixed per-request cost, e.g. "quality", "mode"):
   *   map values are plain numbers → override costUsdPerRequest.
   *   Example: { settingKey: "quality", map: { low: 0.009, medium: 0.034, high: 0.133 } }
   *
   * For LLM models (per-token cost, e.g. "enable_thinking" on Qwen):
   *   map values are { outputCostUsdPerMToken? } → override the per-token price.
   *   Example: { settingKey: "enable_thinking", map: { "true": { outputCostUsdPerMToken: 8.4 }, "false": { outputCostUsdPerMToken: 2.8 } } }
   *
   * The base costUsdPerRequest / outputCostUsdPerMToken should match the DEFAULT setting value.
   */
  costVariants?: {
    settingKey: string;
    map: Record<
      string,
      | number
      | {
          costUsdPerRequest?: number;
          outputCostUsdPerMToken?: number;
          /** Override per-second rate for per-duration billing models. */
          costUsdPerSecond?: number;
          /** Override per-video-token rate (e.g. Seedance audio toggle). */
          costUsdPerMVideoToken?: number;
          /** Override per-1K-characters rate (e.g. TTS model tier, ElevenLabs model). */
          costUsdPerKChar?: number;
        }
    >;
  };
  /**
   * Multi-dimensional pricing table for models where cost depends on 2+ settings.
   * dims: ordered setting keys, e.g. ["quality", "size"].
   * table keys: setting values joined by "__", e.g. "medium__1024x1024".
   * Used by the webapp to display dynamic cost label when settings change.
   */
  costMatrix?: {
    dims: string[];
    table: Record<string, number>;
  };
  /**
   * Additive USD costs applied on top of the base/variant cost when a setting
   * has a specific value. Each entry defines one setting dimension.
   * Example: web search toggle adds $0.015, high thinking adds $0.002.
   * Map keys are String(settingValue); only matched keys add cost.
   */
  costAddons?: Array<{
    settingKey: string;
    map: Record<string, number>;
  }>;
  /**
   * Tiered pricing based on prompt (input) token count.
   * When inputTokens exceeds thresholdTokens, the input and output rates
   * are multiplied by the respective multipliers.
   * Example: GPT-5.4 doubles input cost and adds ×1.5 output cost above 272k tokens.
   */
  contextPricingTiers?: {
    thresholdTokens: number;
    inputMultiplier: number;
    outputMultiplier: number;
  };
  /**
   * Declares which @-reference kinds the model accepts in its prompt.
   * Used by the pre-flight validator to catch wrong references before submission.
   * Models without this field do not support any @-references.
   */
  promptRefs?: PromptRefCapabilities;
  /**
   * Hard cap on prompt length (in JS string code units) enforced pre-submission.
   * When set, the generation service rejects the request с `promptTooLong`
   * локализованным сообщением вместо того, чтобы провайдер 422-нул его
   * mid-flight (e.g. xAI/Grok hardcap 4096 chars на FAL/KIE). Если не задан —
   * валидация не выполняется и полагаемся на провайдер.
   */
  maxPromptLength?: number;
  /**
   * Configurable generation parameters exposed in the Management mini-app.
   * The frontend renders controls dynamically based on these definitions.
   * User-chosen values are stored in UserState.modelSettings and passed to the adapter.
   */
  settings?: ModelSettingDef[];
}

/** Входные данные для LLM-чата (с учётом стратегии контекста) */
export interface ChatInput {
  prompt: string;
  imageUrl?: string;
  audioUrl?: string;
  // db_history: передаём историю из БД
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  // provider_chain: передаём ID предыдущего ответа (OpenAI Responses API)
  previousResponseId?: string;
  options?: Record<string, unknown>;
}

/** Результат LLM-чата */
export interface ChatOutput {
  text: string;
  tokensUsed: number;
  // Возвращаем для обновления Dialog
  newResponseId?: string; // provider_chain: сохранить как providerLastResponseId
}

/** Входные данные для async-генерации (image/video/audio) */
export interface GenerationInput {
  prompt: string;
  imageUrl?: string;
  options?: Record<string, unknown>;
}

/** Результат async-генерации */
export interface GenerationOutput {
  mediaUrl: string;
  tokensUsed: number;
}
