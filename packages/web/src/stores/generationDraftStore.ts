import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ChatUploadDto } from "@/api/uploads";

// Per-family draft (ключ — `familyId ?? modelId`), persist в localStorage.
// `File` не сериализуем — для restore хватает `dto.s3Key` + `dto.url`.

export type StoredSlotFile = {
  id: string;
  status: "ready";
  dto: ChatUploadDto;
};

export type GenerationDraftEntry = {
  settings: Record<string, unknown>;
  slots: Record<string, StoredSlotFile[]>;
  /**
   * Выбор картинок для @-меншенов элементов: elementId → выбранные s3Key.
   * Активные элементы выводятся из текста промпта, а вот какие именно картинки
   * элемента уходят в генерацию (модель берёт лишь часть) — храним здесь.
   */
  elementSelections?: Record<string, string[]>;
};

type GenerationDraftState = {
  byKey: Record<string, GenerationDraftEntry>;
  setSettings: (key: string, values: Record<string, unknown>) => void;
  setSlots: (key: string, slots: Record<string, StoredSlotFile[]>) => void;
  setElementSelections: (key: string, selections: Record<string, string[]>) => void;
  clearForKey: (key: string) => void;
  clearAll: () => void;
};

export const useGenerationDraftStore = create<GenerationDraftState>()(
  persist(
    (set) => ({
      byKey: {},

      setSettings: (key, values) =>
        set((state) => ({
          byKey: {
            ...state.byKey,
            [key]: { ...state.byKey[key], settings: values, slots: state.byKey[key]?.slots ?? {} },
          },
        })),

      setSlots: (key, slots) =>
        set((state) => ({
          byKey: {
            ...state.byKey,
            [key]: { ...state.byKey[key], settings: state.byKey[key]?.settings ?? {}, slots },
          },
        })),

      setElementSelections: (key, selections) =>
        set((state) => ({
          byKey: {
            ...state.byKey,
            [key]: {
              ...state.byKey[key],
              settings: state.byKey[key]?.settings ?? {},
              slots: state.byKey[key]?.slots ?? {},
              elementSelections: selections,
            },
          },
        })),

      clearForKey: (key) =>
        set((state) => {
          if (!state.byKey[key]) return state;
          const next = { ...state.byKey };
          delete next[key];
          return { byKey: next };
        }),

      clearAll: () => set({ byKey: {} }),
    }),
    {
      name: "metabox.generation-draft",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ byKey: state.byKey }),
    },
  ),
);
