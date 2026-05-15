import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import clsx from "clsx";
import type { ModelSettingDef } from "@metabox/shared-browser/dto";

type UnavailableRule =
  | {
      key: string;
      eq?: unknown;
      neq?: unknown;
      present?: true;
      absent?: true;
    }
  | { and: UnavailableRule[] }
  | { or: UnavailableRule[] };

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

const PICKER_TYPES = new Set([
  "voice-picker",
  "did-voice-picker",
  "elevenlabs-voice-picker",
  "openai-voice-picker",
  "cartesia-voice-picker",
  "avatar-picker",
  "motion-picker",
  "soul-picker",
  "soul-style-picker",
]);

interface Props {
  settings: ModelSettingDef[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

export function ModelSettingsPanel({ settings, values, onChange }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Auto-clamp stale slider values to current [min, max]. Только видимые слайдеры:
  // скрытые через dependsOn менять молча нельзя.
  useEffect(() => {
    if (!settings) return;
    const depVals: Record<string, unknown> = {};
    for (const def of settings) {
      depVals[def.key] = values[def.key] !== undefined ? values[def.key] : def.default;
    }
    for (const def of settings) {
      if (def.type !== "slider") continue;
      if (def.dependsOn && depVals[def.dependsOn.key] !== def.dependsOn.value) continue;
      const raw = values[def.key];
      if (raw === undefined || raw === null) continue;
      const num = Number(raw);
      if (!Number.isFinite(num)) continue;
      const min = def.min ?? 0;
      const max = def.max ?? Number.MAX_SAFE_INTEGER;
      const clamped = Math.max(min, Math.min(max, num));
      if (clamped !== num) onChange(def.key, clamped);
    }
  }, [settings, values, onChange]);

  if (!settings || settings.length === 0) {
    return (
      <div className="text-sm text-text-hint italic">
        У этой модели нет настраиваемых параметров.
      </div>
    );
  }

  const effectiveValues: Record<string, unknown> = {};
  for (const def of settings) {
    effectiveValues[def.key] = values[def.key] !== undefined ? values[def.key] : def.default;
  }

  const basicSettings = settings.filter((s) => !s.advanced);
  const advancedSettings = settings.filter((s) => s.advanced);

  function renderSetting(def: ModelSettingDef) {
    if (def.unavailableIf && evalRule(def.unavailableIf as UnavailableRule, effectiveValues)) {
      return null;
    }
    if (def.dependsOn && effectiveValues[def.dependsOn.key] !== def.dependsOn.value) {
      return null;
    }
    const val = effectiveValues[def.key];

    return (
      <div key={def.key} className="flex flex-col gap-1.5">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-text">{def.label}</span>
          {def.description && <span className="text-xs text-text-hint">{def.description}</span>}
        </div>

        {def.type === "select" &&
          (() => {
            const valueSet = new Set<unknown>(def.options!.map((o) => o.value));
            const activeValue = valueSet.has(val) ? val : (def.default ?? def.options![0]?.value);
            return (
              <div className="flex flex-wrap gap-1.5">
                {def.options!.map((opt) => {
                  const optDisabled =
                    !!opt.unavailableIf &&
                    evalRule(opt.unavailableIf as UnavailableRule, effectiveValues);
                  const active = activeValue === opt.value;
                  return (
                    <button
                      key={String(opt.value)}
                      type="button"
                      disabled={optDisabled}
                      onClick={() => onChange(def.key, opt.value)}
                      className={clsx(
                        "px-3 py-1.5 rounded text-sm border transition-colors",
                        active
                          ? "bg-accent text-white border-accent"
                          : "bg-bg-elev border-border-default text-text hover:border-accent",
                        optDisabled && "opacity-40 cursor-not-allowed",
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            );
          })()}

        {def.type === "dropdown" &&
          (() => {
            const optionValues = def.options!.map((o) => String(o.value));
            const rawValue = String(val ?? def.default ?? "");
            const currentValue = optionValues.includes(rawValue)
              ? rawValue
              : String(def.default ?? optionValues[0] ?? "");
            const findOpt = (sv: string) =>
              def.options!.find((o) => String(o.value) === sv)?.value ?? sv;
            return (
              <select
                className="input"
                value={currentValue}
                onChange={(e) => onChange(def.key, findOpt(e.target.value))}
              >
                {def.options!.map((opt) => {
                  const optDisabled =
                    !!opt.unavailableIf &&
                    evalRule(opt.unavailableIf as UnavailableRule, effectiveValues);
                  return (
                    <option
                      key={String(opt.value)}
                      value={String(opt.value)}
                      disabled={optDisabled}
                    >
                      {opt.label}
                    </option>
                  );
                })}
              </select>
            );
          })()}

        {def.type === "slider" &&
          (() => {
            const min = def.min ?? 0;
            const max = def.max ?? 100;
            const rawVal = Number(val ?? def.default ?? min);
            const clamped = Math.max(min, Math.min(max, rawVal));
            return (
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={def.step ?? 1}
                  value={clamped}
                  onChange={(e) => onChange(def.key, Number(e.target.value))}
                  className="flex-1 accent-accent"
                />
                <span className="min-w-[3rem] text-right text-sm font-mono text-text-secondary">
                  {clamped}
                </span>
              </div>
            );
          })()}

        {def.type === "toggle" && (
          <label className="inline-flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={Boolean(val)}
              onChange={(e) => onChange(def.key, e.target.checked)}
              className="w-4 h-4 accent-accent"
            />
            <span className="text-sm text-text-secondary">
              {Boolean(val) ? "включено" : "выключено"}
            </span>
          </label>
        )}

        {def.type === "text" && (
          <textarea
            className="input min-h-[80px] py-2"
            value={String(val ?? "")}
            rows={2}
            onChange={(e) => onChange(def.key, e.target.value)}
          />
        )}

        {def.type === "number" && (
          <input
            type="number"
            className="input"
            min={def.min}
            max={def.max}
            placeholder="auto"
            value={val !== null && val !== undefined ? String(val) : ""}
            onChange={(e) => onChange(def.key, e.target.value ? Number(e.target.value) : null)}
          />
        )}

        {def.type === "color" && (
          <div className="flex items-center gap-3">
            <input
              type="color"
              className="h-9 w-12 rounded bg-transparent border border-border-default cursor-pointer"
              value={String(val ?? "#FFFFFF")}
              onChange={(e) => onChange(def.key, e.target.value)}
            />
            <span className="font-mono text-sm text-text-secondary">
              {String(val ?? "#FFFFFF")}
            </span>
          </div>
        )}

        {PICKER_TYPES.has(def.type) && (
          <div className="rounded border border-dashed border-border-default bg-bg-elev px-3 py-2 text-xs text-text-hint">
            Тип «{def.type}» пока не редактируется в админке. Текущее значение:{" "}
            <span className="font-mono">{JSON.stringify(val ?? null)}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {basicSettings.map(renderSetting)}
      {advancedSettings.length > 0 && (
        <div className="border-t border-border-default pt-3">
          <button
            type="button"
            className="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            <ChevronDown
              size={16}
              className={clsx("transition-transform", advancedOpen && "rotate-180")}
            />
            Расширенные настройки
          </button>
          {advancedOpen && (
            <div className="flex flex-col gap-4 mt-3">{advancedSettings.map(renderSetting)}</div>
          )}
        </div>
      )}
    </div>
  );
}
