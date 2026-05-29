import type { WebModelDto } from "@/api/models";

/**
 * Общая капабилити-конфигурация (image / video / audio / chat) и хелперы
 * рендера моделей. Используется и desktop-овым `CapabilityTabs` (mega-menu в
 * TopNav), и mobile-овым `GenerateSheet` (bottom-sheet, открываемый FAB-кой
 * центральной кнопки BottomNav). Источник правды один — чтобы пресеты и
 * подписи моделей не разъезжались между двумя UI.
 */

export type Capability = {
  id: "text" | "image" | "video" | "audio";
  /** i18n-ключ для подписи капабилити (резолвится в рендере). */
  labelKey: string;
  route: string;
};

export const CAPABILITIES: readonly Capability[] = [
  { id: "text", labelKey: "capabilities.chat", route: "/chat" },
  { id: "image", labelKey: "capabilities.image", route: "/image" },
  { id: "video", labelKey: "capabilities.video", route: "/video" },
  { id: "audio", labelKey: "capabilities.audio", route: "/audio" },
] as const;

export type MenuItem = {
  /** i18n-ключи для name/desc. */
  nameKey: string;
  descKey: string;
  glyph?: string;
  letter?: string;
  badge?: "TOP" | "NEW";
  /** Sub-route внутри секции (например "photo-create" → /image/photo-create). */
  link?: string;
};

/** Сколько моделей показываем в mega-menu/sheet максимум — чтобы не утопить колонку. */
export const MAX_MODELS_IN_MENU = 6;

/** Имя моделей в UI: для family-моделей подставляем familyName, иначе `webName` (без эмодзи). */
export function displayModelName(m: WebModelDto): string {
  return m.familyName ?? m.webName;
}

/** Короткое описание для строки в mega-menu (приоритет: описание варианта → общее описание). */
export function displayModelDesc(m: WebModelDto): string {
  return m.descriptionOverride ?? m.description;
}

/**
 * Дедуп семейств: Flux Pro / LoRA / etc. → одна строка с familyName. Без
 * семейного id модель оставляем как есть. Сохраняет исходный порядок.
 */
export function dedupByFamily(list: WebModelDto[]): WebModelDto[] {
  const seenFamilies = new Set<string>();
  const out: WebModelDto[] = [];
  for (const m of list) {
    if (m.familyId) {
      if (seenFamilies.has(m.familyId)) continue;
      seenFamilies.add(m.familyId);
    }
    out.push(m);
  }
  return out;
}

