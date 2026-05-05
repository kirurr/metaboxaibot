import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface RatioOption {
  value: string;
  label: string;
}

interface AspectRatioWheelProps {
  options: RatioOption[];
  value: string;
  onChange: (value: string) => void;
}

const ITEM_HEIGHT = 28;
const VISIBLE_ITEMS = 5;
const WHEEL_HEIGHT = ITEM_HEIGHT * VISIBLE_ITEMS;
const CENTER_INDEX = Math.floor(VISIBLE_ITEMS / 2);

type TgWebApp = {
  HapticFeedback?: { selectionChanged?: () => void };
  disableVerticalSwipes?: () => void;
  enableVerticalSwipes?: () => void;
};

function getTwa(): TgWebApp | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp;
}

function parseRatio(value: string): { w: number; h: number } | null {
  const m = value.match(/^(\d+):(\d+)$/);
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
}

function AspectRatioPreview({ value, label }: { value: string; label: string }) {
  const MAX_W = 110;
  const MAX_H = 84;
  const isAuto = value === "auto";
  let w = 70;
  let h = 70;
  if (!isAuto) {
    const parsed = parseRatio(value);
    if (parsed) {
      const ratio = parsed.w / parsed.h;
      if (ratio >= MAX_W / MAX_H) {
        w = MAX_W;
        h = Math.max(14, Math.round(MAX_W / ratio));
      } else {
        h = MAX_H;
        w = Math.max(14, Math.round(MAX_H * ratio));
      }
    }
  }
  return (
    <div className="ar-wheel__preview">
      <div className="ar-wheel__preview-stage">
        {isAuto ? (
          <span className="ar-wheel__preview-auto">auto</span>
        ) : (
          <div className="ar-wheel__preview-rect" style={{ width: w, height: h }} />
        )}
      </div>
      <div className="ar-wheel__preview-label">{isAuto ? "auto" : label}</div>
    </div>
  );
}

export function AspectRatioWheel({ options, value, onChange }: AspectRatioWheelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastEmittedValueRef = useRef<string>(value);
  const lastHapticIndexRef = useRef<number>(-1);
  const programmaticScrollRef = useRef<boolean>(false);
  const snapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeIndex, setActiveIndex] = useState<number>(() => {
    const idx = options.findIndex((o) => o.value === value);
    return idx >= 0 ? idx : 0;
  });

  const indexFromScroll = useCallback((scrollTop: number): number => {
    return Math.round(scrollTop / ITEM_HEIGHT);
  }, []);

  // Keep scroll position synced with external `value` changes (e.g. model swap
  // resets aspect ratio to default). Gate by current DOM-idx vs target idx so
  // mid-scroll re-renders (parent passes a fresh `options` array on every render
  // → effect would re-fire each frame) don't yank scrollTop back to the snap
  // boundary while the user is actively scrolling.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const idx = options.findIndex((o) => o.value === value);
    if (idx < 0) return;
    const currentDomIdx = Math.round(el.scrollTop / ITEM_HEIGHT);
    if (currentDomIdx === idx) return;
    const target = idx * ITEM_HEIGHT;
    programmaticScrollRef.current = true;
    el.scrollTo({ top: target, behavior: "auto" });
    setActiveIndex(idx);
    lastEmittedValueRef.current = value;
    lastHapticIndexRef.current = idx;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, [value, options]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const idx = Math.max(0, Math.min(options.length - 1, indexFromScroll(el.scrollTop)));
    if (idx !== activeIndex) setActiveIndex(idx);

    if (programmaticScrollRef.current) return;

    if (idx !== lastHapticIndexRef.current) {
      lastHapticIndexRef.current = idx;
      getTwa()?.HapticFeedback?.selectionChanged?.();
    }

    const opt = options[idx];
    if (!opt) return;
    if (opt.value !== lastEmittedValueRef.current) {
      lastEmittedValueRef.current = opt.value;
      onChange(opt.value);
    }

    // Snap correction: if scroll lands between snap points (mostly desktop wheel
    // events ignore scroll-snap), gently align after a short idle.
    if (snapTimeoutRef.current) clearTimeout(snapTimeoutRef.current);
    snapTimeoutRef.current = setTimeout(() => {
      const cur = scrollRef.current;
      if (!cur) return;
      const targetIdx = Math.max(0, Math.min(options.length - 1, indexFromScroll(cur.scrollTop)));
      const target = targetIdx * ITEM_HEIGHT;
      if (Math.abs(cur.scrollTop - target) > 0.5) {
        programmaticScrollRef.current = true;
        cur.scrollTo({ top: target, behavior: "smooth" });
        requestAnimationFrame(() => {
          programmaticScrollRef.current = false;
        });
      }
    }, 120);
  }, [activeIndex, indexFromScroll, onChange, options]);

  const handleItemClick = useCallback((idx: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: idx * ITEM_HEIGHT, behavior: "smooth" });
  }, []);

  // Telegram miniapp: vertical swipes inside the wheel must not bubble up to
  // the app's pull-to-close gesture. Disable while pointer is engaged.
  const onPointerDown = useCallback(() => {
    getTwa()?.disableVerticalSwipes?.();
  }, []);
  const onPointerUp = useCallback(() => {
    getTwa()?.enableVerticalSwipes?.();
  }, []);

  useEffect(() => {
    return () => {
      if (snapTimeoutRef.current) clearTimeout(snapTimeoutRef.current);
      getTwa()?.enableVerticalSwipes?.();
    };
  }, []);

  return (
    <div className="ar-wheel">
      <AspectRatioPreview
        value={options[activeIndex]?.value ?? value}
        label={options[activeIndex]?.label ?? value}
      />
      <div
        ref={scrollRef}
        className="ar-wheel__scroller"
        style={{ height: WHEEL_HEIGHT }}
        onScroll={handleScroll}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onTouchStart={onPointerDown}
        onTouchEnd={onPointerUp}
        onTouchCancel={onPointerUp}
        role="listbox"
        aria-label="Aspect ratio"
      >
        <div className="ar-wheel__pad" style={{ height: ITEM_HEIGHT * CENTER_INDEX }} aria-hidden />
        {options.map((opt, idx) => {
          const offset = idx - activeIndex;
          const abs = Math.abs(offset);
          // 3D cylinder: items further from center rotate back and dim.
          const rotate = Math.max(-60, Math.min(60, offset * 18));
          const opacity = abs === 0 ? 1 : abs === 1 ? 0.55 : abs === 2 ? 0.25 : 0.12;
          const scale = abs === 0 ? 1 : abs === 1 ? 0.92 : 0.84;
          return (
            <button
              key={opt.value}
              type="button"
              className={`ar-wheel__item${idx === activeIndex ? " ar-wheel__item--active" : ""}`}
              style={{
                height: ITEM_HEIGHT,
                transform: `rotateX(${rotate}deg) scale(${scale})`,
                opacity,
              }}
              onClick={() => handleItemClick(idx)}
              role="option"
              aria-selected={idx === activeIndex}
            >
              {opt.label}
            </button>
          );
        })}
        <div className="ar-wheel__pad" style={{ height: ITEM_HEIGHT * CENTER_INDEX }} aria-hidden />
      </div>
    </div>
  );
}
