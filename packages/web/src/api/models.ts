import { apiClient } from "./client";

/**
 * Каталог моделей с бэкенда (`/web/models`). DTO мы держим узким — фронту
 * нужны только id/имя/описание/секция + опц. supportedAspectRatios/Durations
 * для страниц Image/Video/Audio и tokenCostApprox для подписи у каждой модели.
 */

/** Логическая секция модели (определяется в `packages/shared/constants/models/*`). */
export type ModelSection = "gpt" | "design" | "video" | "audio";

/** Operation mode (text-to-video, image-to-video и т.п.) — резолвится сервером. */
export type ModelModeDto = {
  id: string;
  label: string;
  /** slotKeys из `mediaInputs[]` которые активны в этом режиме. */
  slotKeys: string[];
  /** Если задано — переопределяет `slot.required` внутри режима. */
  requiredSlotKeys: string[] | null;
  /** Pure text-only режим — слоты не нужны. */
  textOnly: boolean;
  default: boolean;
};

/** Media input slot — кнопка-загрузчик файлов для модели. */
export type MediaInputSlotDto = {
  slotKey: string;
  mode: string;
  /** Лейбл (уже резолвленный в локаль пользователя). */
  label: string;
  /** Максимум файлов в слоте. По умолчанию 1. */
  maxImages: number;
  required: boolean;
  exclusiveGroup: string | null;
  imagesOnly: boolean;
  revealAfter: string | null;
  constraints: Record<string, unknown> | null;
};

export type ModelSettingType =
  | "select"
  | "dropdown"
  | "slider"
  | "toggle"
  | "text"
  | "number"
  // Сложные пикеры — пока не реализованы в web (фолбэк на скрытие).
  | "voice-picker"
  | "did-voice-picker"
  | "elevenlabs-voice-picker"
  | "openai-voice-picker"
  | "cartesia-voice-picker"
  | "color"
  | "avatar-picker"
  | "motion-picker"
  | "soul-picker"
  | "soul-style-picker"
  | string;

export type ModelSettingOptionDto = {
  value: string | number | boolean;
  label: string;
  unavailableIf?: unknown;
};

export type ModelSettingDto = {
  key: string;
  label: string;
  description?: string;
  type: ModelSettingType;
  options?: ModelSettingOptionDto[];
  min?: number;
  max?: number;
  step?: number;
  default: string | number | boolean | null;
  unavailableIf?: unknown;
  advanced?: boolean;
  dependsOn?: { key: string; value: string | number | boolean };
};

export type WebModelDto = {
  id: string;
  name: string;
  description: string;
  section: ModelSection | string;
  provider: string;
  familyId: string | null;
  familyName: string | null;
  versionLabel: string | null;
  variantLabel: string | null;
  descriptionOverride: string | null;
  supportsImages: boolean;
  supportsDocuments: boolean;
  supportsVoice: boolean;
  supportsWeb: boolean;
  isAsync: boolean;
  isLLM: boolean;
  supportedAspectRatios: string[] | null;
  supportedDurations: number[] | null;
  durationRange: { min: number; max: number } | null;
  tokenCostApprox: number;
  /** msg / mpx / second / mvideotoken / kchar / request — единица для подписи стоимости. */
  tokenCostUnit: "msg" | "mpx" | "second" | "mvideotoken" | "kchar" | "request" | string;
  /** Operation modes; `null` = single-mode (не показывать таб-переключатель). */
  modes: ModelModeDto[] | null;
  /** Media slots — рендерим только те, чьи slotKey в `activeMode.slotKeys`. */
  mediaInputs: MediaInputSlotDto[];
  /** Конфигурируемые параметры — UI рендерит контролы по `type`. */
  settings: ModelSettingDto[];
  promptOptional: boolean;
  promptOptionalRequiresMedia: boolean;
};

/**
 * Каталог моделей. `lang` пробрасывается в `?lang=` чтобы бэк отдал
 * локализованные `modes[].label` / `mediaInputs[].label` под текущий
 * UI-язык (а не под user.language из БД).
 */
export function getModels(section?: ModelSection, lang?: string) {
  const query: Record<string, string> = {};
  if (section) query.section = section;
  if (lang) query.lang = lang;
  return apiClient<WebModelDto[]>(
    "/web/models",
    Object.keys(query).length > 0 ? { query } : undefined,
  );
}
