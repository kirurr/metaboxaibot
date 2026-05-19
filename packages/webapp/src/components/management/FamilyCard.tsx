// ── FamilyCard ────────────────────────────────────────────────────────────────

import { MODEL_TRANSLATIONS } from "@metabox/shared-browser";
import { useState, useEffect } from "react";
import { useI18n } from "../../i18n";
import type { Model } from "../../types";
import { SettingsPanel } from "./SettingsPanel";
import {
  isActiveSection,
  isInSectionPicker,
  modelCostLabel,
} from "../../utils/mediaSettingsViewHelpers";

interface FamilyCardProps {
  members: Model[];
  activeModelId: string;
  activeState?: string;
  savedId: string | null;
  allModelSettings: Record<string, Record<string, unknown>>;
  selectedModes?: Record<string, string>;
  onModelActivate: (modelId: string) => Promise<void>;
  /**
   * Silent select при клике по версии/варианту в карусели — сохраняет
   * выбранный modelId в БД без перевода state бота и без notification.
   * Если не передан — клики только меняют локальное выделение (legacy).
   */
  onModelSelect?: (modelId: string) => void;
  /**
   * True пока pending silent-select notification ещё не fired (debounce
   * крутится). Кнопка «Активировать» остаётся кликабельной даже при
   * isGloballyActive — иначе после тапа по чипу аффорданс «применить и
   * закрыть» исчезает (кнопка disabled с надписью «Активирована»).
   */
  hasPendingSelect?: boolean;
  onSettingChange: (modelId: string, key: string, value: unknown) => void;
  onModeChange?: (modelId: string, modeId: string) => void;
  onReset: (modelId: string) => void;
}

