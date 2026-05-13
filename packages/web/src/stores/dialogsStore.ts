import { create } from "zustand";
import * as dialogsApi from "@/api/dialogs";
import type { DialogDto } from "@/api/dialogs";

/**
 * Глобальный кэш диалогов пользователя для секции «gpt» (текстовый чат).
 * Расходуется в Chat-page sidebar'е. Загружается по требованию, чистится на
 * logout (см. App.tsx).
 *
 * Сообщения внутри диалога НЕ кэшируем — они грузятся при выборе треда в
 * локальном state Chat.tsx (история большая, держать всё в памяти нет смысла).
 */

type DialogsState = {
  dialogs: DialogDto[];
  isLoading: boolean;
  loaded: boolean;
  /** Сообщение ошибки от последнего load() — UI использует, чтобы показать banner. */
  error: string | null;
  /** Код ошибки от apiClient (например TELEGRAM_NOT_LINKED). */
  errorCode: string | null;

  load: (section?: string) => Promise<void>;
  reload: (section?: string) => Promise<void>;
  /** Добавить новый диалог в начало списка (после createDialog). */
  prepend: (d: DialogDto) => void;
  /** Обновить title диалога. */
  rename: (id: string, title: string) => void;
  /** Удалить диалог из списка. */
  remove: (id: string) => void;
  /** Поднять диалог наверх (после успешной отправки сообщения). */
  bump: (id: string) => void;
  clear: () => void;
};

let inFlight: Promise<void> | null = null;

export const useDialogsStore = create<DialogsState>((set, get) => ({
  dialogs: [],
  isLoading: false,
  loaded: false,
  error: null,
  errorCode: null,

  load: async (section) => {
    if (get().loaded || get().isLoading) {
      if (inFlight) return inFlight;
      return;
    }
    set({ isLoading: true, error: null, errorCode: null });
    inFlight = (async () => {
      try {
        const dialogs = await dialogsApi.listDialogs(section);
        set({ dialogs, isLoading: false, loaded: true, error: null, errorCode: null });
      } catch (err) {
        const e = err as { message?: string; code?: string };
        set({
          isLoading: false,
          error: e.message ?? "Не удалось загрузить диалоги",
          errorCode: e.code ?? null,
        });
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },

  reload: async (section) => {
    set({ loaded: false });
    return get().load(section);
  },

  prepend: (d) => set((s) => ({ dialogs: [d, ...s.dialogs] })),

  rename: (id, title) =>
    set((s) => ({
      dialogs: s.dialogs.map((d) => (d.id === id ? { ...d, title } : d)),
    })),

  remove: (id) => set((s) => ({ dialogs: s.dialogs.filter((d) => d.id !== id) })),

  bump: (id) =>
    set((s) => {
      const idx = s.dialogs.findIndex((d) => d.id === id);
      if (idx <= 0) return s; // нет в списке или уже наверху
      const updated = { ...s.dialogs[idx], updatedAt: new Date().toISOString() };
      const rest = s.dialogs.filter((d) => d.id !== id);
      return { dialogs: [updated, ...rest] };
    }),

  clear: () =>
    set({
      dialogs: [],
      isLoading: false,
      loaded: false,
      error: null,
      errorCode: null,
    }),
}));
