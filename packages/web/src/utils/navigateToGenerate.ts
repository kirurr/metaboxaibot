import type { NavigateFunction } from "react-router-dom";

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
 * `location.state`. `?model=<id>` дублируется в URL для совместимости с
 * существующим URL→state синком в `GenerateScene` и shareable-навигацией из
 * navbar'а.
 */
export function navigateToGenerate(
  navigate: NavigateFunction,
  prefill: GeneratePrefill,
): void {
  navigate(`/${prefill.section}?model=${encodeURIComponent(prefill.modelId)}`, {
    state: { prefill },
  });
}
