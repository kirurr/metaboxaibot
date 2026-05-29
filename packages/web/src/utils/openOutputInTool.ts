import type { NavigateFunction } from "react-router-dom";
import { useModelsStore } from "@/stores/modelsStore";
import { useGenerationDraftStore, type StoredSlotFile } from "@/stores/generationDraftStore";
import { navigateToGenerate, type GenerateSection } from "@/utils/navigateToGenerate";

/**
 * «Открыть инструмент с текущим output'ом в input-слоте» — для кнопок модалки
 * превью (Анимировать / Референс / Апскейл).
 *
 * Механизм полностью переиспользует существующий path «переиспользования медиа»:
 * кладём output как `StoredSlotFile` (dto.s3Key = output.s3Key) в draft-store под
 * ключом семейства целевой модели, затем `navigateToGenerate`. `GenerateScene`
 * при выборе модели поднимет слот из draft-store (`restoreDraftForModel`), а URL
 * ре-сайнится через `/web/chat-uploads/sign` (он разрешает output-ключи юзера).
 * Бэк на сабмите пресайнит любой ключ владельца — output годится как input.
 */

export type ReuseTarget = {
  targetSection: GenerateSection;
  targetModelId: string;
  slotKey: string;
  slotType: "image" | "video";
};

/** Таргеты действий. modelId/slotKey зеркалят каталог + presets.ts. */
export const REUSE_TARGETS = {
  animate: {
    targetSection: "video",
    targetModelId: "photo-animate",
    slotKey: "ref_images",
    slotType: "image",
  },
  reference: {
    targetSection: "image",
    targetModelId: "nano-banana-2",
    slotKey: "edit",
    slotType: "image",
  },
  upscaleImage: {
    targetSection: "image",
    targetModelId: "image-upscale",
    slotKey: "edit",
    slotType: "image",
  },
  upscaleVideo: {
    targetSection: "video",
    targetModelId: "video-upscale",
    slotKey: "motion_video",
    slotType: "video",
  },
} as const satisfies Record<string, ReuseTarget>;

export type ReuseOutput = { s3Key: string; url: string | null; name: string };

export async function openOutputInTool(
  navigate: NavigateFunction,
  target: ReuseTarget,
  output: ReuseOutput,
): Promise<void> {
  // Гарантируем каталог: familyId критичен для ключа draft-store (напр. у
  // nano-banana-2 он есть, и без него restoreDraftForModel слот не найдёт).
  await useModelsStore.getState().load();
  const model = useModelsStore.getState().models.find((m) => m.id === target.targetModelId);
  const key = model?.familyId ?? target.targetModelId;

  const file: StoredSlotFile = {
    id: `reuse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: "ready",
    dto: {
      s3Key: output.s3Key,
      name: output.name,
      mimeType: target.slotType === "video" ? "video/mp4" : "image/png",
      size: 0,
      kind: target.slotType,
      url: output.url,
    },
  };

  // Мерж — не затираем прочие слоты возможного незавершённого черновика.
  const store = useGenerationDraftStore.getState();
  const existingSlots = store.byKey[key]?.slots ?? {};
  store.setSlots(key, { ...existingSlots, [target.slotKey]: [file] });

  navigateToGenerate(navigate, {
    section: target.targetSection,
    modelId: target.targetModelId,
    prompt: "",
  });
}
