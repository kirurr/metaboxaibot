import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Popover в portal'е — рендерится поверх всего, не клипается scroll-контейнерами.
 * Позиционируется по `getBoundingClientRect` anchor'а с auto-flip вверх если
 * не помещается вниз. Реагирует на resize окна и scroll-события (capture, чтобы
 * ловить scroll внутри `.gen-panel-scroll`).
 */
export function ChipPopover({
  anchorRef,
  popRef,
  children,
  className = "gen-chip-pop",
  matchAnchorWidth = false,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  popRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
  className?: string;
  /** Подгонять ширину popover'а под anchor (для model-picker и аналогов). */
  matchAnchorWidth?: boolean;
}) {
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    maxHeight: number;
    width?: number;
  } | null>(null);

  useLayoutEffect(() => {
    function update() {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const ar = anchor.getBoundingClientRect();
      const pop = popRef.current;
      const pw = matchAnchorWidth ? ar.width : (pop?.offsetWidth ?? 240);
      // scrollHeight — фактическая высота контента, не клампнутая max-height'ом
      // самого popover'а. Нужно чтобы корректно решить "помещается ли".
      const ph = pop?.scrollHeight ?? pop?.offsetHeight ?? 100;
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const GAP = 6;
      const MARGIN = 8;
      const MIN_HEIGHT = 120;

      // Выбираем направление: сначала пробуем вниз, если не помещается —
      // вверх. Если ни там, ни там не влезает целиком — пускаем в сторону с
      // бо́льшим запасом и клампим max-height.
      const spaceBelow = vh - ar.bottom - GAP - MARGIN;
      const spaceAbove = ar.top - GAP - MARGIN;
      let top: number;
      let maxHeight: number;
      if (ph <= spaceBelow) {
        top = ar.bottom + GAP;
        maxHeight = spaceBelow;
      } else if (ph <= spaceAbove) {
        top = ar.top - GAP - ph;
        maxHeight = spaceAbove;
      } else if (spaceBelow >= spaceAbove) {
        top = ar.bottom + GAP;
        maxHeight = Math.max(MIN_HEIGHT, spaceBelow);
      } else {
        maxHeight = Math.max(MIN_HEIGHT, spaceAbove);
        top = Math.max(MARGIN, ar.top - GAP - maxHeight);
      }

      // Horizontal: prefer align-left; clamp в viewport.
      let left = ar.left;
      if (left + pw + MARGIN > vw) left = Math.max(MARGIN, vw - pw - MARGIN);
      if (left < MARGIN) left = MARGIN;

      setPos({ top, left, maxHeight, width: matchAnchorWidth ? ar.width : undefined });
    }
    update();
    // Scroll любого внутреннего контейнера → reposition. capture обязателен —
    // scroll-event не bubble'ится. Resize окна тоже двигает anchor.
    const onScrollOrResize = () => update();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    // ResizeObserver на сам popover — ловит изменение высоты контента (например
    // раскрытие "Дополнительных" в settings-панели), чтобы перепозиционировать
    // сразу, а не дожидаться следующего scroll/resize (иначе попап вылезает за
    // экран и со скачком прыгает вверх при ближайшем событии).
    let observer: ResizeObserver | null = null;
    const pop = popRef.current;
    if (pop && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => update());
      observer.observe(pop);
    }
    // Второй tick — после того как popover реально отрендерился с правильным размером.
    const raf = requestAnimationFrame(update);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [anchorRef, popRef, matchAnchorWidth]);

  return createPortal(
    <div
      ref={popRef}
      className={className}
      style={{
        position: "fixed",
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: pos?.width,
        maxHeight: pos?.maxHeight,
        overflowY: "auto",
        // До первого позиционирования прячем (иначе мелькает в (0,0)).
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
