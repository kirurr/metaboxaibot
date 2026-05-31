import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Лёгкий лайтбокс для просмотра одной картинки крупно. Используется в чате,
 * чтобы убедиться, что вложение загрузилось (composer + тред).
 *
 * Без папок/настроек/навигации — в отличие от `GenerationPreviewModal`. Рендерится
 * порталом в body, закрывается по клику на фон, кнопке X или Escape.
 */
export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="img-lightbox-backdrop" onClick={onClose}>
      <button className="img-lightbox-close" onClick={onClose} aria-label={t("common.close")}>
        <X size={20} />
      </button>
      <img className="img-lightbox-img" src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  );
}
