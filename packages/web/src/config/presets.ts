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
  // Перенос бот-сценария «✂️ Удаление фона» (scenes/background-removal.ts).
  // Модель bg-removal (fal Ideogram remove-background). Промпт не нужен —
  // модель promptOptional, поле скрыто. Юзер только грузит 1 фото в слот edit.
  "bg-removal": {
    allowedModelIds: ["bg-removal"],
    modelId: "bg-removal",
    hideModelPicker: true,
    hidePrompt: true,
    prompt: "",
    title: "Удаление фона",
    subtitle: "Удаляет фон с фотографии, оставляя объект на прозрачном фоне",
  },
  // Перенос бот-сценария «🔄 Замена лица» (scenes/face-swap.ts). Модель
  // face-swap-classic. Фикс-промпт, поле скрыто. Слот edit принимает 2 фото —
  // порядок важен (см. subtitle).
  "face-swap": {
    allowedModelIds: ["face-swap-classic"],
    modelId: "face-swap-classic",
    hideModelPicker: true,
    hidePrompt: true,
    prompt:
      "Take image 1 as a reference and transfer the face from image 2 to image 1, maintaining the proportions, emotion, and light in image 1.",
    title: "Замена лица",
    subtitle: "Загрузите 2 фото: 1-е — куда вставить лицо, 2-е — чьё лицо взять",
  },
  // Перенос бот-сценария «👗 Примерка одежды» (scenes/clothing-tryon.ts). Модель
  // clothing-tryon. Фикс-промпт, поле скрыто. Слот edit принимает 2 фото —
  // порядок важен (см. subtitle).
  "clothing-tryon": {
    allowedModelIds: ["clothing-tryon"],
    modelId: "clothing-tryon",
    hideModelPicker: true,
    hidePrompt: true,
    prompt:
      "Take image 1 as a reference and transfer the clothing from image 2 to image 1, maintaining the body, pose, and light in image 1. Keep the person's face and don't change anything else.",
    title: "Примерка одежды",
    subtitle: "Загрузите 2 фото: 1-е — человек, 2-е — одежда",
  },
  // Перенос бот-сценария «🪄 Убрать объект» (scenes/object-removal.ts). Модель
  // object-removal (gpt-image-2 i2i). Поле промпта ПОКАЗЫВАЕМ — юзер пишет, что
  // убрать; бэкенд (web-generation.ts) переводит ввод и оборачивает в шаблон.
  // Настройки 1K/auto уходят отсюда.
  "object-removal": {
    allowedModelIds: ["object-removal"],
    modelId: "object-removal",
    hideModelPicker: true,
    hidePrompt: false,
    prompt: "",
    promptPlaceholder: "Что убрать? Напр.: человек на заднем плане",
    settings: {
      "object-removal": {
        resolution: "1K",
        aspect_ratio: "auto",
      },
    },
    title: "Убрать объект",
    subtitle: "Удаляет указанный объект с фото, дорисовывая фон на его месте",
  },
};

export const videoPresets: PresetMap = {
  // Перенос бот-сценария «🎞️ Оживить фото» (scenes/photo-animate.ts). Под капотом —
  // модель photo-animate (KIE Grok Imagine r2v, fal fallback). Промпт пустой и
  // скрыт: реальный фикс-промпт инжектится в адаптере по modelId. Юзер грузит
  // 1 фото в слот ref_images. Фикс 720p/6s. aspect_ratio НЕ задаём — бэкенд
  // (web-generation.ts) снапит его под исходное фото. Модель hiddenFromCarousel.
  "photo-animate": {
    allowedModelIds: ["photo-animate"],
    modelId: "photo-animate",
    hideModelPicker: true,
    hidePrompt: true,
    prompt: "",
    settings: {
      "photo-animate": {
        resolution: "720p",
        duration: 6,
      },
    },
    title: "Оживить фото",
    subtitle: "Создаёт короткое видео-оживление из одной фотографии",
  },
  // Перенос бот-сценария «🎬 Копировать движение» (scenes/copy-motion.ts).
  // Под капотом — виртуальная модель copy-motion (kling-3.0/motion-control
  // @ 1080p Pro в KIE primary). Юзер ничего не настраивает: грузит 1 фото в
  // слот first_frame и 1 референс-видео (3-30 с) в слот motion_video. Адаптер
  // сам форсит character_orientation="video" + background_source="input_image".
  // Длительность результата = длительность референс-видео. hiddenFromCarousel
  // — модель видна юзеру только через этот пресет.
  "copy-motion": {
    allowedModelIds: ["copy-motion"],
    modelId: "copy-motion",
    hideModelPicker: true,
    hidePrompt: true,
    prompt: "",
    title: "Копировать движение",
    subtitle: "Переносит движение из референсного видео на персонажа с вашей фотографии",
  },
  // Перенос бот-сценария «🎬 Апскейл видео» (scenes/upscale.ts). Модель
  // video-upscale (KIE Topaz, replicate fallback). Промпт не нужен — модель
  // promptOptional, поле скрыто. Юзер грузит 1 видео в слот motion_video и
  // выбирает upscale_factor ×2/×4 (селект рендерится из model.settings).
  // target_resolution/fps НЕ задаём — бэкенд деривит их из исходного видео.
  "video-upscale": {
    allowedModelIds: ["video-upscale"],
    modelId: "video-upscale",
    hideModelPicker: true,
    hidePrompt: true,
    prompt: "",
    settings: {
      "video-upscale": {
        upscale_factor: "2",
      },
    },
    title: "Апскейл видео",
    subtitle: "Увеличивает разрешение и чёткость видео с помощью Topaz AI",
  },
};

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
