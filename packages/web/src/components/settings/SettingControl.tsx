import clsx from "clsx";
import type { ModelSettingDto } from "@/api/models";

/**
 * Содержимое popover'а / inline-контрол для одной настройки.
 *
 * Рендерит фактический контрол под `setting.type`:
 *   color  → color picker + hex text
 *   slider → chip-row дискретных значений (на основе min/max/step)
 *   number → native <input type="number">
 *   text   → <input type="text">
 *   select / dropdown → chip-row вариантов
 *
 * Toggle обрабатывается снаружи (в GenerateScene.SettingChip / SettingsPanel),
 * потому что у тогглов нет popover'а — клик мгновенно меняет значение.
 */
export function SettingControl({
  setting,
  value,
  onChange,
}: {
  setting: ModelSettingDto;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (setting.type === "color") {
    const hex = typeof value === "string" && value ? value : String(setting.default ?? "#000000");
    return (
      <div className="gen-pop-body">
        {setting.description && <div className="gen-pop-desc">{setting.description}</div>}
        <div className="gen-color-row">
          <input
            type="color"
            className="gen-color-input"
            value={hex}
            onChange={(e) => onChange(e.target.value)}
          />
          <input
            type="text"
            className="gen-text gen-color-text"
            value={hex}
            onChange={(e) => onChange(e.target.value)}
            placeholder="#RRGGBB"
          />
        </div>
      </div>
    );
  }
  if (setting.type === "slider") {
    const min = setting.min ?? 0;
    const max = setting.max ?? 100;
    const step = setting.step ?? 1;
    const num = typeof value === "number" ? value : Number(setting.default ?? min);
    // Кол-во знаков после запятой берём из step'а — формат chip'а согласован
    // с тем, как UX выглядит для дробных шагов (0.05 → "0.10", "0.15").
    const stepStr = String(step);
    const dotIdx = stepStr.indexOf(".");
    const decimals = dotIdx >= 0 ? stepStr.length - dotIdx - 1 : 0;
    const values: number[] = [];
    // Накопление через i*step вместо v+=step: избегаем float-drift на длинных диапазонах.
    const count = Math.round((max - min) / step) + 1;
    for (let i = 0; i < count; i++) {
      const v = Number((min + i * step).toFixed(decimals));
      values.push(v);
    }
    return (
      <div className="gen-pop-body">
        {setting.description && <div className="gen-pop-desc">{setting.description}</div>}
        <div className="gen-pop-chips-row">
          {values.map((v) => {
            const active = Number(num.toFixed(decimals)) === v;
            return (
              <button
                key={v}
                type="button"
                className={clsx("gen-chip", active && "on")}
                onClick={() => onChange(v)}
              >
                {v}
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  if (setting.type === "number") {
    const num = typeof value === "number" ? value : Number(setting.default ?? 0);
    return (
      <div className="gen-pop-body">
        {setting.description && <div className="gen-pop-desc">{setting.description}</div>}
        <input
          type="number"
          min={setting.min}
          max={setting.max}
          step={setting.step}
          value={num}
          onChange={(e) => onChange(Number(e.target.value))}
          className="gen-num"
        />
      </div>
    );
  }
  if (setting.type === "text") {
    return (
      <div className="gen-pop-body">
        {setting.description && <div className="gen-pop-desc">{setting.description}</div>}
        <input
          type="text"
          value={typeof value === "string" ? value : String(setting.default ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className="gen-text"
        />
      </div>
    );
  }
  if (setting.type === "select" || setting.type === "dropdown") {
    const opts = setting.options ?? [];
    if (opts.length === 0) return null;
    return (
      <div className="gen-pop-body">
        {setting.description && <div className="gen-pop-desc">{setting.description}</div>}
        <div className="gen-pop-chips-row">
          {opts.map((o) => {
            const active = String(value ?? setting.default) === String(o.value);
            return (
              <button
                key={String(o.value)}
                type="button"
                className={clsx("gen-chip", active && "on")}
                onClick={() => onChange(o.value)}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  return null;
}
