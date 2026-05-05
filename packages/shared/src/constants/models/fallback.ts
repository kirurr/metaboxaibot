import type { AIModel } from "../../types/ai.js";
import { FALLBACK_DESIGN_MODELS } from "./design.models.js";
import { FALLBACK_VIDEO_MODELS } from "./video.models.js";
import { FALLBACK_LLM_MODELS } from "./gpt.models.js";
import { FALLBACK_AUDIO_MODELS } from "./audio.models.js";

export type FallbackSection = "design" | "video" | "llm" | "audio";

/**
 * Возвращает упорядоченный список fallback-кандидатов для primary modelId
 * в указанной секции. Каждый элемент — полноценный AIModel с собственным
 * `provider` (другой адаптер, другой ключ-пул).
 *
 * Пустой массив = у этой модели нет зарегистрированного fallback.
 * Перебор кандидатов выполняется в порядке добавления в FALLBACK_*_MODELS;
 * processor берёт первый совместимый и доступный.
 */
export function getFallbackCandidates(primaryModelId: string, section: FallbackSection): AIModel[] {
  const pool =
    section === "design"
      ? FALLBACK_DESIGN_MODELS
      : section === "video"
        ? FALLBACK_VIDEO_MODELS
        : section === "llm"
          ? FALLBACK_LLM_MODELS
          : FALLBACK_AUDIO_MODELS;
  return pool.filter((m) => m.id === primaryModelId);
}

/**
 * Проверяет совместимость fallback-модели с конкретной задачей.
 *
 * Три уровня проверок:
 *
 * 1. **Required-slot check**: если у fallback есть слот с `required: true`,
 *    задача обязана его заполнить (e.g. FAL grok-imagine требует ≥1 reference
 *    image — pure t2v через этот endpoint невозможен).
 *
 * 2. **Slot capacity check**: для каждого slotKey с непустым массивом urls'ов:
 *    у fallback должен быть слот с тем же `slotKey`, и его `maxImages`
 *    (default 1) должен быть >= количества загруженных медиа.
 *
 * 3. **Duration check** (опционально): если у fallback задан `durationRange`
 *    и `jobDuration` известен — duration должна попадать в [min, max].
 *    Используется когда fallback-провайдер поддерживает короче, чем primary
 *    (e.g. FAL grok-imagine max 10s vs primary KIE max 30s — на больших duration
 *    fallback пропускается и processor пробует следующего кандидата).
 *
 * `modelSettings` адаптеры фильтруют сами (unknown ключи игнорируются),
 * поэтому проверяем только media-слоты + duration.
 */
export function isFallbackCompatible(
  fallback: AIModel,
  jobMediaInputs: Record<string, string[]> | undefined,
  jobDuration?: number,
): boolean {
  // Duration check — независимо от media inputs.
  if (jobDuration !== undefined && fallback.durationRange) {
    if (jobDuration < fallback.durationRange.min || jobDuration > fallback.durationRange.max) {
      return false;
    }
  }

  // Required-slot check — должны быть заполнены даже при пустом jobMediaInputs.
  const fallbackSlots = new Map((fallback.mediaInputs ?? []).map((s) => [s.slotKey, s] as const));
  for (const slot of fallbackSlots.values()) {
    if (slot.required) {
      const provided = jobMediaInputs?.[slot.slotKey];
      if (!provided || provided.length === 0) return false;
    }
  }

  // Slot capacity check — для существующих media inputs.
  if (!jobMediaInputs) return true;
  const usedSlots = Object.entries(jobMediaInputs).filter(
    ([, urls]) => Array.isArray(urls) && urls.length > 0,
  );
  if (usedSlots.length === 0) return true;
  return usedSlots.every(([slotKey, urls]) => {
    const slot = fallbackSlots.get(slotKey);
    if (!slot) return false;
    const slotMax = slot.maxImages ?? 1;
    return urls.length <= slotMax;
  });
}
