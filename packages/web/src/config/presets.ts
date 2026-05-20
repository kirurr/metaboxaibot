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
 * `settings` — мапа `modelId → { key: value }`. Для каждой модели из
 * `allowedModelIds` можно задать свои настройки, потому что у разных моделей
 * разные параметры. При переключении модели вручную (когда `hideModelPicker:
 * false`) применятся настройки соответствующей модели.
 *
 * Строковые поля (`title`, `subtitle`, `promptPlaceholder`) прогоняются через
 * `t(...)` в page wrapper'е — можно хранить как literal, так и i18n-ключ
 * (i18next вернёт сам ключ как fallback, если перевода нет).
 */
export type GeneratePreset = {
  prompt: string;
  modelId?: string;
  settings?: Record<string, Record<string, unknown>>;
  hideModelPicker?: boolean;
  allowedModelIds?: readonly string[];
  title?: string;
  subtitle?: string;
  promptPlaceholder?: string;
};

export type PresetMap = Record<string, GeneratePreset>;

export const imagePresets: PresetMap = {
  // Заполняется вручную. Пример:
  // key - часть url пресета, например image/swap
  swap: {
    allowedModelIds: ["nano-banana-2", "grok-imagine-image"],
    prompt: "Заменить лицо на референсном изображении",
    modelId: "nano-banana-2",
    // прячет выбор модели
    hideModelPicker: false,
    // настройки задаются отдельно для каждой модели из allowedModelIds
    settings: {
      "nano-banana-2": {
				aspect_ratio: "1:1",
			},
      "grok-imagine-image": {
				enable_pro: true,
				aspect_ratio: "16:9",
			},
    },
    // i18n-ключи, но просто текст тоже сработает
    title: "presets.image.swap.title",
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
