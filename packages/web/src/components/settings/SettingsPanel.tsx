import { useMemo, useState } from "react";
import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import type { ModelSettingDto } from "@/api/models";
import { SettingControl } from "./SettingControl";
import { isSettingVisible, UNSUPPORTED_TYPES } from "./utils";

/**
 * Вертикальная панель настроек модели — лейбл/описание над инлайн-контролом.
 * Соответствует визуальной структуре webapp-аналога
 * (packages/webapp/src/components/management/SettingsPanel.tsx) с разбиением на
 * "Основные" и "Дополнительно" (collapsible).
 *
 * Toggle рендерим инлайн как switch (без popover'а — клик переключает сразу),
 * остальные типы делегируем в общий `SettingControl` (тот же, что использует
 * GenerateScene в popover'е чипов).
 */
export function SettingsPanel({
  settings,
  values,
  onChange,
  advancedLabel,
}: {
  settings: readonly ModelSettingDto[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  /** i18n-строка для тоггла "Дополнительные настройки". */
  advancedLabel: string;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Видимые настройки = поддерживаемые + удовлетворяющие dependsOn.
  const visible = useMemo(
    () => settings.filter((s) => !UNSUPPORTED_TYPES.has(s.type) && isSettingVisible(s, values)),
    [settings, values],
  );
  const basic = visible.filter((s) => !s.advanced);
  const advanced = visible.filter((s) => s.advanced);

  if (visible.length === 0) {
    return null;
  }

  return (
    <div className="settings-panel">
      {basic.map((s) => (
        <SettingsRow key={s.key} setting={s} value={values[s.key]} onChange={onChange} />
      ))}
      {advanced.length > 0 && (
        <div className="settings-panel-advanced">
          <button
            type="button"
            className={clsx("settings-panel-advanced-toggle", advancedOpen && "open")}
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            <ChevronDown size={14} className="settings-panel-advanced-arrow" />
            <span>{advancedLabel}</span>
          </button>
          {advancedOpen &&
            advanced.map((s) => (
              <SettingsRow key={s.key} setting={s} value={values[s.key]} onChange={onChange} />
            ))}
        </div>
      )}
    </div>
  );
}

function SettingsRow({
  setting,
  value,
  onChange,
}: {
  setting: ModelSettingDto;
  value: unknown;
  onChange: (key: string, value: unknown) => void;
}) {
  // Toggle — инлайн switch без popover'а.
  if (setting.type === "toggle") {
    const checked = Boolean(value);
    return (
      <div className="settings-panel-row">
        <div className="settings-panel-row-head">
          <button
            type="button"
            role="switch"
            aria-checked={checked}
            className={clsx("settings-panel-toggle", checked && "on")}
            onClick={() => onChange(setting.key, !checked)}
            title={setting.label}
          >
            <span className="settings-panel-toggle-track">
              <span className="settings-panel-toggle-thumb" />
            </span>
          </button>
          <span className="settings-panel-label">{setting.label}</span>
        </div>
        {setting.description && <div className="settings-panel-desc">{setting.description}</div>}
      </div>
    );
  }

  // Text — рендерим textarea, потому что в этой панели чаще всего лежит
  // system_prompt (многострочный). У SettingControl text-тип это single-line
  // input — там он живёт внутри popover'а чипа и компактнее.
  if (setting.type === "text") {
    const text = typeof value === "string" ? value : String(setting.default ?? "");
    return (
      <div className="settings-panel-row">
        <span className="settings-panel-label">{setting.label}</span>
        {setting.description && <div className="settings-panel-desc">{setting.description}</div>}
        <textarea
          className="settings-panel-textarea"
          value={text}
          onChange={(e) => onChange(setting.key, e.target.value)}
          rows={4}
        />
      </div>
    );
  }

  return (
    <div className="settings-panel-row">
      <span className="settings-panel-label">{setting.label}</span>
      <SettingControl setting={setting} value={value} onChange={(v) => onChange(setting.key, v)} />
    </div>
  );
}
