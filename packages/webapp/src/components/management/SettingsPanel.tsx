import { useState } from "react";
import type { ModelSettingDef, UnavailableRule } from "../../types.js";
import { useI18n } from "../../i18n.js";
import { SETTING_TRANSLATIONS } from "@metabox/shared-browser";
import { StyledSelect } from "./StyledSelect.js";
import { CustomSlider } from "./CustomSlider.js";
import { HeyGenVoicePicker } from "./HeyGenVoicePicker.js";
import { DIDVoicePicker } from "./DIDVoicePicker.js";
import { ElevenLabsVoicePicker } from "./ElevenLabsVoicePicker.js";
import { CartesiaVoicePicker } from "./CartesiaVoicePicker.js";
import { OpenAIVoicePicker } from "./OpenAIVoicePicker.js";
import { HeyGenAvatarPicker } from "./HeyGenAvatarPicker.js";
import { HiggsFieldMotionPicker } from "./HiggsFieldMotionPicker.js";
import type { MotionEntry } from "./HiggsFieldMotionPicker.js";
import { HiggsFieldSoulPicker } from "./HiggsFieldSoulPicker.js";
import { SoulStylePicker } from "./SoulStylePicker.js";
import { AspectRatioWheel } from "./AspectRatioWheel.js";

function isPresent(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function evalRule(rule: UnavailableRule, vals: Record<string, unknown>): boolean {
  if ("and" in rule) return rule.and.every((r) => evalRule(r, vals));
  if ("or" in rule) return rule.or.some((r) => evalRule(r, vals));
  const v = vals[rule.key];
  if (rule.present !== undefined) return isPresent(v);
  if (rule.absent !== undefined) return !isPresent(v);
  if ("eq" in rule) return v === rule.eq;
  if ("neq" in rule) return v !== rule.neq;
  return false;
}

interface SettingsPanelProps {
  settings: ModelSettingDef[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  /**
   * Активный режим (id из ModelMode, например "t2v"/"i2v"/"r2v"). Если задан,
   * прокидывается в effectiveValues под synthetic-ключом `_mode` — это позволяет
   * `unavailableIf` правилам ссылаться на режим (например, скрыть/задизейблить
   * опции длительности в r2v режиме где провайдер фиксирует duration).
   */
  modeId?: string;
}

export function SettingsPanel({ settings, values, onChange, modeId }: SettingsPanelProps) {
  const { locale, t } = useI18n();
  const settingLocale = SETTING_TRANSLATIONS[locale] ?? SETTING_TRANSLATIONS["en"] ?? {};
  const [advancedOpen, setAdvancedOpen] = useState(false);

  if (!settings || settings.length === 0) return null;

  // Resolve effective values: fill in defaults for any setting not yet saved by the user.
  // This ensures unavailableIf conditions work correctly even before the user interacts.
  const effectiveValues: Record<string, unknown> = {};
  for (const def of settings) {
    effectiveValues[def.key] = values[def.key] !== undefined ? values[def.key] : def.default;
  }
  // Synthetic key `_mode` для unavailableIf-правил, зависящих от текущего режима.
  if (modeId !== undefined) {
    effectiveValues._mode = modeId;
  }

  const basicSettings = settings.filter((s) => !s.advanced);
  const advancedSettings = settings.filter((s) => s.advanced);

  // Batch-picker (num_images) визуально живёт ближе к кнопке генерации —
  // переносим его в конец basic-блока (прямо перед "Расширенные настройки"),
  // чтобы юзер сначала видел параметры самой генерации, а уже потом — сколько
  // экземпляров получить.
  const numImagesIdx = basicSettings.findIndex((s) => s.key === "num_images");
  if (numImagesIdx >= 0 && numImagesIdx < basicSettings.length - 1) {
    const [numImages] = basicSettings.splice(numImagesIdx, 1);
    basicSettings.push(numImages);
  }

  function renderSetting(def: ModelSettingDef) {
    if (def.unavailableIf && evalRule(def.unavailableIf, effectiveValues)) return null;
    const val = effectiveValues[def.key];
    const settingT = settingLocale[def.key];
    const label = settingT?.label ?? def.label;
    const description = settingT?.description ?? def.description;
    return (
      <div key={def.key} className="settings-panel__row">
        <span className="settings-panel__label">{label}</span>
        {description && <span className="settings-panel__desc">{description}</span>}
        {def.type === "select" &&
          (def.key === "aspect_ratio" ? (
            (() => {
              const visible = def
                .options!.filter(
                  (opt) => !(opt.unavailableIf && evalRule(opt.unavailableIf, effectiveValues)),
                )
                .map((opt) => ({
                  value: String(opt.value),
                  label: settingT?.options?.[String(opt.value)] ?? opt.label,
                }));
              const currentValue = String(val ?? def.default ?? visible[0]?.value ?? "");
              return (
                <AspectRatioWheel
                  options={visible}
                  value={currentValue}
                  onChange={(v) => onChange(def.key, v)}
                />
              );
            })()
          ) : (
            <div className="image-settings-ratios">
              {def.options!.map((opt) => {
                const optDisabled =
                  !!opt.unavailableIf && evalRule(opt.unavailableIf, effectiveValues);
                const optLabel = settingT?.options?.[String(opt.value)] ?? opt.label;
                return (
                  <button
                    key={String(opt.value)}
                    disabled={optDisabled}
                    className={`ratio-btn${val === opt.value ? " ratio-btn--active" : ""}${optDisabled ? " ratio-btn--disabled" : ""}`}
                    onClick={() => !optDisabled && onChange(def.key, opt.value)}
                  >
                    {optLabel}
                  </button>
                );
              })}
            </div>
          ))}
        {def.type === "dropdown" && (
          <StyledSelect
            value={String(val ?? def.default ?? "")}
            onChange={(v) => onChange(def.key, v)}
            options={def.options!.map((opt) => ({
              value: String(opt.value),
              label: settingT?.options?.[String(opt.value)] ?? opt.label,
              disabled: !!opt.unavailableIf && evalRule(opt.unavailableIf, effectiveValues),
            }))}
          />
        )}
        {def.type === "slider" && (
          <div className="settings-panel__slider-row">
            <CustomSlider
              min={def.min ?? 0}
              max={def.max ?? 100}
              step={def.step ?? 1}
              value={Number(val ?? def.min ?? 0)}
              onChange={(v) => onChange(def.key, v)}
            />
            <span className="settings-panel__slider-value">{Number(val ?? def.min ?? 0)}</span>
          </div>
        )}
        {def.type === "toggle" && (
          <div className="settings-panel__toggle-row">
            <label className="settings-panel__toggle-label">
              <input
                type="checkbox"
                checked={Boolean(val)}
                onChange={(e) => onChange(def.key, e.target.checked)}
              />
              <span className="settings-panel__toggle-track" />
            </label>
          </div>
        )}
        {def.type === "text" && (
          <textarea
            className="settings-panel__textarea"
            value={String(val ?? "")}
            rows={2}
            onChange={(e) => onChange(def.key, e.target.value)}
          />
        )}
        {def.type === "number" && (
          <input
            type="number"
            className="settings-panel__number"
            min={def.min}
            max={def.max}
            placeholder="auto"
            value={val !== null && val !== undefined ? String(val) : ""}
            onChange={(e) => onChange(def.key, e.target.value ? Number(e.target.value) : null)}
          />
        )}
        {def.type === "color" && (
          <div className="settings-panel__color-row">
            <input
              type="color"
              className="settings-panel__color-input"
              value={String(val ?? "#FFFFFF")}
              onChange={(e) => onChange(def.key, e.target.value)}
            />
            <span className="settings-panel__color-hex">{String(val ?? "#FFFFFF")}</span>
          </div>
        )}
        {def.type === "voice-picker" && (
          <HeyGenVoicePicker voiceId={String(values["voice_id"] ?? "")} onChange={onChange} />
        )}
        {def.type === "did-voice-picker" && (
          <DIDVoicePicker
            voiceId={String(values["voice_id"] ?? "")}
            voiceUrl={String(values["voice_url"] ?? "")}
            voiceS3Key={String(values["voice_s3key"] ?? "")}
            onChange={onChange}
          />
        )}
        {def.type === "elevenlabs-voice-picker" && (
          <ElevenLabsVoicePicker voiceId={String(values["voice_id"] ?? "")} onChange={onChange} />
        )}
        {def.type === "cartesia-voice-picker" && (
          <CartesiaVoicePicker voiceId={String(values["voice_id"] ?? "")} onChange={onChange} />
        )}
        {def.type === "openai-voice-picker" && (
          <OpenAIVoicePicker voice={String(val ?? "")} onChange={onChange} />
        )}
        {def.type === "avatar-picker" && (
          <HeyGenAvatarPicker
            avatarId={String(values["avatar_id"] ?? "")}
            imageAssetId={String(values["image_asset_id"] ?? "")}
            onChange={(changes) => Object.entries(changes).forEach(([k, v]) => onChange(k, v))}
          />
        )}
        {def.type === "motion-picker" && (
          <HiggsFieldMotionPicker
            value={(values[def.key] as MotionEntry[] | null) ?? []}
            onChange={(v) => onChange(def.key, v)}
          />
        )}
        {def.type === "soul-picker" && (
          <HiggsFieldSoulPicker
            soulId={String(values["custom_reference_id"] ?? "")}
            onChange={(changes) => Object.entries(changes).forEach(([k, v]) => onChange(k, v))}
          />
        )}
        {def.type === "soul-style-picker" && (
          <SoulStylePicker styleId={String(values["style_id"] ?? "")} onChange={onChange} />
        )}
      </div>
    );
  }

  return (
    <div className="settings-panel">
      {basicSettings.map(renderSetting)}
      {advancedSettings.length > 0 && (
        <div className="settings-panel__advanced">
          <button
            className="settings-panel__advanced-toggle"
            onClick={() => setAdvancedOpen((prev) => !prev)}
          >
            <span>{t("manage.advancedSettings")}</span>
            <span className={`settings-panel__advanced-arrow${advancedOpen ? " open" : ""}`}>
              ▼
            </span>
          </button>
          {advancedOpen && advancedSettings.map(renderSetting)}
        </div>
      )}
    </div>
  );
}
