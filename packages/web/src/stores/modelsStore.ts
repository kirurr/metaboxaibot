import { create } from "zustand";
import { getModels, type ModelSection, type WebModelDto } from "@/api/models";

/**
 * Глобальный кэш каталога моделей. Тянем один раз после авторизации
 * (`/web/models` под webAuth, без требования Telegram) и расходим по компонентам
 * — CapabilityTabs (mega-menu), Image/Video/Audio (dropdown), Home (опц.).
 *
 * `load()` идемпотентен в рамках сессии: повторный вызов в `loading`-стейте
 * возвращает текущий промис; если уже загружено — no-op. `reload()` сбрасывает
 * флаг и тянет заново — используется при logout/login переключении.
 */

type ModelsState = {
  models: WebModelDto[];
  isLoading: boolean;
  loaded: boolean;
  error: string | null;
  /** Идемпотентная загрузка. */
  load: () => Promise<void>;
  /** Принудительный rfetch. */
  reload: () => Promise<void>;
  /** Очистить кэш при logout. */
  clear: () => void;
};

// Кэшируем активный промис вне стейта, чтобы параллельные load() не плодили
// несколько fetch'ей в один и тот же эндпоинт (React StrictMode и пр.).
let inFlight: Promise<void> | null = null;

export const useModelsStore = create<ModelsState>((set, get) => ({
  models: [],
  isLoading: false,
  loaded: false,
  error: null,

  load: async () => {
    if (get().loaded || get().isLoading) {
      if (inFlight) return inFlight;
      return;
    }
    set({ isLoading: true, error: null });
    inFlight = (async () => {
      try {
        const models = await getModels();
        set({ models, isLoading: false, loaded: true, error: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Не удалось загрузить модели";
        set({ isLoading: false, error: message });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },

  reload: async () => {
    set({ loaded: false });
    return get().load();
  },

  clear: () => set({ models: [], isLoading: false, loaded: false, error: null }),
}));

/** Маппинг capability'а из UI на секцию каталога. */
const CAPABILITY_TO_SECTION: Record<string, ModelSection> = {
  text: "gpt",
  image: "design",
  video: "video",
  audio: "audio",
};

/** Хелпер: модели для конкретной capability с фильтром по секции. */
export function modelsForCapability(
  all: WebModelDto[],
  capability: "text" | "image" | "video" | "audio",
): WebModelDto[] {
  const section = CAPABILITY_TO_SECTION[capability];
  if (!section) return [];
  return all.filter((m) => m.section === section);
}

/** Хелпер: модели для произвольной секции каталога. */
export function modelsForSection(all: WebModelDto[], section: ModelSection): WebModelDto[] {
  return all.filter((m) => m.section === section);
}
