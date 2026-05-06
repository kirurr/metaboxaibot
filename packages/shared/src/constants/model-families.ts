import type { ModelFamily } from "../types/ai.js";

/**
 * Model family definitions.
 * Each family groups related variants (versions × variants) under one name
 * shown in the bot menu. Users drill into version/variant/settings in the mini-app.
 */
export const MODEL_FAMILIES: Record<string, ModelFamily> = {
  // ── Design families ────────────────────────────────────────────────────────

  "nano-banana": {
    id: "nano-banana",
    name: "🍌 Nano Banana",
    section: "design",
    description:
      "Генерирует реалистичные фото и позволяет менять детали прямо словами: «убери фон», «добавь шляпу», «сделай вечер». Версия 2 — расширенный набор соотношений сторон и больше референсов.",
    defaultModelId: "nano-banana-2",
    members: [
      { modelId: "nano-banana-1", versionLabel: "1", variantLabel: "Standard" },
      { modelId: "nano-banana-2", versionLabel: "2", variantLabel: "Standard" },
      { modelId: "nano-banana-pro", versionLabel: "PRO", variantLabel: "Pro" },
    ],
  },

  "gpt-image": {
    id: "gpt-image",
    name: "🖼️ GPT Image",
    section: "design",
    description:
      "Линейка генерации изображений от OpenAI. Версия 1.5 — точное следование промпту и хороший рендер текста; 2 — новейшая, ещё лучше с текстом и деталями.",
    defaultModelId: "gpt-image-2",
    members: [
      { modelId: "gpt-image-1.5", versionLabel: "1.5", variantLabel: "Standard" },
      { modelId: "gpt-image-2", versionLabel: "2", variantLabel: "Standard" },
    ],
  },

  ideogram: {
    id: "ideogram",
    name: "✍️ Ideogram",
    section: "design",
    description:
      "Лучше всех рисует читаемый текст на картинках. Идеален для логотипов, постеров, обложек и рекламы. Принимает фото как стилевой референс.",
    defaultModelId: "ideogram-balanced",
    members: [
      { modelId: "ideogram-turbo", variantLabel: "Turbo" },
      { modelId: "ideogram-balanced", variantLabel: "Balanced" },
      { modelId: "ideogram", variantLabel: "Quality" },
    ],
  },

  flux: {
    id: "flux",
    name: "⚡ FLUX",
    section: "design",
    description:
      "Генерация изображений с оплатой за мегапиксель — платите только за фактическое разрешение. FLUX.2 — быстрый и качественный; Pro-вариант добавляет повышенную детализацию и фотореализм.",
    defaultModelId: "flux",
    members: [
      { modelId: "flux", versionLabel: "2", variantLabel: "Standard" },
      { modelId: "flux-pro", versionLabel: "2", variantLabel: "Pro" },
    ],
  },

  recraft: {
    id: "recraft",
    name: "🖌️ Recraft",
    section: "design",
    description:
      "Профессиональная генерация изображений с детальным контролем стиля. Поддерживает растровые (PNG) и векторные (SVG) форматы. Pro-вариант добавляет улучшенное качество и детализацию.",
    defaultModelId: "recraft-v4",
    members: [
      { modelId: "recraft-v3", versionLabel: "v3", variantLabel: "Standard" },
      { modelId: "recraft-v4", versionLabel: "v4", variantLabel: "Standard" },
      { modelId: "recraft-v4-pro", versionLabel: "v4", variantLabel: "Pro" },
      {
        modelId: "recraft-v4-vector",
        versionLabel: "v4",
        variantLabel: "Vector",
        descriptionOverride:
          "Генерирует масштабируемую векторную графику (SVG). Идеален для логотипов, иконок и иллюстраций, которые нужно масштабировать без потери качества.",
      },
      {
        modelId: "recraft-v4-pro-vector",
        versionLabel: "v4",
        variantLabel: "Pro Vector",
        descriptionOverride:
          "Pro-версия векторной генерации. Максимальное качество SVG с улучшенной детализацией и точностью форм.",
      },
    ],
  },

  imagen: {
    id: "imagen",
    name: "🔮 Imagen 4",
    section: "design",
    description:
      "Модели генерации изображений от Google. Высокая фотореалистичность и точное следование текстовым описаниям. Fast — быстро и дёшево, Standard — баланс, Ultra — максимальное качество.",
    defaultModelId: "imagen-4",
    members: [
      { modelId: "imagen-4-fast", versionLabel: "4", variantLabel: "Fast" },
      { modelId: "imagen-4", versionLabel: "4", variantLabel: "Standard" },
      { modelId: "imagen-4-ultra", versionLabel: "4", variantLabel: "Ultra" },
    ],
  },

  seedream: {
    id: "seedream",
    name: "🛍️ Seedream",
    section: "design",
    description:
      "Модель от ByteDance с высокой эстетикой и пониманием текста на изображениях. Версия 5.0 — актуальная, 4.5 — быстрее и дешевле.",
    defaultModelId: "seedream-5",
    members: [
      { modelId: "seedream-4.5", versionLabel: "4.5", variantLabel: "Standard" },
      { modelId: "seedream-5", versionLabel: "5.0", variantLabel: "Standard" },
    ],
  },

  // ── Video families ─────────────────────────────────────────────────────────

  kling: {
    id: "kling",
    name: "🎥 Kling",
    section: "video",
    description: "Генерирует видео длиной до 15 секунд. Лучше всех передаёт движения людей.",
    defaultModelId: "kling",
    members: [
      { modelId: "kling", variantLabel: "Standard" },
      { modelId: "kling-pro", variantLabel: "Pro" },
    ],
  },

  higgsfield: {
    id: "higgsfield",
    name: "🎬 Higgsfield",
    section: "video",
    description:
      "Специализируется на реалистичной анимации людей — мимика, жесты, движения тела выглядят естественно. Lite — доступная версия, Turbo — профессиональная, Preview — флагман.",
    defaultModelId: "higgsfield",
    members: [
      { modelId: "higgsfield-lite", variantLabel: "Lite" },
      { modelId: "higgsfield", variantLabel: "Turbo" },
      { modelId: "higgsfield-preview", variantLabel: "Preview" },
    ],
  },

  veo: {
    id: "veo",
    name: "📽️ Veo 3",
    section: "video",
    description:
      "Видео от Google со звуком и голосами. Standard — максимальное качество, Fast — быстрее и дешевле. Поддерживает фото как референс.",
    defaultModelId: "veo-fast",
    members: [
      { modelId: "veo-fast", variantLabel: "Fast" },
      { modelId: "veo", variantLabel: "Pro" },
    ],
  },

  seedance: {
    id: "seedance",
    name: "💃 Seedance",
    section: "video",
    description:
      "Видеомодель от ByteDance с выразительной динамикой и высокой детализацией. Версия 1.5 — доступная, 2.0 — флагман с улучшенным качеством, Fast — быстрая версия 2.0.",
    defaultModelId: "seedance-2",
    members: [
      { modelId: "seedance", versionLabel: "1.5", variantLabel: "Pro" },
      { modelId: "seedance-2", versionLabel: "2.0", variantLabel: "Standard" },
      { modelId: "seedance-2-fast", versionLabel: "2.0", variantLabel: "Fast" },
    ],
  },

  "kling-motion": {
    id: "kling-motion",
    name: "🎥 Kling Motion",
    section: "video",
    description:
      "Переносит движения из референсного видео на любого персонажа с изображения. Идеален для портретов и простых анимаций.",
    defaultModelId: "kling-motion",
    members: [
      { modelId: "kling-motion", variantLabel: "Standard" },
      { modelId: "kling-motion-pro", variantLabel: "Pro" },
    ],
  },

  "grok-imagine": {
    id: "grok-imagine",
    name: "🔮 Grok Imagine",
    section: "video",
    description:
      "Видеомодель от xAI (Grok). Два режима: text-to-video — генерация по текстовому промпту; reference-to-video — генерация по референсным изображениям.",
    defaultModelId: "grok-imagine",
    members: [
      { modelId: "grok-imagine", variantLabel: "текст → видео" },
      { modelId: "grok-imagine-r2v", variantLabel: "фото → видео" },
    ],
  },

  minimax: {
    id: "minimax",
    name: "🎞️ Hailuo 2.3",
    section: "video",
    description:
      "Видеомодель MiniMax с плавным движением, поддержкой 1080p и 10-секундных клипов. Fast — быстрее и ~40% дешевле при схожем качестве.",
    defaultModelId: "hailuo-fast",
    members: [
      { modelId: "hailuo-fast", variantLabel: "Fast" },
      { modelId: "hailuo", variantLabel: "Standard" },
    ],
  },
};

/** All families grouped by section (e.g. "design", "video"). */
export const FAMILIES_BY_SECTION: Record<string, ModelFamily[]> = Object.values(
  MODEL_FAMILIES,
).reduce(
  (acc, f) => {
    if (!acc[f.section]) acc[f.section] = [];
    acc[f.section].push(f);
    return acc;
  },
  {} as Record<string, ModelFamily[]>,
);

/** Fast lookup: modelId → familyId. */
export const MODEL_TO_FAMILY: Record<string, string> = Object.values(MODEL_FAMILIES).reduce(
  (acc, f) => {
    for (const m of f.members) acc[m.modelId] = f.id;
    return acc;
  },
  {} as Record<string, string>,
);
