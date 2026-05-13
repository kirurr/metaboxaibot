import { useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";

/**
 * Универсальная заглушка под страницы Image/Video/Audio. Слева — панель
 * параметров (модель + произвольные dimension'ы + промпт + CTA), справа —
 * пустой превью-стейт. Реальной генерации пока нет: «Generate» включает
 * spinner на пару секунд и оставляет превью пустым.
 */

export type GenDimension = {
  /** Уникальный ключ — пока используется только для React `key`. */
  key: string;
  /** Лейбл секции, например «Aspect ratio» или «Voice». */
  label: string;
  /** Список взаимоисключающих вариантов (chips). */
  options: readonly string[];
  /** Стартовый выбранный вариант. */
  defaultValue: string;
};

type Model = { id: string; name: string };

export type GeneratePanelProps = {
  title: string;
  subtitle: string;
  models: readonly Model[];
  dimensions?: readonly GenDimension[];
  /** Подсказка под input prompt'а. */
  promptPlaceholder: string;
  /** Иконка для пустого превью-стейта (по умолчанию Sparkles). */
  previewIcon?: ReactNode;
  /** Заголовок и текст превью-стейта. */
  previewTitle: string;
  previewText: string;
};

export function GeneratePanel({
  title,
  subtitle,
  models,
  dimensions = [],
  promptPlaceholder,
  previewIcon,
  previewTitle,
  previewText,
}: GeneratePanelProps) {
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const [dimValues, setDimValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(dimensions.map((d) => [d.key, d.defaultValue])),
  );
  const [busy, setBusy] = useState(false);

  function generate() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    // Заглушка: имитация запроса, без реального вызова бэка.
    setTimeout(() => setBusy(false), 1600);
  }

  return (
    <div className="gen-page anim-page-in">
      <aside className="gen-panel">
        <div className="gen-panel-head">
          <div>
            <h2>{title}</h2>
            <div className="gen-sub">{subtitle}</div>
          </div>
        </div>

        <div className="gen-field">
          <span className="gen-field-label">Prompt</span>
          <textarea
            className="gen-prompt"
            placeholder={promptPlaceholder}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <div className="gen-field">
          <span className="gen-field-label">Model</span>
          <select
            className="gen-select"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>

        {dimensions.map((d) => (
          <div key={d.key} className="gen-field">
            <span className="gen-field-label">{d.label}</span>
            <div className="gen-chips">
              {d.options.map((opt) => (
                <button
                  key={opt}
                  className={"gen-chip" + (dimValues[d.key] === opt ? " on" : "")}
                  onClick={() => setDimValues((prev) => ({ ...prev, [d.key]: opt }))}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        ))}

        <button className="gen-cta" disabled={!prompt.trim() || busy} onClick={generate}>
          <Sparkles size={16} />
          {busy ? "Generating…" : "Generate"}
        </button>
      </aside>

      <section className="gen-preview">
        <div className="gen-preview-empty">
          <div className="gpe-icon">{previewIcon ?? <Sparkles size={28} />}</div>
          <h3>{previewTitle}</h3>
          <p>{previewText}</p>
        </div>
      </section>
    </div>
  );
}
