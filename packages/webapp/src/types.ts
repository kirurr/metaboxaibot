export interface UserProfile {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  language: string;
  role: "USER" | "MODERATOR" | "ADMIN";
  tokenBalance: string;
  purchasedTokenBalance: string;
  subscriptionTokenBalance: string;
  referralCount: number;
  createdAt: string;
  metaboxUserId: string | null;
  metaboxReferralCode: string | null;
  finishedOnboarding: boolean;
  confirmBeforeGenerate: boolean;
  subscription: {
    planName: string;
    period: string;
    daysLeft: number;
    totalDays: number;
    endDate: string;
  } | null;
  transactions: Transaction[];
}

export interface Transaction {
  id: string;
  amount: string;
  type: "credit" | "debit";
  reason: string;
  description: string | null;
  modelId: string | null;
  createdAt: string;
}

export interface Dialog {
  id: string;
  section: string;
  modelId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelSettingOption {
  value: string | number | boolean;
  label: string;
  /** When this rule evaluates to true the option is shown disabled in the UI. */
  unavailableIf?: UnavailableRule;
}

export interface SettingCondition {
  key: string;
  eq?: unknown;
  neq?: unknown;
  present?: true;
  absent?: true;
}

export interface AndCondition {
  and: UnavailableRule[];
}
export interface OrCondition {
  or: UnavailableRule[];
}

export type UnavailableRule = SettingCondition | AndCondition | OrCondition;

export interface ModelSettingDef {
  key: string;
  label: string;
  description?: string;
  type:
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
  options?: ModelSettingOption[];
  min?: number;
  max?: number;
  step?: number;
  default: string | number | boolean | null;
  unavailableIf?: UnavailableRule;
  advanced?: boolean;
  /** Conditional visibility: hide until another setting (`key`) equals `value`. */
  dependsOn?: { key: string; value: string | number | boolean };
}

export interface ElevenLabsVoice {
  voice_id: string;
  name: string;
  /** Voice flavour (timbre/style) — shown as the picker's secondary meta line. */
  description: string;
  preview_url: string | null;
}

export interface CartesiaVoice {
  voice_id: string;
  name: string;
  description: string | null;
  gender: string | null;
  language: string | null;
  /** True если у голоса есть preview-аудио. Сам URL резолвится on-demand
   *  через api.cartesiaVoices.previewUrl(voice_id) — Cartesia подписывает
   *  preview короткоживущим токеном, кэшировать готовый URL нельзя. */
  has_preview: boolean;
}

export interface UserVoice {
  id: string;
  provider: string;
  name: string;
  externalId: string | null;
  previewUrl: string | null;
  hasAudio: boolean;
  status: "ready" | "failed";
  createdAt: string;
}

export interface HeyGenVoice {
  voice_id: string;
  name: string;
  language: string;
  gender: string;
  preview_audio: string | null;
}

export interface HeyGenAvatar {
  avatar_id: string;
  avatar_name: string;
  gender: string;
  preview_image_url: string | null;
}

export interface HiggsFieldMotion {
  id: string;
  name: string;
  description?: string;
  preview_url?: string | null;
  category?: string;
}

export interface SoulStyle {
  id: string;
  name: string;
  description?: string | null;
  preview_url: string;
}

export interface DIDLanguage {
  language: string;
  locale: string;
  accent: string;
  previewUrl?: string;
}

export interface DIDVoice {
  id: string;
  name: string;
  gender: string;
  languages: DIDLanguage[];
  provider: string;
  styles: string[];
  description: string;
}

export interface UserAvatar {
  id: string;
  provider: string;
  name: string;
  externalId: string | null;
  previewUrl: string | null;
  status: "creating" | "ready" | "failed" | "orphaned";
  createdAt: string;
}

export interface Model {
  id: string;
  name: string;
  description: string;
  section: string;
  provider: string;
  /** Family this model belongs to, null for standalone models. */
  familyId: string | null;
  /** Display name of the family (includes emoji), null for standalone models. */
  familyName: string | null;
  /** Default model ID for this family (used to pre-select variant/version before activation). */
  familyDefaultModelId: string | null;
  /** Version label within the family, e.g. "v3", "v4". */
  versionLabel: string | null;
  /** Variant label within the family, e.g. "Standard", "Pro", "Vector". */
  variantLabel: string | null;
  /** Per-variant description override shown instead of family description. */
  descriptionOverride: string | null;
  supportsImages: boolean;
  supportsDocuments: boolean;
  supportsVoice: boolean;
  supportsWeb: boolean;
  isAsync: boolean;
  isLLM: boolean;
  /** Fixed cost in internal tokens per request (0 for LLM and per-MP models) */
  tokenCostPerRequest: number;
  /** Estimated cost in internal tokens per typical message (LLM only, 0 for fixed-cost models) */
  tokenCostApproxMsg: number;
  /** Cost per megapixel in internal tokens (>0 only for per-megapixel billing models, e.g. FLUX) */
  tokenCostPerMPixel: number;
  /**
   * Cost per 1M video tokens in internal tokens (>0 only for per-video-token models, e.g. Seedance).
   * videoTokens = (width × height × fps × duration) / 1024
   */
  tokenCostPerMVideoToken: number;
  /** FPS used in video token calculation (0 if not applicable). */
  videoFps: number;
  /** Cost per second in internal tokens (>0 only for per-second billing models, e.g. Kling, Pika). */
  tokenCostPerSecond: number;
  /** Cost per 1K characters in internal tokens (>0 only for per-kchar billing models, e.g. TTS). */
  tokenCostPerKChar: number;
  supportedAspectRatios?: string[] | null;
  supportedDurations?: number[] | null;
  durationRange?: { min: number; max: number } | null;
  /** Configurable generation parameters. Empty array if none. */
  settings: ModelSettingDef[];
  /** Multi-dimensional cost table (internal tokens). Keys: setting values joined by "__". null if not applicable. */
  costMatrix?: { dims: string[]; table: Record<string, number> } | null;
  /** Token cost per variant value for single-setting pricing (costVariants). null if not applicable. */
  tokenCostVariants?: { settingKey: string; map: Record<string, number> } | null;
  /** Additive token cost per setting value (costAddons). null if not applicable. */
  tokenCostAddons?: Array<{ settingKey: string; map: Record<string, number> }> | null;
  /** Operation modes (e.g. t2v, i2v, r2v) — null when the model has only one implicit mode. */
  modes?: Array<{ id: string; label: string; textOnly: boolean; default: boolean }> | null;
}

export interface UserState {
  state: string;
  section: string | null;
  gptModelId: string | null;
  gptDialogId: string | null;
  designDialogId: string | null;
  audioDialogId: string | null;
  videoDialogId: string | null;
  designModelId: string | null;
  audioModelId: string | null;
  videoModelId: string | null;
  /** Map of modelId → user-chosen modeId. Empty when no modes have been picked. */
  selectedModes?: Record<string, string>;
}

export interface AdminUser {
  id: string;
  username: string | null;
  firstName: string | null;
  tokenBalance: string;
  role: "USER" | "MODERATOR" | "ADMIN";
  isBlocked: boolean;
  createdAt: string;
}

export interface AdminUsersResponse {
  users: AdminUser[];
  total: number;
  page: number;
  limit: number;
}

export interface BannerSlide {
  id: string;
  imageUrl: string;
  linkUrl: string | null;
  displaySeconds: number;
  sortOrder: number;
  active: boolean;
}

export interface MessageAttachment {
  s3Key: string;
  mimeType: string;
  name: string;
  size?: number;
  previewUrl?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  mediaUrl: string | null;
  mediaType: string | null;
  attachments?: MessageAttachment[];
  createdAt: string;
}

export interface GalleryOutput {
  id: string;
  s3Key: string | null;
  outputUrl: string | null;
  /** Resolved full-res URL — /download/:token when S3 key available, else outputUrl. */
  previewUrl: string | null;
  /** Thumbnail WebP (400px wide) — available for images only, null otherwise. */
  thumbnailUrl: string | null;
}

export interface GalleryFolder {
  id: string;
  name: string;
  isDefault: boolean;
  isPinned: boolean;
  pinnedAt: string | null;
  itemCount: number;
  createdAt: string;
}

export interface GalleryJob {
  id: string;
  section: string;
  modelId: string;
  /** Display name from AI_MODELS, falls back to modelId. */
  modelName: string;
  prompt: string;
  /** Per-model settings used at generation time (Record<string, unknown>). */
  modelSettings: Record<string, unknown>;
  /** Internal tokens debited. Stringified Decimal — null for old jobs / recovery fast-path. */
  tokensSpent: string | null;
  completedAt: string | null;
  folderIds: string[];
  outputs: GalleryOutput[];
}

export interface GalleryResponse {
  items: GalleryJob[];
  total: number;
  page: number;
  limit: number;
}

export interface CatalogPeriod {
  priceRub: string;
  stars: number;
}

export interface CatalogSubscription {
  id: string;
  name: string;
  tokens: number;
  /** Only available periods are included (M1 always present; M3/M6/M12 only if discount > 0). */
  periods: Partial<Record<"M1" | "M3" | "M6" | "M12", CatalogPeriod>>;
}

export interface CatalogTokenPackage {
  id: string;
  name: string;
  tokens: number;
  priceRub: string;
  stars: number;
  badge: string | null;
}

export interface CatalogResponse {
  subscriptions: CatalogSubscription[];
  tokenPackages: CatalogTokenPackage[];
  canPayByCard: boolean;
  /** true если у юзера есть платная активная подписка (триал — false). */
  hasPaidSubscription: boolean;
  /** RUB-эквивалент одной звезды Telegram (из config.payments.starPriceRub).
   *  Информационно — фронт может показать «1 ⭐ ≈ N ₽». */
  starPriceRub: number;
  metaboxUrl: string;
}

export type Page = "profile" | "management" | "tariffs" | "referral" | "admin" | "linkMetabox";
