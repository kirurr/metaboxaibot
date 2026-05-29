import type { CSSProperties } from "react";

/**
 * Квадратный аватар модели: монохромная SVG-иконка бренда либо буква-фолбек.
 *
 * Иконки lobe — одноцветные силуэты, поэтому рисуем их CSS-маской с
 * `background: currentColor`: логотип принимает цвет текста контейнера и
 * остаётся видимым в любой теме (а не «теряется» чёрным на тёмном фоне).
 * Маску кладём во вложенный span, чтобы не обрезать фон/границу самого бокса.
 *
 * `className`/`style` задают сам бокс (переиспользуем существующие классы:
 * `mega-ico letter`, `gen-model-glyph` и т.п.). `icon: null` → буква из `name`.
 */
export function ModelAvatar({
  icon,
  name,
  className,
  style,
  iconSize = 20,
}: {
  icon: string | null;
  name: string;
  className?: string;
  style?: CSSProperties;
  /** Размер иконки внутри бокса (px). Бокс центрирует её. */
  iconSize?: number;
}) {
  return (
    <span className={className} style={style}>
      {icon ? (
        <span
          aria-hidden
          style={{
            display: "block",
            width: iconSize,
            height: iconSize,
            backgroundColor: "currentColor",
            WebkitMaskImage: `url("${icon}")`,
            maskImage: `url("${icon}")`,
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskPosition: "center",
            WebkitMaskSize: "contain",
            maskSize: "contain",
          }}
        />
      ) : (
        name.trim().slice(0, 1).toUpperCase() || "·"
      )}
    </span>
  );
}
