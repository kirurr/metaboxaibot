import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { getAmbientMedia, type AmbientMediaItem, type AmbientSection } from "@/api/ambientMedia";

/**
 * Фоновый ambient-эффект для пустого экрана генерации: красивые медиа
 * «выпадают» сверху и затем мягко плавают. На /image — картинки, на /video —
 * автоплеящиеся (muted, loop) видео.
 *
 * Рендерится позади всех окон (внутри `.gen-bg`, z-index ниже `.gen-panel`),
 * во всю ширину/высоту сцены. Прячется родителем, как только появляется первая
 * генерация (тогда справа показывается галерея).
 */

/** Раскладка плиток по сцене: позиция, размер, наклон, тайминги, амплитуда. */
type Slot = {
  /** CSS-позиция (любые из top/bottom/left/right). */
  pos: React.CSSProperties;
  width: number;
  rotate: number;
  /** Задержка появления, сек. */
  delay: number;
  /** Длительность цикла «плавания», сек. */
  floatDuration: number;
  /** Амплитуда вертикального дрейфа, px. */
  floatY: number;
};

// Соотношение сторон плитки — портретное (≈3:4), как карточки генераций.
const TILE_RATIO = 4 / 3;

/** Правый край панели (фикс. 420px) + паддинги сцены + зазор, px. За этой
 *  границей начинается свободная зона, куда можно класть плитки. */
const PANEL_RIGHT_PX = 420 + 36 + 24 + 24; // width + padding-left + gap + запас

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Фишер-Йейтс шафл (не мутирует исходный массив). */
function shuffle<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Прямоугольник в смешанных единицах: x/w в % ширины, y/h в % высоты. */
type Rect = { x: number; y: number; w: number; h: number };

/** AABB-пересечение двух прямоугольников с зазором (gap по каждой оси). */
function intersects(a: Rect, b: Rect, gapX: number, gapY: number): boolean {
  return (
    a.x - gapX < b.x + b.w &&
    a.x + a.w + gapX > b.x &&
    a.y - gapY < b.y + b.h &&
    a.y + a.h + gapY > b.y
  );
}

/** Доля перекрытия двух прямоугольников относительно площади меньшего (0..1). */
function overlapRatio(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const minArea = Math.min(a.w * a.h, b.w * b.h);
  return minArea > 0 ? inter / minArea : 0;
}

/** Кол-во плиток под ширину свободной зоны (px). */
function countFor(freePx: number): number {
  if (freePx < 420) return 5;
  if (freePx < 760) return 6;
  return 7;
}

/** Максимально допустимое наложение плиток (доля от меньшей). */
const MAX_OVERLAP = 0.35;

/**
 * Генерирует случайную раскладку (rejection sampling) в правой зоне (справа от
 * фиксированной панели). Размер плиток подбирается под доступное место (как
 * можно крупнее, но чтобы умещались), safe-зона текста — только по ширине
 * текста (по центру), поэтому плитки могут стоять и сбоку, и сверху/снизу.
 * Наложение — не более ~35% (MAX_OVERLAP); из попыток берётся позиция с
 * наименьшим перекрытием.
 */
