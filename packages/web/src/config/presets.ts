import type { GenerateSection } from "@/utils/navigateToGenerate";

/**
 * Захардкоженный пресет страницы генерации. Активируется через URL вида
 * `/image/<key>` (аналогично video / audio).
 *
 * Поведение по модели — комбинируется:
 * - `modelId` задаёт дефолтную модель пресета (применяется через префил-механизм).
 * - `hideModelPicker: true` скрывает UI выбора модели; обязательно вместе с `modelId`.
 * - `allowedModelIds` ограничивает дропдаун; `modelId` должна быть в этом списке.
 * - Если ничего не задано — модели не ограничены, ведём себя как обычный префил.
 *
 * Строковые поля (`title`, `subtitle`, `promptPlaceholder`) прогоняются через
 * `t(...)` в page wrapper'е — можно хранить как literal, так и i18n-ключ
 * (i18next вернёт сам ключ как fallback, если перевода нет).
 */
export type GeneratePreset = {
  prompt: string;
  modelId?: string;
  settings?: Record<string, unknown>;
  hideModelPicker?: boolean;
  allowedModelIds?: readonly string[];
  title?: string;
  subtitle?: string;
  promptPlaceholder?: string;
};

export type PresetMap = Record<string, GeneratePreset>;

export const imagePresets: PresetMap = {
  // Заполняется вручную. Пример:
  swap: {
		allowedModelIds: [
			"nano-banana-2",
			"grok-imagine-image",
		],
    prompt: "Заменить лицо на референсном изображении",
    modelId: "nano-banana-2",
		// прячет выбор модели 
    hideModelPicker: false,
    settings: { strength: 0.85 },
    title: "presets.image.swap.title",       // i18n-ключ; literal тоже ok
    subtitle: "presets.image.swap.subtitle",
  },
};

export const videoPresets: PresetMap = {};

export const audioPresets: PresetMap = {};

/** Лукап по секции — для usePresetSetup. */
export const presetsBySection: Record<GenerateSection, PresetMap> = {
  image: imagePresets,
  video: videoPresets,
  audio: audioPresets,
};
