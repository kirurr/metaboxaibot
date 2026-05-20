import { useCallback, useEffect, useMemo } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { WebModelDto } from "@/api/models";
import type { GenerateSection } from "@/utils/navigateToGenerate";
import type { GeneratePreset } from "@/config/presets";
import { presetsBySection } from "@/config/presets";

/**
 * Разруливает URL вида `/image/:preset` для страниц генерации:
 *  - лукап пресета из `presetsBySection`,
 *  - фильтр моделей по `allowedModelIds`,
 *  - i18n-резолв строковых полей (literal тоже работает — i18next возвращает
 *    ключ как fallback),
 *  - одноразовый prefill через `location.state` (поверх существующего
 *    префил-механизма в `GenerateScene`).
 */

export type PresetSetup = {
  preset: GeneratePreset | null;
  models: readonly WebModelDto[];
  title?: string;
  subtitle?: string;
  promptPlaceholder?: string;
  hideModelPicker: boolean;
  /** True если URL содержит preset, которого нет в конфиге — page wrapper должен показать NotFound. */
  notFound: boolean;
  /**
   * Сброс к снимку пресета. undefined если у пресета нет `modelId` (нечего
   * применять) или мы не на пресетной странице. Кнопка «Сбросить» в
   * `GenerateScene` рендерится только когда callback задан И юзер что-то
   * вручную поменял.
   */
  resetPreset?: () => void;
  /**
   * Полная мапа настроек пресета по `modelId`. Используется в `GenerateScene`
   * для автоприменения при ручной смене модели. Undefined если не пресетная
   * страница или у пресета нет `settings`.
   */
  presetSettingsByModel?: Record<string, Record<string, unknown>>;
};

export function usePresetSetup(
  section: GenerateSection,
  allSectionModels: readonly WebModelDto[],
): PresetSetup {
  const { preset: presetKey } = useParams<{ preset?: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const preset = presetKey ? (presetsBySection[section][presetKey] ?? null) : null;
  const notFound = !!presetKey && !preset;

  const filteredModels = useMemo(() => {
    if (!preset?.allowedModelIds || preset.allowedModelIds.length === 0) {
      return allSectionModels;
    }
    const allowed = new Set(preset.allowedModelIds);
    return allSectionModels.filter((m) => allowed.has(m.id));
  }, [allSectionModels, preset]);

  // Кладём prefill в location.state один раз на смену presetKey. Существующий
  // префил-механизм GenerateScene применит prompt + modelId + settings.
  // Страж — проверяем, что state ещё не содержит нашего префила (иначе цикл
  // location → effect → navigate → effect).
  useEffect(() => {
    if (!preset || !preset.modelId) return;
    const existing = (location.state as { prefill?: { modelId?: string } } | null)?.prefill;
    if (existing?.modelId === preset.modelId) return;

    navigate(location.pathname + location.search, {
      replace: true,
      state: {
        prefill: {
          section,
          modelId: preset.modelId,
          prompt: preset.prompt,
          // Settings конкретно для дефолтной модели пресета.
          settings: preset.settings?.[preset.modelId],
        },
      },
    });
    // Зависим только от presetKey — ручная смена модели не должна триггерить
    // повторный префил. Прочие зависимости (preset, location, navigate)
    // безопасны благодаря стражу `existing?.modelId === preset.modelId`.
  }, [presetKey]);

  // Кнопка «Сбросить» — новый navigate с тем же prefill, но новым location.key.
  // Префил-effect в GenerateScene видит новый key и реапплит prompt + model +
  // settings. Слот-файлы не трогаем (см. комментарий в GenerateScene).
  const resetPreset = useCallback(() => {
    if (!preset || !preset.modelId) return;
    navigate(location.pathname + location.search, {
      state: {
        prefill: {
          section,
          modelId: preset.modelId,
          prompt: preset.prompt,
          settings: preset.settings?.[preset.modelId],
        },
      },
    });
  }, [preset, navigate, location.pathname, location.search, section]);

  return {
    preset,
    models: filteredModels,
    title: preset?.title ? t(preset.title) : undefined,
    subtitle: preset?.subtitle ? t(preset.subtitle) : undefined,
    promptPlaceholder: preset?.promptPlaceholder ? t(preset.promptPlaceholder) : undefined,
    hideModelPicker: !!preset?.hideModelPicker,
    notFound,
    resetPreset: preset?.modelId ? resetPreset : undefined,
    presetSettingsByModel: preset?.settings,
  };
}