function buildSlots(vw: number): Slot[] {
  // Высота вьюпорта — top/height в CSS считаются от высоты контейнера.
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const xMin = Math.min(70, (PANEL_RIGHT_PX / vw) * 100);
  const xMax = 95;
  const yMin = 5;
  const yMax = 90;

  const zoneWpx = ((xMax - xMin) / 100) * vw;
  const count = countFor(zoneWpx);

  // Потолок размера: ширина ≤ ~44% зоны, высота ≤ ~28% экрана — чтобы плитки
  // гарантированно умещались и не слипались в кучу. Крупнее на больших экранах.
  const sizeMax = Math.max(110, Math.min(260, zoneWpx * 0.44, (vh * 0.28) / TILE_RATIO));
  const sizeMin = sizeMax * 0.62;

  // Safe-зона текста: только по ширине текста, по центру правой зоны и по высоте.
  const cx = (xMin + xMax) / 2;
  const textWpct = Math.min((xMax - xMin) * 0.92, (560 / vw) * 100);
  const safe: Rect = { x: cx - textWpct / 2, y: 36, w: textWpct, h: 28 };

  const placed: Rect[] = [];
  const slots: Slot[] = [];
  const MAX_TRIES = 140;

  for (let i = 0; i < count; i++) {
    const width = Math.round(rand(sizeMin, sizeMax));
    const wPct = (width / vw) * 100;
    const hPct = ((width * TILE_RATIO) / vh) * 100;

    let best: { left: number; top: number; overlap: number } | null = null;

    for (let tries = 0; tries < MAX_TRIES; tries++) {
      const left = rand(xMin, Math.max(xMin, xMax - wPct));
      const top = rand(yMin, Math.max(yMin, yMax - hPct));
      const rect: Rect = { x: left, y: top, w: wPct, h: hPct };

      // Текст не перекрываем.
      if (intersects(rect, safe, 0.5, 0.5)) continue;

      const maxOv = placed.reduce((m, p) => Math.max(m, overlapRatio(rect, p)), 0);
      // Запоминаем лучший (наименьшее перекрытие) на случай фоллбэка.
      if (!best || maxOv < best.overlap) best = { left, top, overlap: maxOv };
      if (maxOv <= MAX_OVERLAP) break;
    }

    const chosen = best ?? { left: xMin, top: yMin, overlap: 0 };
    placed.push({ x: chosen.left, y: chosen.top, w: wPct, h: hPct });

    slots.push({
      pos: { left: `${chosen.left.toFixed(2)}%`, top: `${chosen.top.toFixed(2)}%` },
      width,
      rotate: Math.round(rand(-14, 14)),
      delay: rand(0.05, 0.8),
      floatDuration: rand(11, 15.5),
      floatY: Math.round(rand(14, 26)),
    });
  }

  return slots;
}

function MediaTile({
  item,
  section,
  slot,
}: {
  item: AmbientMediaItem;
  section: AmbientSection;
  slot: Slot;
}) {
  const height = Math.round(slot.width * TILE_RATIO);
  return (
    <motion.div
      className="gen-ambient-tile"
      style={{ ...slot.pos, width: slot.width, height }}
      initial={{ opacity: 0, y: -220, rotate: slot.rotate - 14 }}
      animate={{ opacity: 1, y: 0, rotate: slot.rotate }}
      transition={{
        duration: 2.2,
        delay: slot.delay,
        ease: [0.23, 0.86, 0.39, 0.96],
        opacity: { duration: 1.2, delay: slot.delay },
      }}
    >
      <motion.div
        className="gen-ambient-tile-inner"
        animate={{ y: [0, slot.floatY, 0] }}
        transition={{
          duration: slot.floatDuration,
          repeat: Number.POSITIVE_INFINITY,
          ease: "easeInOut",
        }}
      >
        {section === "video" ? (
          <video
            src={item.url}
            poster={item.posterUrl ?? undefined}
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
          />
        ) : (
          <img src={item.url} alt="" loading="lazy" draggable={false} />
        )}
      </motion.div>
    </motion.div>
  );
}

/** Ширина вьюпорта, бакетированная по ~140px — чтобы мелкие ресайзы не
 *  перегенерировали раскладку, а смена ориентации/значимый ресайз — да. */
function useViewportBucket(): number {
  const [bucket, setBucket] = useState(() =>
    typeof window !== "undefined" ? Math.round(window.innerWidth / 140) : 8,
  );
  useEffect(() => {
    const onResize = () => setBucket(Math.round(window.innerWidth / 140));
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  return bucket;
}

export function FloatingMediaBg({ section }: { section: AmbientSection }) {
  const [items, setItems] = useState<AmbientMediaItem[] | null>(null);
  const widthBucket = useViewportBucket();

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    getAmbientMedia(section).then((pack) => {
      if (!cancelled) setItems(pack.items);
    });
    return () => {
      cancelled = true;
    };
  }, [section]);

  // Раскладка зависит от ширины вьюпорта (фикс. панель → меньше места справа на
  // узких экранах). Пересоздаётся при значимом ресайзе/смене ориентации.
  const slots = useMemo(() => buildSlots(widthBucket * 140), [widthBucket]);

  // Назначаем по одному медиа на каждый слот (рандомно, с переиспользованием,
  // если медиа меньше, чем слотов).
  const assigned = useMemo(() => {
    if (!items || items.length === 0) return [];
    const pool = shuffle(items);
    return slots.map((slot, i) => ({ slot, item: pool[i % pool.length], key: i }));
  }, [items, slots]);

  if (assigned.length === 0) return null;

  return (
    <div className="gen-ambient" aria-hidden>
      {assigned.map(({ slot, item, key }) => (
        <MediaTile key={key} item={item} section={section} slot={slot} />
      ))}
    </div>
  );
}