export const FEATURE_MENUS: Record<string, MenuItem[]> = {
  image: [
    {
      nameKey: "capabilities.features.image.generate.name",
      descKey: "capabilities.features.image.generate.desc",
      glyph: "▢",
    },
    {
      nameKey: "capabilities.features.image.photoCreate.name",
      descKey: "capabilities.features.image.photoCreate.desc",
      glyph: "❂",
      link: "photo-create",
    },
    // Плейсхолдеры без пресета/реализации — временно скрыты (вели просто на /image).
    // {
    //   nameKey: "capabilities.features.image.product.name",
    //   descKey: "capabilities.features.image.product.desc",
    //   glyph: "◈",
    // },
    // {
    //   nameKey: "capabilities.features.image.edit.name",
    //   descKey: "capabilities.features.image.edit.desc",
    //   glyph: "◯",
    // },
    {
      nameKey: "capabilities.features.image.upscale.name",
      descKey: "capabilities.features.image.upscale.desc",
      glyph: "▲",
      link: "upscale",
    },
    // {
    //   nameKey: "capabilities.features.image.lora.name",
    //   descKey: "capabilities.features.image.lora.desc",
    //   glyph: "✪",
    // },
    // {
    //   nameKey: "capabilities.features.image.style.name",
    //   descKey: "capabilities.features.image.style.desc",
    //   glyph: "◇",
    // },
    {
      nameKey: "capabilities.features.image.background.name",
      descKey: "capabilities.features.image.background.desc",
      glyph: "▦",
      link: "bg-removal",
    },
    {
      nameKey: "capabilities.features.image.faceSwap.name",
      descKey: "capabilities.features.image.faceSwap.desc",
      glyph: "◑",
      link: "face-swap",
    },
    {
      nameKey: "capabilities.features.image.clothingTryon.name",
      descKey: "capabilities.features.image.clothingTryon.desc",
      glyph: "❖",
      link: "clothing-tryon",
    },
    {
      nameKey: "capabilities.features.image.objectRemoval.name",
      descKey: "capabilities.features.image.objectRemoval.desc",
      glyph: "⊘",
      link: "object-removal",
    },
  ],
  video: [
    {
      nameKey: "capabilities.features.video.create.name",
      descKey: "capabilities.features.video.create.desc",
      glyph: "▷",
    },
    {
      nameKey: "capabilities.features.video.animate.name",
      descKey: "capabilities.features.video.animate.desc",
      glyph: "◉",
      link: "photo-animate",
    },
    // Плейсхолдеры без пресета/реализации — временно скрыты (вели просто на /video).
    // {
    //   nameKey: "capabilities.features.video.cinema.name",
    //   descKey: "capabilities.features.video.cinema.desc",
    //   glyph: "▣",
    //   badge: "TOP",
    // },
    // {
    //   nameKey: "capabilities.features.video.mixed.name",
    //   descKey: "capabilities.features.video.mixed.desc",
    //   glyph: "◫",
    // },
    // {
    //   nameKey: "capabilities.features.video.edit.name",
    //   descKey: "capabilities.features.video.edit.desc",
    //   glyph: "▥",
    // },
    // {
    //   nameKey: "capabilities.features.video.lipsync.name",
    //   descKey: "capabilities.features.video.lipsync.desc",
    //   glyph: "◎",
    // },
    // {
    //   nameKey: "capabilities.features.video.sketch.name",
    //   descKey: "capabilities.features.video.sketch.desc",
    //   glyph: "✏",
    // },
    {
      nameKey: "capabilities.features.video.upscale.name",
      descKey: "capabilities.features.video.upscale.desc",
      glyph: "▱",
      link: "video-upscale",
    },
    // {
    //   nameKey: "capabilities.features.video.avatar.name",
    //   descKey: "capabilities.features.video.avatar.desc",
    //   glyph: "◍",
    //   badge: "NEW",
    // },
  ],
  audio: [
    {
      nameKey: "capabilities.features.audio.tts.name",
      descKey: "capabilities.features.audio.tts.desc",
      glyph: "◀",
      link: "tts",
    },
    {
      nameKey: "capabilities.features.audio.clone.name",
      descKey: "capabilities.features.audio.clone.desc",
      glyph: "○",
      badge: "TOP",
      link: "clone",
    },
    {
      nameKey: "capabilities.features.audio.music.name",
      descKey: "capabilities.features.audio.music.desc",
      glyph: "♫",
      link: "music",
    },
    {
      nameKey: "capabilities.features.audio.sounds.name",
      descKey: "capabilities.features.audio.sounds.desc",
      glyph: "≋",
      link: "sounds",
    },
    // Плейсхолдеры без пресета/реализации — временно скрыты (вели просто на /audio).
    // {
    //   nameKey: "capabilities.features.audio.dubbing.name",
    //   descKey: "capabilities.features.audio.dubbing.desc",
    //   glyph: "◯",
    // },
    // {
    //   nameKey: "capabilities.features.audio.transcribe.name",
    //   descKey: "capabilities.features.audio.transcribe.desc",
    //   glyph: "▤",
    // },
    // {
    //   nameKey: "capabilities.features.audio.cleanup.name",
    //   descKey: "capabilities.features.audio.cleanup.desc",
    //   glyph: "△",
    // },
    // {
    //   nameKey: "capabilities.features.audio.library.name",
    //   descKey: "capabilities.features.audio.library.desc",
    //   glyph: "▼",
    // },
  ],
};
