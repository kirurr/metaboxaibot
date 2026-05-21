import { apiClient } from "./client";

/**
 * Ambient (фоновые) медиа для пустого состояния экрана генерации — пока юзер
 * ещё ничего не сгенерировал, в фоне «выпадают» и мягко плавают красивые
 * картинки (на /image) или автоплеящиеся видео (на /video).
 *
 * Источник данных — единая точка интеграции: сейчас фронт пытается забрать пак
 * с бэка (`GET /web/ambient-media?section=image|video`), а если эндпоинта ещё
 * нет / он пуст — откатывается на встроенные стоковые ссылки ниже. Когда в
 * админке появится загрузка пака, ничего во вью-слое менять не придётся:
 * достаточно реализовать эндпоинт, который вернёт тот же `AmbientMediaPack`.
 */

export type AmbientSection = "image" | "video";

export interface AmbientMediaItem {
  /** Полный URL картинки/видео. */
  url: string;
  /** Постер для видео (необязателен). Для картинок игнорируется. */
  posterUrl?: string | null;
}

export interface AmbientMediaPack {
  section: AmbientSection;
  items: AmbientMediaItem[];
}

/** Встроенные стоковые картинки (Unsplash) — fallback, пока нет пака из админки. */
const STOCK_IMAGES: AmbientMediaItem[] = [
  {
    url: "https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=500&q=80&auto=format&fit=crop",
  },
  {
    url: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=500&q=80&auto=format&fit=crop",
  },
  {
    url: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?w=500&q=80&auto=format&fit=crop",
  },
  {
    url: "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=500&q=80&auto=format&fit=crop",
  },
  {
    url: "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=500&q=80&auto=format&fit=crop",
  },
  {
    url: "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=500&q=80&auto=format&fit=crop",
  },
  {
    url: "https://images.unsplash.com/photo-1502685104226-ee32379fefbe?w=500&q=80&auto=format&fit=crop",
  },
  {
    url: "https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=500&q=80&auto=format&fit=crop",
  },
  {
    url: "https://images.unsplash.com/photo-1488161628813-04466f872be2?w=500&q=80&auto=format&fit=crop",
  },
  {
    url: "https://images.unsplash.com/photo-1501196354995-cbb51c65aaea?w=500&q=80&auto=format&fit=crop",
  },
];

/** Встроенные стоковые видео (Google sample bucket) — небольшие, autoplay/loop. */
const STOCK_VIDEOS: AmbientMediaItem[] = [
  { url: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4" },
  { url: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4" },
  { url: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4" },
  { url: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4" },
  { url: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerMeltdowns.mp4" },
];

function stockPack(section: AmbientSection): AmbientMediaPack {
  return {
    section,
    items: section === "video" ? STOCK_VIDEOS : STOCK_IMAGES,
  };
}

/**
 * Возвращает пак ambient-медиа для секции. Пытается забрать с бэка; при любой
 * ошибке (нет эндпоинта / сеть / пустой пак) тихо откатывается на стоковый.
 */
export async function getAmbientMedia(section: AmbientSection): Promise<AmbientMediaPack> {
  try {
    const pack = await apiClient<AmbientMediaPack>("/web/ambient-media", {
      query: { section },
    });
    if (pack && Array.isArray(pack.items) && pack.items.length > 0) {
      return { section, items: pack.items };
    }
  } catch {
    // эндпоинта пока нет / ошибка — используем стоковый пак
  }
  return stockPack(section);
}
