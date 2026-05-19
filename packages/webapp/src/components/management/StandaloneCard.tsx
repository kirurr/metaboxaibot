// ── StandaloneCard ────────────────────────────────────────────────────────────

import { MODEL_TRANSLATIONS } from "@metabox/shared-browser";
import { useState } from "react";
import { useI18n } from "../../i18n";
import type { Model } from "../../types";
import { isInSectionPicker, modelCostLabel } from "../../utils/mediaSettingsViewHelpers";
import { SettingsPanel } from "./SettingsPanel";

interface StandaloneCardProps {
  model: Model;
  /** Бот реально active в чате с этой моделью (state === `*_ACTIVE`). */
  isActive: boolean;
  /**
   * Модель — текущий пик юзера для секции (`activeModelId === model.id`),
   * независимо от того, *_ACTIVE сейчас бот или *_SECTION (этап выбора).
   * Нужно отдельно от isActive чтобы кнопка «Начать работу» появлялась
   * в *_SECTION без побочного эффекта подсветки бейджа «Активна».
   */
  isSelected: boolean;
  activeState?: string;
  savedId: string | null;
  allModelSettings: Record<string, Record<string, unknown>>;
  selectedModeId?: string;
  onActivate: (modelId: string) => Promise<void>;
  onSettingChange: (key: string, value: unknown) => void;
  onModeChange?: (modeId: string) => void;
  onReset: (modelId: string) => void;
}

export function StandaloneCard({
  model,
  isActive,
  isSelected,
  activeState,
  savedId,
  allModelSettings,
  selectedModeId,
  onActivate,
  onSettingChange,
  onModeChange,
  onReset,
}: StandaloneCardProps) {
  const { t, locale } = useI18n();
  const modelT = (MODEL_TRANSLATIONS[locale] ?? MODEL_TRANSLATIONS["en"] ?? {})[model.id];
  const [activating, setActivating] = useState(false);
  const cost = modelCostLabel(model, allModelSettings[model.id] ?? {}, t);

  const handleActivate = async () => {
    setActivating(true);
    try {
      await onActivate(model.id);
    } finally {
      setActivating(false);
    }
  };

  return (
    <div className={`family-card${isActive ? " family-card--active" : ""}`}>
      <div className="family-card__header">
        <span className="family-card__name">{modelT?.name ?? model.name}</span>
        {isActive && <span className="family-card__badge">{t("imageSettings.active")}</span>}
      </div>
      {(modelT?.descriptionOverride ??
        model.descriptionOverride ??
        modelT?.description ??
        model.description) && (
        <p className="family-card__desc">
          {modelT?.descriptionOverride ??
            model.descriptionOverride ??
            modelT?.description ??
            model.description}
        </p>
      )}
      {model.modes && model.modes.length > 0 && (
        <div className="family-card__row">
          <span className="family-card__row-label">{t("modelModes.label")}</span>
          <div className="image-settings-ratios">
            {model.modes.map((m) => {
              const active = selectedModeId === m.id || (!selectedModeId && m.default);
              return (
                <button
                  key={m.id}
                  className={`ratio-btn${active ? " ratio-btn--active" : ""}`}
                  onClick={() => onModeChange?.(m.id)}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {model.settings.length > 0 && (
        <div className="family-card__row family-card__row--settings">
          <SettingsPanel
            settings={model.settings}
            values={allModelSettings[model.id] ?? {}}
            onChange={onSettingChange}
            modeId={selectedModeId ?? model.modes?.find((m) => m.default)?.id}
          />
        </div>
      )}
      <div className="family-card__btn-row">
        <button
          className="family-card__activate-btn"
          onClick={() => void handleActivate()}
          disabled={activating || isActive}
        >
          {activating
            ? t("imageSettings.activating")
            : isActive
              ? t("imageSettings.activated")
              : t("imageSettings.activate")}
        </button>
        {model.settings.length > 0 && (
          <button
            className="family-card__reset-btn"
            onClick={() => onReset(model.id)}
            title={t("imageSettings.resetTitle")}
          >
            {t("imageSettings.reset")}
          </button>
        )}
      </div>
      {isSelected && isInSectionPicker(model.section, activeState) && (
        <button
          className="family-card__start-btn"
          onClick={() => void handleActivate()}
          disabled={activating}
        >
          {activating ? t("imageSettings.activating") : t("imageSettings.startWork")}
        </button>
      )}
      {cost && <div className="family-card__cost">{cost}</div>}
      {cost && model.id.startsWith("gpt-image") && (
        <div className="family-card__cost-note">{t("manage.price.gptImageNote")}</div>
      )}
      {savedId === model.id && (
        <div className="model-settings-saved">{t("imageSettings.saved")}</div>
      )}
    </div>
  );
}
