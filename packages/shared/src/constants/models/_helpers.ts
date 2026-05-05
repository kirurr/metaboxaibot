import type { ModelSettingDef } from "../../types/ai.js";

// ── Helper builders ───────────────────────────────────────────────────────────

/** Creates an aspect_ratio select setting from an ordered list of ratio strings. */
export function mkAspectRatio(
  ratios: string[],
  labelMap?: Record<string, string>,
): ModelSettingDef {
  return {
    key: "aspect_ratio",
    label: "Соотношение сторон",
    description: "Пропорции кадра — соотношение ширины и высоты.",
    type: "select",
    options: ratios.map((r) => ({ value: r, label: labelMap?.[r] ?? r })),
    default: ratios[0],
  };
}

/** Creates a duration select setting from a list of discrete second values. */
export function mkDurationSelect(durations: number[]): ModelSettingDef {
  return {
    key: "duration",
    label: "Длительность",
    description: "Продолжительность видеоклипа в секундах.",
    type: "select",
    options: durations.map((d) => ({ value: d, label: `${d} с` })),
    default: durations[0],
  };
}

/** Creates a duration slider setting for a continuous range. */
export function mkDurationSlider(min: number, max: number): ModelSettingDef {
  return {
    key: "duration",
    label: "Длительность (с)",
    description: `Продолжительность видеоклипа: от ${min} до ${max} секунд.`,
    type: "slider",
    min,
    max,
    step: 1,
    default: min,
  };
}

/**
 * Picker «количество изображений» (1..max) для batch генерации.
 * Используется и для virtual batch (`maxVirtualBatch`), и для native batch
 * (`nativeBatchMax`) — фронт просто шлёт `modelSettings.num_images`, дальше
 * адаптер либо передаёт значение провайдеру (native), либо воркер запускает
 * N последовательных submit'ов с разнесением (virtual). В обоих случаях
 * списывается за фактически сгенерированные изображения.
 */
export function mkNumImagesSetting(max: number): ModelSettingDef {
  return {
    key: "num_images",
    label: "Количество изображений",
    description:
      "Сгенерировать несколько вариантов за один запрос. Списывается только за успешные.",
    type: "select",
    options: Array.from({ length: max }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
    default: 1,
  };
}

/** Стандартный picker 1-4 (большинство моделей). Equivalent to mkNumImagesSetting(4). */
export const NUM_IMAGES_SETTING: ModelSettingDef = mkNumImagesSetting(4);
