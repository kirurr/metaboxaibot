import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Featured-сетка с scroll-driven анимацией. Каждый тайл считает свой прогресс
 * `p ∈ [0, 1]` относительно viewport'а: 0 — только зашёл сверху, 0.5 — в центре
 * (фокус), 1 — уходит снизу. Прогресс прогоняется через два разных кубических
 * Безье (ease-in до фокуса, ease-out после), результат интерполируется в
 * blur / brightness / rotation / translate / skew.
 *
 * Источник дизайна и значений: `aibox_template/ai-box.html` (TiltedTile).
 */

export type TiltedItem = {
  kind: string;
  model: string;
  prompt: string;
  credits: string;
  img: string;
};

// Кубический Безье по 4 контрольным точкам. Возвращает функцию x -> y,
// аналог framer-motion'овского `cubicBezier`.
function makeBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton: 8 итераций обычно достаточно для точности 1e-5.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = sampleX(t) - x;
      if (Math.abs(d) < 1e-5) return sampleY(t);
      const dx = sampleDX(t);
      if (Math.abs(dx) < 1e-6) break;
      t -= d / dx;
    }
    // Fallback: бисекция, если Newton разошёлся.
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 20; i++) {
      const xt = sampleX(t);
      if (Math.abs(xt - x) < 1e-5) break;
      if (xt < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

const easeIntoFocus = makeBezier(0.22, 1, 0.36, 1);
const easeOutOfFocus = makeBezier(0, 0, 0.58, 1);

function TiltedTile({
  item,
  idx,
  onClick,
  badge,
}: {
  item: TiltedItem;
  idx: number;
  onClick: () => void;
  badge?: ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [p, setP] = useState(0.5);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // Эквивалент framer-motion'овского `["start end", "end start"]`:
      // прогресс растёт от 0 (тайл только показался снизу viewport'а) до 1
      // (тайл только что ушёл за верх).
      const total = vh + r.height;
      const moved = vh - r.top;
      setP(Math.max(0, Math.min(1, moved / total)));
    };
    const sched = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", sched, { passive: true });
    window.addEventListener("resize", sched);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", sched);
      window.removeEventListener("resize", sched);
    };
  }, []);

  // Чётные тайлы наклоняются влево, нечётные — вправо.
  const side = idx % 2 === 0 ? -1 : 1;
  // keyframes [0, 0.5, 1] -> [start, focus, end], две кривых по разные стороны
  // от фокуса.
  const interp = (a: number, b: number, c: number) => {
    if (p < 0.5) {
      const t = easeIntoFocus(p / 0.5);
      return a + (b - a) * t;
    }
    const t = easeOutOfFocus((p - 0.5) / 0.5);
    return b + (c - b) * t;
  };

  const blur = interp(8, 0, 8);
  const bright = interp(0, 1, 0);
  const contrast = interp(4, 1, 4);
  const ty = interp(100, 0, -100);
  const tz = interp(300, 0, 300);
  const rx = interp(70, 0, -70);
  const tx = interp(side * 40, 0, side * 40);
  const rot = interp(-side * 5, 0, side * 5);
  const sk = interp(side * 20, 0, -side * 20);
  const innerSY = interp(1.8, 1, 1.8);

  return (
    <figure ref={ref} className="tilted-tile" onClick={onClick}>
      <div
        className="tilted-inner"
        style={{
          transform: `translate3d(${tx}%, ${ty}%, ${tz}px) rotateZ(${rot}deg) rotateX(${rx}deg) skewX(${sk}deg)`,
          filter: `blur(${blur}px) brightness(${bright}) contrast(${contrast})`,
        }}
      >
        <div
          className="tilted-img"
          style={{
            backgroundImage: `url("${item.img}")`,
            transform: `scaleY(${innerSY})`,
          }}
        />
        <div className="tilted-veil" />
        <div className="tilted-meta">
          <div className="tm-tags">
            <span className="tm-kind">{item.kind}</span>
            <span className="tm-model">{item.model}</span>
          </div>
          <div className="tm-prompt">{item.prompt}</div>
          <div className="tm-cta">Open {badge}</div>
        </div>
      </div>
    </figure>
  );
}

export function TiltedFeatured({
  items,
  onTileClick,
  arrow,
}: {
  items: readonly TiltedItem[];
  onTileClick: (item: TiltedItem) => void;
  /** Иконка-стрелка справа в CTA — передаём из родителя, чтобы не тащить lucide сюда. */
  arrow?: ReactNode;
}) {
  return (
    <div className="tilted-grid">
      {items.map((it, i) => (
        <TiltedTile key={i} item={it} idx={i} onClick={() => onTileClick(it)} badge={arrow} />
      ))}
    </div>
  );
}
