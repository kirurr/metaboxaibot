import { create } from "zustand";
import { getModels, type ModelSection, type WebModelDto } from "@/api/models";
import { i18n } from "@/i18n";

/**
 * Глобальный кэш каталога моделей. Тянем один раз после авторизации
 * (`/web/models` под webAuth, без требования Telegram) и расходим по компонентам
 * — CapabilityTabs (mega-menu), Image/Video/Audio (dropdown), Home (опц.).
 *
 * `load()` идемпотентен в рамках сессии: повторный вызов в `loading`-стейте
 * возвращает текущий промис; если уже загружено С ТЕМ ЖЕ языком — no-op. При
 * смене UI-языка (Settings) кэш считается устаревшим и `load()` тянет заново.
 * `reload()` всегда сбрасывает флаг.
 *
 * Подписка на `i18n.languageChanged` подключается в `setupModelsI18nSync()`
 * (вызывается из main.tsx) — это и есть точка интеграции с переключателем.
 */

type ModelsState = {
  models: WebModelDto[];
  /** Язык, под которым загружен текущий снапшот (для invalidate'а при смене). */
  language: string | null;
  isLoading: boolean;
  loaded: boolean;
  error: string | null;
  /** Идемпотентная загрузка (с учётом текущего UI-языка). */
  load: () => Promise<void>;
  /** Принудительный re-fetch. */
  reload: () => Promise<void>;
  /** Очистить кэш при logout. */
  clear: () => void;
};

// Кэшируем активный промис вне стейта, чтобы параллельные load() не плодили
// несколько fetch'ей в один и тот же эндпоинт (React StrictMode и пр.).
let inFlight: Promise<void> | null = null;

function currentUiLang(): string {
  // resolvedLanguage учитывает fallback chain ("en-US" → "en"). Берём 2 символа
  // на случай "en-US" — бэк ждёт "ru" / "en", а не "en-US".
  return (i18n.resolvedLanguage ?? i18n.language ?? "ru").slice(0, 2);
}

export const useModelsStore = create<ModelsState>((set, get) => ({
  models: [],
  language: null,
  isLoading: false,
  loaded: false,
  error: null,

  load: async () => {
    const wantedLang = currentUiLang();
    // Если язык изменился — нужно перегружать, даже если loaded=true.
    if ((get().loaded || get().isLoading) && get().language === wantedLang) {
      if (inFlight) return inFlight;
      return;
    }
    set({ isLoading: true, error: null });
    inFlight = (async () => {
      try {
        const models = await getModels(undefined, wantedLang);
        set({
          models,
          language: wantedLang,
          isLoading: false,
          loaded: true,
          error: null,
        });
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

  clear: () => set({ models: [], language: null, isLoading: false, loaded: false, error: null }),
}));

/**
 * Подписывается на смену UI-языка и перезагружает каталог моделей —
 * `modes[].label` / `mediaInputs[].label` приходят с бэка уже локализованными,
 * поэтому простой ре-рендер не помогает: нужен фактический re-fetch.
 *
 * Вызывается один раз из `main.tsx` после `import "./i18n"`.
 */
export function setupModelsI18nSync(): void {
  i18n.on("languageChanged", () => {
    // Только если что-то уже было загружено — иначе ленивая загрузка
    // подхватит актуальный язык сама.
    if (useModelsStore.getState().loaded) {
      void useModelsStore.getState().reload();
    }
  });
}

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
