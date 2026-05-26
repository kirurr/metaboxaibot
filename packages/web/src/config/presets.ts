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
    title: "presets.image.upscale.title",
    subtitle: "presets.image.upscale.subtitle",
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
    title: "presets.image.bg-removal.title",
    subtitle: "presets.image.bg-removal.subtitle",
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
    title: "presets.image.face-swap.title",
    subtitle: "presets.image.face-swap.subtitle",
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
    title: "presets.image.clothing-tryon.title",
    subtitle: "presets.image.clothing-tryon.subtitle",
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
    promptPlaceholder: "presets.image.object-removal.promptPlaceholder",
    settings: {
      "object-removal": {
        resolution: "1K",
        aspect_ratio: "auto",
      },
    },
    title: "presets.image.object-removal.title",
    subtitle: "presets.image.object-removal.subtitle",
  },
  // Перенос бот-сценария «📸 Создать фотографию» (scenes/photo-create.ts). Модель
  // photo-create (nano-banana-pro @ KIE, hiddenFromCarousel). Промпт ПОКАЗЫВАЕМ —
  // юзер описывает фото; бэкенд (web-generation.ts) переводит ru→en silent. AR и
  // resolution — селекты из model.settings; «auto» AR бэкенд снапит под исходное фото.
  "photo-create": {
    allowedModelIds: ["photo-create"],
    modelId: "photo-create",
    hideModelPicker: true,
    hidePrompt: false,
    prompt: "",
    promptPlaceholder: "presets.image.photo-create.promptPlaceholder",
    settings: {
      "photo-create": {
        aspect_ratio: "auto",
        resolution: "2K",
      },
    },
    title: "presets.image.photo-create.title",
    subtitle: "presets.image.photo-create.subtitle",
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
    title: "presets.video.photo-animate.title",
    subtitle: "presets.video.photo-animate.subtitle",
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
    title: "presets.video.video-upscale.title",
    subtitle: "presets.video.video-upscale.subtitle",
  },
};

export const audioPresets: PresetMap = {
  // Озвучка текста: tts-openai / tts-cartesia / tts-el. sounds-el (звуковые
  // эффекты) сюда НЕ входит — это отдельный пресет `sounds` (как и в боте).
  tts: {
    allowedModelIds: ["tts-openai", "tts-cartesia", "tts-el"],
    prompt: "",
    modelId: "tts-openai",
    title: "presets.audio.tts.title",
    subtitle: "presets.audio.tts.subtitle",
  },
  clone: {
    allowedModelIds: ["voice-clone"],
    prompt: "",
    modelId: "voice-clone",
    hideModelPicker: true,
    title: "presets.audio.clone.title",
    subtitle: "presets.audio.clone.subtitle",
  },
  music: {
    allowedModelIds: ["suno", "music-el"],
    prompt: "",
    modelId: "suno",
    title: "presets.audio.music.title",
    subtitle: "presets.audio.music.subtitle",
  },
  // Перенос бот-сценария «🔔 Звуковые эффекты» (audio sub-section soundsActivated).
  // Модель sounds-el (ElevenLabs SFX через KIE). Промпт ПОКАЗЫВАЕМ — юзер описывает
  // звук; модель не promptOptional. Длительность/влияние — селекты из model.settings.
  sounds: {
    allowedModelIds: ["sounds-el"],
    prompt: "",
    modelId: "sounds-el",
    hideModelPicker: true,
    promptPlaceholder: "presets.audio.sounds.promptPlaceholder",
    title: "presets.audio.sounds.title",
    subtitle: "presets.audio.sounds.subtitle",
  },
};

/** Лукап по секции — для usePresetSetup. */
export const presetsBySection: Record<GenerateSection, PresetMap> = {
  image: imagePresets,
  video: videoPresets,
  audio: audioPresets,
};
