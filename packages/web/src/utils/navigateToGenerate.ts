import type { NavigateFunction } from "react-router-dom";
import { findPresetKeyForModel } from "@/config/presets";

/**
 * Префил формы генерации при переходе с Gallery / PromptsPage.
 * Передаётся через `location.state.prefill` (см. `GenerateScene`).
 *
 * Не делает запросов на бэк — все данные собираются на странице-источнике.
 */

export type GenerateSection = "image" | "video" | "audio";

export type GeneratePrefill = {
  section: GenerateSection;
  modelId: string;
  prompt: string;
  settings?: Record<string, unknown>;
};

/**
 * Нормализуем значение поля `section` к роуту /image | /video | /audio.
 *
 * `PromptExample.section` исторически использует "design" для картинок
 * (см. `PromptsPage.tsx`), тогда как `GalleryJob.section` — "image". Возвращаем
 * `null` для неизвестных значений, чтобы вызывающий код мог safely no-op.
 */
export function normalizeSection(raw: string): GenerateSection | null {
  if (raw === "design" || raw === "image") return "image";
  if (raw === "video") return "video";
  if (raw === "audio") return "audio";
  return null;
}

/**
 * Переходит на страницу генерации соответствующей секции и кладёт префил в
 * `location.state`.
 *
 * Если у модели есть выделенный URL-пресет (`hideModelPicker`-сценарий вроде
 * `photo-create` / `upscale` / `clone`), ведём на его страницу `/${section}/${key}`:
 * иначе preset-only (`hiddenFromCarousel`) модель отфильтровалась бы из списка на
 * голой странице, и префил откатился бы на дефолтную модель. На пресет-странице
 * модель есть в `allowedModelIds`, а `usePresetSetup` уступает нашему prefill
 * (совпадает `modelId`), так что prompt + settings юзера восстанавливаются.
 *
 * Для обычных карусельных моделей — голая секция с `?model=<id>` (совместимость с
 * URL→state синком в `GenerateScene` и shareable-навигацией из navbar'а).
 */
export function navigateToGenerate(navigate: NavigateFunction, prefill: GeneratePrefill): void {
  const presetKey = findPresetKeyForModel(prefill.section, prefill.modelId);
  const path = presetKey
    ? `/${prefill.section}/${presetKey}`
    : `/${prefill.section}?model=${encodeURIComponent(prefill.modelId)}`;
  navigate(path, { state: { prefill } });
}