export function FamilyCard({
  members,
  activeModelId,
  activeState,
  savedId,
  allModelSettings,
  selectedModes,
  onModelActivate,
  onModelSelect,
  hasPendingSelect,
  onSettingChange,
  onModeChange,
  onReset,
}: FamilyCardProps) {
  const { t, locale } = useI18n();
  const modelLocale = MODEL_TRANSLATIONS[locale] ?? MODEL_TRANSLATIONS["en"] ?? {};

  const belongsHere = activeModelId !== "" && members.some((m) => m.id === activeModelId);
  // Default selection: active model if it belongs here, else familyDefaultModelId, else first member
  const familyDefaultId = members[0]?.familyDefaultModelId ?? null;
  const defaultMember =
    (familyDefaultId ? members.find((m) => m.id === familyDefaultId) : null) ?? members[0];
  const [localId, setLocalId] = useState<string>(
    belongsHere ? activeModelId : (defaultMember?.id ?? ""),
  );

  useEffect(() => {
    if (activeModelId !== "" && members.some((m) => m.id === activeModelId)) {
      setLocalId(activeModelId);
    } else {
      setLocalId(defaultMember?.id ?? "");
    }
  }, [activeModelId, members, defaultMember]);

  const selected = members.find((m) => m.id === localId) ?? defaultMember;
  if (!selected) return null;

  const isGloballyActive =
    activeModelId === localId && isActiveSection(selected.section, activeState);

  const versions = [...new Set(members.map((m) => m.versionLabel).filter(Boolean))] as string[];
  const currentVersion = selected.versionLabel ?? null;

  const variantsForVersion = currentVersion
    ? members.filter((m) => m.versionLabel === currentVersion)
    : members;
  const hasVariants = variantsForVersion.length > 1;

  const [activating, setActivating] = useState(false);

  const selectVersion = (version: string) => {
    const sameVariant = members.find(
      (m) => m.versionLabel === version && m.variantLabel === selected.variantLabel,
    );
    const fallback = members.find((m) => m.versionLabel === version);
    const target = sameVariant ?? fallback;
    if (target) {
      setLocalId(target.id);
      onModelSelect?.(target.id);
    }
  };

  const selectVariant = (modelId: string) => {
    setLocalId(modelId);
    onModelSelect?.(modelId);
  };

  const handleActivate = async () => {
    setActivating(true);
    try {
      await onModelActivate(localId);
    } finally {
      setActivating(false);
    }
  };

  const modelT = modelLocale[selected.id];
  const description =
    modelT?.descriptionOverride ??
    selected.descriptionOverride ??
    modelT?.description ??
    selected.description;
  const currentValues = allModelSettings[selected.id] ?? {};
  const cost = modelCostLabel(selected, currentValues, t);
  const nameLabel = selected.name;

  return (
    <div className={`family-card${isGloballyActive ? " family-card--active" : ""}`}>
      <div className="family-card__header">
        <span className="family-card__name">{nameLabel}</span>
        {isGloballyActive && (
          <span className="family-card__badge">{t("imageSettings.active")}</span>
        )}
      </div>

      {description && <p className="family-card__desc">{description}</p>}

      {versions.length > 1 && (
        <div className="family-card__row">
          <span className="family-card__row-label">{t("imageSettings.version")}</span>
          <div className="image-settings-ratios">
            {versions.map((v) => (
              <button
                key={v}
                className={`ratio-btn${currentVersion === v ? " ratio-btn--active" : ""}`}
                onClick={() => selectVersion(v)}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      )}

      {hasVariants && (
        <div className="family-card__row">
          <span className="family-card__row-label">{t("imageSettings.variant")}</span>
          <div className="image-settings-ratios">
            {variantsForVersion.map((m) => (
              <button
                key={m.id}
                className={`ratio-btn${localId === m.id ? " ratio-btn--active" : ""}${m.variantLabel?.toLowerCase().includes("vector") ? " ratio-btn--svg" : ""}`}
                onClick={() => selectVariant(m.id)}
              >
                {m.variantLabel}
                {m.variantLabel?.toLowerCase().includes("vector") && " 📐"}
              </button>
            ))}
          </div>
        </div>
      )}

      {selected.modes && selected.modes.length > 0 && (
        <div className="family-card__row">
          <span className="family-card__row-label">{t("modelModes.label")}</span>
          <div className="image-settings-ratios">
            {selected.modes.map((m) => {
              const savedMode = selectedModes?.[selected.id];
              const active = savedMode === m.id || (!savedMode && m.default);
              return (
                <button
                  key={m.id}
                  className={`ratio-btn${active ? " ratio-btn--active" : ""}`}
                  onClick={() => onModeChange?.(selected.id, m.id)}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {selected.settings.length > 0 && (
        <div className="family-card__row family-card__row--settings">
          <SettingsPanel
            settings={selected.settings}
            values={allModelSettings[selected.id] ?? {}}
            onChange={(key, val) => onSettingChange(selected.id, key, val)}
            modeId={selectedModes?.[selected.id] ?? selected.modes?.find((m) => m.default)?.id}
          />
        </div>
      )}

      <div className="family-card__btn-row">
        <button
          className="family-card__activate-btn"
          onClick={() => void handleActivate()}
          disabled={activating || (isGloballyActive && !hasPendingSelect)}
        >
          {activating
            ? t("imageSettings.activating")
            : isGloballyActive && !hasPendingSelect
              ? t("imageSettings.activated")
              : t("imageSettings.activate")}
        </button>
        {selected.settings.length > 0 && (
          <button
            className="family-card__reset-btn"
            onClick={() => onReset(selected.id)}
            title={t("imageSettings.resetTitle")}
          >
            {t("imageSettings.reset")}
          </button>
        )}
      </div>

      {activeModelId === localId && isInSectionPicker(selected.section, activeState) && (
        <button
          className="family-card__start-btn"
          onClick={() => void handleActivate()}
          disabled={activating}
        >
          {activating ? t("imageSettings.activating") : t("imageSettings.startWork")}
        </button>
      )}

      {cost && <div className="family-card__cost">{cost}</div>}
      {cost && selected.id.startsWith("gpt-image") && (
        <div className="family-card__cost-note">{t("manage.price.gptImageNote")}</div>
      )}
      {savedId === selected.id && (
        <div className="model-settings-saved">{t("imageSettings.saved")}</div>
      )}
    </div>
  );
}
