import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ChatUploadDto } from "@/api/uploads";

/**
 * Per-family draft: настройки и uploaded media slot'ы, сохраняемые между
 * сменами модели (включая variant/version chip) и переживающие reload.
 *
 * Ключ записи — `model.familyId ?? model.id`. Все siblings одного семейства
 * (Variant/Version chip'ы — Banana 1 / Banana 2 / Nano Banana Pro) делят
 * один bag: загруженные референсы и shared-настройки переезжают между ними
 * с clamp по `slot.maxImages` целевого варианта. Unique-настройки одного
 * варианта будут отфильтрованы defaults-effect'ом при переключении.
 *
 * GenerateScene держит локальный state для рендеров, а этот store —
 * мирор-источник истины, из которого state восстанавливается при смене
 * `modelId`. Persistence — localStorage.
 *
 * В localStorage кладём только `ready`-файлы: сырой `File` не сериализуем,
 * хватает `dto.s3Key` для submit + `dto.url` для превью. Presigned `url`
 * может протухнуть — graceful: превью покажется битым, юзер удалит и
 * перезагрузит.
 */

export type StoredSlotFile = {
  id: string;
  status: "ready";
  dto: ChatUploadDto;
};

export type GenerationDraftEntry = {
  settings: Record<string, unknown>;
  slots: Record<string, StoredSlotFile[]>;
};

type GenerationDraftState = {
  // Ключ — `model.familyId ?? model.id`. Имя поля `byKey` отражает это.
  byKey: Record<string, GenerationDraftEntry>;
  setSettings: (key: string, values: Record<string, unknown>) => void;
  setSlots: (key: string, slots: Record<string, StoredSlotFile[]>) => void;
  clearForKey: (key: string) => void;
  clearAll: () => void;
};

export const useGenerationDraftStore = create<GenerationDraftState>()(
  persist(
    (set) => ({
      byKey: {},

      setSettings: (key, values) =>
        set((state) => {
          const prev = state.byKey[key];
          return {
            byKey: {
              ...state.byKey,
              [key]: { settings: values, slots: prev?.slots ?? {} },
            },
          };
        }),

      setSlots: (key, slots) =>
        set((state) => {
          const prev = state.byKey[key];
          return {
            byKey: {
              ...state.byKey,
              [key]: { settings: prev?.settings ?? {}, slots },
            },
          };
        }),

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
      // v2: ключ — familyId (с fallback на modelId), v1 хранил по modelId.
      // Bump имени → старые записи остаются в localStorage, но не используются.
      name: "metabox.generation-draft.v2",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ byKey: state.byKey }),
    },
  ),
);
