import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { WebModelDto } from "@/api/models";

/**
 * Сцена-генерации: full-bleed «дрифтящий» фон + парящие geometric-плитки + центр-
 * hero + bottom dock с промптом, чипами параметров и большой Generate-кнопкой.
 *
 * Дизайн: `aibox_template/ai-box.html`, `PageImage`. Используется одним и тем
 * же компонентом для Image и Video — отличаются только текст hero, набор чипов
 * и пресеты aspect/duration.
 *
 * Реальная генерация ещё не подключена; CTA имитирует loading на пару секунд.
 */

type AspectChip = {
  type: "aspect";
  /** Полный список aspect ratios, через которые крутит revolver. */
  options: readonly string[];
  /** Стартовое значение. */
  defaultValue: string;
};

type ListChip = {
  type: "list";
  key: string;
  /** Что показывать на самой плитке-чипе слева от названия. */
  icon?: ReactNode;
  /** Заголовок popover'а — «Качество», «Длительность», «Голос» и т.д. */
  popTitle: string;
  options: readonly { value: string; label: string; desc?: string }[];
  defaultValue: string;
};

export type SceneChip = AspectChip | ListChip;

export type GenerateSceneProps = {
  /** «AI Image · 5 моделей» — eyebrow chip над h1. */
  eyebrow: string;
  /** Главный h1 («Создать кадр.» / «Создать видео.»). */
  title: string;
  /** Подзаголовок. */
  subtitle: string;
  /** Промпт-плейсхолдер в dock'е. */
  promptPlaceholder: string;
  /** Список моделей для popover'а — реальные данные из `useModelsStore`. */
  models: readonly WebModelDto[];
  /** Чипы между моделью и stepper'ом — aspect / quality / duration / voice / ... */
  chips: readonly SceneChip[];
  /** Если задано, в баре есть stepper «count/max». */
  count?: { value: number; max: number; onChange: (n: number) => void };
  /** URL'ы для bg-сетки (gradient strings или image urls). */
  bgTiles: readonly string[];
  /** URL'ы картинок для парящих hero-плиток. Пустой массив — отключить. */
  heroImages: readonly string[];
};

// Имя в чипе/popover'е: для family-моделей — familyName, иначе name.
function modelDisplayName(m: WebModelDto): string {
  return m.familyName ?? m.name;
}
function modelLetter(m: WebModelDto): string {
  return modelDisplayName(m).trim().slice(0, 1).toUpperCase() || "·";
}
function modelDesc(m: WebModelDto): string {
  return m.descriptionOverride ?? m.description;
}

// Парсим "16:9" → [16, 9]; "Auto" обрабатываем как 3:4-превью.
function parseRatio(r: string): [number, number] {
  if (r === "Auto") return [3, 4];
  const [w, h] = r.split(":").map(Number);
  return [Number.isFinite(w) ? w : 3, Number.isFinite(h) ? h : 4];
}

