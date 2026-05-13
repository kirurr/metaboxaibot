import type { AIModel, ModelSettingDef } from "../../types/ai.js";

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

/**
 * Дефолт duration по модели — то значение, которое UI рендерит в слайдере/селекте
 * ДО любого взаимодействия юзера. Используется для fallback'а когда в userState
 * нет сохранённого `modelSettings.duration` (юзер не двигал контрол).
 *
 * Раньше fallback падал сразу на `durationRange.min` / `supportedDurations[0]`, и
 * для kling это давало 3 (min), хотя UI слайдер изначально показывает 5
 * (KLING_SETTINGS.default). Юзер видел «5», бот молча слал «3», провайдер
 * возвращал 3-сек видео — UX-разрыв и недопоставка.
 *
 * Приоритет:
 *   1) `settings[duration].default` (то, что нарисовано в UI — единый источник
 *      истины для дефолта)
 *   2) `supportedDurations[0]` (для дискретных вариантов)
 *   3) `durationRange.min` (для слайдеров без явного default'а)
 *
 * Возвращает `undefined` если у модели нет ни одного из этих полей —
 * callers сами решают финальный fallback (обычно `?? 5`).
 *
 * Проверка `typeof === "number"`: ModelSettingDef.default — это `string |
 * number | boolean | null`. Цастать as number небезопасно (NaN при string
 * "auto" → broken cost calc). Strict-проверка отсекает не-числовые default'ы.
 */
export function getModelDefaultDuration(model: AIModel): number | undefined {
  const setting = model.settings?.find((s) => s.key === "duration");
  if (setting && typeof setting.default === "number") return setting.default;
  if (model.supportedDurations && model.supportedDurations.length > 0) {
    return model.supportedDurations[0];
  }
  return model.durationRange?.min;
}
