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
  /**
   * Полностью скрывает поле промпта. `prompt` пресета всё равно уходит в сабмит
   * (значение остаётся в state), поэтому модели с обязательным промптом не блокируются.
   * Для сценариев, где юзер ничего не пишет — только грузит медиа (напр. апскейл фото).
   */
  hidePrompt?: boolean;
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
  // Перенос бот-сценария «📷 Апскейл фото» (см. packages/bot/src/scenes/upscale.ts).
  // Под капотом — модель image-upscale (nano-banana-pro @ KIE, evolink fallback).
  // Юзер ничего не настраивает: только грузит фото в слот `edit`. Промт и настройки
  // (resolution 4K, aspect_ratio auto, output_format png) зашиты и уходят автоматически.
  // Модель hiddenFromCarousel — видна только через этот пресет.
  upscale: {
    allowedModelIds: ["image-upscale"],
    modelId: "image-upscale",
    hideModelPicker: true,
    hidePrompt: true,
    prompt:
      "High-resolution 4K enhancement, photorealistic, hyper-detailed, crystal clear texture, sharp focus, professionally restored, maintaining exact original features and composition, no distortion, cinematic lighting.",
    settings: {
      "image-upscale": {
        resolution: "4K",
        aspect_ratio: "auto",
        output_format: "png",
      },
    },
    title: "Апскейл фото",
    subtitle: "Увеличивает разрешение и чёткость фотографии до 4K",
  },
};

export const videoPresets: PresetMap = {};

export const audioPresets: PresetMap = {
  tts: {
    allowedModelIds: ["tts-openai", "tts-cartesia", "tts-el", "sounds-el"],
    prompt: "",
    modelId: "tts-openai",
    // i18n-ключи, но просто текст тоже сработает
    title: "presets.audio.tts.title",
    subtitle: "presets.audio.tts.subtitle",
  },
  clone: {
    allowedModelIds: ["voice-clone"],
    prompt: "",
    modelId: "voice-clone",
    hideModelPicker: true,
    // i18n-ключи, но просто текст тоже сработает
    title: "presets.audio.clone.title",
    subtitle: "presets.audio.clone.subtitle",
  },
  music: {
    allowedModelIds: ["suno", "music-el"],
    prompt: "",
    modelId: "suno",
    // i18n-ключи, но просто текст тоже сработает
    title: "presets.audio.music.title",
    subtitle: "presets.audio.music.subtitle",
  },
};

/** Лукап по секции — для usePresetSetup. */
export const presetsBySection: Record<GenerateSection, PresetMap> = {
  image: imagePresets,
  video: videoPresets,
  audio: audioPresets,
};