export function GenerateScene({
  eyebrow,
  title,
  subtitle,
  promptPlaceholder,
  models,
  chips,
  count,
  bgTiles,
  heroImages,
}: GenerateSceneProps) {
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState<string>(models[0]?.id ?? "");
  const [chipValues, setChipValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      chips.map((c) => [chipKey(c), c.type === "aspect" ? c.defaultValue : c.defaultValue]),
    ),
  );
  const [openPop, setOpenPop] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Когда каталог приехал — выставляем дефолтную модель, если ещё не выбрана.
  useEffect(() => {
    if (!modelId && models.length > 0) setModelId(models[0].id);
  }, [models, modelId]);

  // Реконсилируем chipValues при смене chips (например aspect-options поменялись с
  // моделью). Если текущее значение больше не валидно — откатываемся на default.
  useEffect(() => {
    setChipValues((prev) => {
      const next: Record<string, string> = {};
      for (const c of chips) {
        const k = chipKey(c);
        const current = prev[k];
        const valid =
          c.type === "aspect"
            ? c.options.includes(current)
            : c.options.some((o) => o.value === current);
        next[k] = valid ? current : c.defaultValue;
      }
      return next;
    });
  }, [chips]);

  // Outside-click для попапов. Внутрь bar'а клики не закрывают (textarea и т.д.
  // должны фокусироваться без побочки).
  useEffect(() => {
    if (!openPop) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenPop(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openPop]);

  const selectedModel = useMemo(
    () => models.find((m) => m.id === modelId) ?? models[0],
    [models, modelId],
  );

  function generate() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setTimeout(() => setBusy(false), 1600);
  }

  return (
    <div className="img-page" data-screen-label="generate">
      <div className="img-bg">
        <div className="img-bg-grid">
          {bgTiles.map((bg, i) => (
            <div
              key={i}
              className={"img-bg-tile s" + (i % 4)}
              style={{ background: bg }}
              aria-hidden
            />
          ))}
        </div>
        <div className="img-bg-veil" />
      </div>
      <div className="img-foreground">
        {heroImages.length > 0 && <HeroShapes images={heroImages} />}
        <div className="img-hero">
          <div className="eyebrow">
            <span className="live-dot" /> {eyebrow}
          </div>
          <div className="img-h1-wrap">
            <h1 className="img-h1">{title}</h1>
          </div>
          <p className="img-sub">{subtitle}</p>
        </div>
      </div>

      <div className="hf-dock">
        <div className="hf-bar" ref={barRef}>
          <div className="hf-main">
            <div className="hf-prompt-row">
              <button className="hf-plus" aria-label="Attach">
                +
              </button>
              <textarea
                ref={taRef}
                className="hf-prompt"
                placeholder={promptPlaceholder}
                value={prompt}
                rows={1}
                onChange={(e) => setPrompt(e.target.value)}
                onInput={(e) => {
                  const ta = e.currentTarget;
                  ta.style.height = "auto";
                  ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
                }}
              />
            </div>
            <div className="hf-chips">
              {/* Модель — всегда первый чип. */}
              <div className="hf-pop-wrap">
                <button
                  className={"hf-chip hf-chip-model" + (openPop === "model" ? " hf-chip-on" : "")}
                  onClick={() => setOpenPop(openPop === "model" ? null : "model")}
                  disabled={models.length === 0}
                >
                  <span className="hf-chip-glyph">
                    {selectedModel ? modelLetter(selectedModel) : "·"}
                  </span>
                  <span className="hf-chip-name">
                    {selectedModel ? modelDisplayName(selectedModel) : "Загрузка…"}
                  </span>
                  <span className="hf-chev">›</span>
                </button>
                {openPop === "model" && (
                  <div className="hf-pop hf-pop-model">
                    <div className="hf-pop-title">Модель</div>
                    <div className="hf-pop-list">
                      {models.map((m) => (
                        <button
                          key={m.id}
                          className={"hf-pop-item" + (m.id === modelId ? " on" : "")}
                          onClick={() => {
                            setModelId(m.id);
                            setOpenPop(null);
                          }}
                        >
                          <span className="hf-pop-glyph">{modelLetter(m)}</span>
                          <div className="hf-pop-item-body">
                            <div className="hf-pop-item-name">{modelDisplayName(m)}</div>
                            <div className="hf-pop-item-desc">{modelDesc(m)}</div>
                          </div>
                          {m.id === modelId && <span className="hf-pop-check">✓</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {chips.map((chip) => {
                const k = chipKey(chip);
                const value = chipValues[k];
                const isOpen = openPop === k;
                if (chip.type === "aspect") {
                  return (
                    <AspectChipUI
                      key={k}
                      chip={chip}
                      value={value}
                      isOpen={isOpen}
                      onToggle={() => setOpenPop(isOpen ? null : k)}
                      onChange={(v) => setChipValues((p) => ({ ...p, [k]: v }))}
                    />
                  );
                }
                return (
                  <ListChipUI
                    key={k}
                    chip={chip}
                    value={value}
                    isOpen={isOpen}
                    onToggle={() => setOpenPop(isOpen ? null : k)}
                    onChange={(v) => {
                      setChipValues((p) => ({ ...p, [k]: v }));
                      setOpenPop(null);
                    }}
                  />
                );
              })}

              {count && (
                <div className="hf-chip hf-stepper">
                  <button
                    className="hf-step"
                    onClick={() => count.onChange(Math.max(1, count.value - 1))}
                  >
                    −
                  </button>
                  <span className="hf-step-val">
                    {count.value}/{count.max}
                  </span>
                  <button
                    className="hf-step"
                    onClick={() => count.onChange(Math.min(count.max, count.value + 1))}
                  >
                    +
                  </button>
                </div>
              )}
            </div>
          </div>

          <button className="hf-generate" disabled={!prompt.trim() || busy} onClick={generate}>
            <span className="hf-gen-glow" />
            <span className="hf-gen-inner">
              <span>{busy ? "Generating…" : "Generate"}</span>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6z" />
              </svg>
              {count && <span className="hf-gen-n">{count.value}</span>}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function chipKey(c: SceneChip): string {
  return c.type === "aspect" ? "aspect" : c.key;
}

function AspectChipUI({
  chip,
  value,
  isOpen,
  onToggle,
  onChange,
}: {
  chip: AspectChip;
  value: string;
  isOpen: boolean;
  onToggle: () => void;
  onChange: (v: string) => void;
}) {
  const idx = chip.options.indexOf(value);
  const safeIdx = idx < 0 ? 0 : idx;
  const adjacent = (offset: number) => {
    const n = chip.options.length;
    return chip.options[(safeIdx + offset + n) % n];
  };
  const [pw, ph] = parseRatio(value);
  const previewW = pw >= ph ? 120 : 120 * (pw / ph);
  const previewH = pw >= ph ? 120 * (ph / pw) : 120;

  return (
    <div className="hf-pop-wrap">
      <button className={"hf-chip" + (isOpen ? " hf-chip-on" : "")} onClick={onToggle}>
        <span className="hf-chip-icon">▭</span>
        <span>{value}</span>
      </button>
      {isOpen && (
        <div className="hf-pop hf-pop-revolver">
          <div className="hf-pop-title">Aspect ratio</div>
          <div className="hf-revolver">
            <div className="hf-rev-preview">
              <div className="hf-rev-box" style={{ width: previewW, height: previewH }} />
              <div className="hf-rev-label">{value}</div>
            </div>
            <div className="hf-rev-wheel">
              <button
                className="hf-rev-arrow"
                onClick={() => onChange(adjacent(-1))}
                aria-label="prev"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="6 15 12 9 18 15" />
                </svg>
              </button>
              <button className="hf-rev-opt" onClick={() => onChange(adjacent(-2))}>
                {adjacent(-2)}
              </button>
              <button className="hf-rev-opt" onClick={() => onChange(adjacent(-1))}>
                {adjacent(-1)}
              </button>
              <div className="hf-rev-opt hf-rev-current">{value}</div>
              <button className="hf-rev-opt" onClick={() => onChange(adjacent(1))}>
                {adjacent(1)}
              </button>
              <button className="hf-rev-opt" onClick={() => onChange(adjacent(2))}>
                {adjacent(2)}
              </button>
              <button
                className="hf-rev-arrow"
                onClick={() => onChange(adjacent(1))}
                aria-label="next"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ListChipUI({
  chip,
  value,
  isOpen,
  onToggle,
  onChange,
}: {
  chip: ListChip;
  value: string;
  isOpen: boolean;
  onToggle: () => void;
  onChange: (v: string) => void;
}) {
  const current = chip.options.find((o) => o.value === value);
  return (
    <div className="hf-pop-wrap">
      <button className={"hf-chip" + (isOpen ? " hf-chip-on" : "")} onClick={onToggle}>
        {chip.icon ? <span className="hf-chip-icon">{chip.icon}</span> : null}
        <span>{current?.label ?? value}</span>
      </button>
      {isOpen && (
        <div className="hf-pop">
          <div className="hf-pop-title">{chip.popTitle}</div>
          <div className="hf-pop-list">
            {chip.options.map((o) => (
              <button
                key={o.value}
                className={"hf-pop-item hf-pop-item-row" + (o.value === value ? " on" : "")}
                onClick={() => onChange(o.value)}
              >
                <span className="hf-pop-item-name">{o.label}</span>
                {o.desc && <span className="hf-pop-item-desc">{o.desc}</span>}
                {o.value === value && <span className="hf-pop-check">✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Парящие плитки вокруг hero — рандомные позиции / размеры / поворот один раз на mount. */
function HeroShapes({ images }: { images: readonly string[] }) {
  const shapes = useMemo(() => {
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const pick = () => images[Math.floor(Math.random() * images.length)];
    const zones: CSSProperties[] = [
      { left: rand(-8, 4) + "%", top: rand(6, 22) + "%" },
      { right: rand(-6, 4) + "%", top: rand(48, 68) + "%" },
      { left: rand(2, 14) + "%", bottom: rand(4, 16) + "%" },
      { right: rand(10, 22) + "%", top: rand(4, 16) + "%" },
      { left: rand(18, 32) + "%", top: rand(0, 8) + "%" },
      { right: rand(28, 42) + "%", bottom: rand(8, 20) + "%" },
    ];
    const sizes = [
      { w: 280, h: 360 },
      { w: 240, h: 320 },
      { w: 200, h: 260 },
      { w: 180, h: 230 },
      { w: 140, h: 180 },
      { w: 160, h: 200 },
    ];
    return zones.map((z, i) => ({
      style: z,
      w: sizes[i].w,
      h: sizes[i].h,
      rotate: rand(-22, 22),
      delay: 0.3 + i * 0.12 + Math.random() * 0.1,
      src: pick(),
    }));
    // images intentionally fresh-per-mount — но per-mount достаточно для UI-stub'а.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="hero-shapes" aria-hidden>
      {shapes.map((s, i) => (
        <div
          key={i}
          className="hero-shape"
          style={
            {
              ...s.style,
              animationDelay: `${s.delay}s`,
              "--rot-start": `${s.rotate - 15}deg`,
              "--rot-end": `${s.rotate}deg`,
            } as CSSProperties
          }
        >
          <div className="hero-shape-inner" style={{ width: s.w, height: s.h }}>
            <div className="hero-shape-frame">
              <img src={s.src} alt="" loading="lazy" draggable={false} />
              <div className="hero-shape-frame-veil" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
