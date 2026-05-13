import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";

/**
 * Универсальная заглушка под страницы Image/Video/Audio. Слева — панель
 * параметров (модель + произвольные dimension'ы + промпт + CTA), справа —
 * пустой превью-стейт. Реальной генерации пока нет: «Generate» включает
 * spinner на пару секунд и оставляет превью пустым.
 *
 * `dimensions` может быть как статическим массивом, так и функцией от выбранной
 * модели — нужно для Image/Video, где набор aspect ratios зависит от модели.
 */

export type GenDimension = {
  /** Уникальный ключ — используется и для React `key`, и как ключ в `dimValues`. */
  key: string;
  /** Лейбл секции, например «Aspect ratio» или «Voice». */
  label: string;
  /** Список взаимоисключающих вариантов (chips). */
  options: readonly string[];
  /** Стартовый выбранный вариант. */
  defaultValue: string;
};

export type GenModel = {
  id: string;
  /** Отображаемое имя (для family-моделей — familyName, иначе name). */
  name: string;
  /** Опц. краткое описание под именем в подсказке. */
  description?: string;
};

export type GeneratePanelProps = {
  title: string;
  subtitle: string;
  models: readonly GenModel[];
  /** Статичный набор параметров; либо функция от текущей модели. */
  dimensions?: readonly GenDimension[] | ((selectedModelId: string) => readonly GenDimension[]);
  /** Подсказка под input prompt'а. */
  promptPlaceholder: string;
  /** Иконка для пустого превью-стейта (по умолчанию Sparkles). */
  previewIcon?: ReactNode;
  /** Заголовок и текст превью-стейта. */
  previewTitle: string;
  previewText: string;
  /** Сообщение в селекте при пустом списке (каталог ещё грузится). */
  emptyModelsLabel?: string;
};

export function GeneratePanel({
  title,
  subtitle,
  models,
  dimensions,
  promptPlaceholder,
  previewIcon,
  previewTitle,
  previewText,
  emptyModelsLabel = "Загрузка моделей…",
}: GeneratePanelProps) {
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState<string>(models[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  // Когда каталог приехал/обновился — выставляем дефолтную модель, если ещё не выбрана.
  useEffect(() => {
    if (!modelId && models.length > 0) setModelId(models[0].id);
  }, [models, modelId]);

  const resolvedDims: readonly GenDimension[] = useMemo(() => {
    if (!dimensions) return [];
    return typeof dimensions === "function" ? dimensions(modelId) : dimensions;
  }, [dimensions, modelId]);

  const [dimValues, setDimValues] = useState<Record<string, string>>({});

  // Реконсилируем dimValues при смене набора параметров — если опция
  // больше не валидна (например, новая модель поддерживает другие aspect ratios),
  // откатываемся на defaultValue.
  useEffect(() => {
    setDimValues((prev) => {
      const next: Record<string, string> = {};
      for (const d of resolvedDims) {
        const current = prev[d.key];
        next[d.key] = current && d.options.includes(current) ? current : d.defaultValue;
      }
      return next;
    });
  }, [resolvedDims]);

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
          {models.length === 0 ? (
            <div className="gen-select" style={{ color: "var(--text-hint)" }}>
              {emptyModelsLabel}
            </div>
          ) : (
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
          )}
        </div>

        {resolvedDims.map((d) => (
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

        <button
          className="gen-cta"
          disabled={!prompt.trim() || busy || !modelId}
          onClick={generate}
        >
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
