import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ImagePlus, X } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import type { Element } from "@/api/elements";

/**
 * Выбор подмножества картинок элемента для одной генерации.
 *
 * Element хранит неограниченно референсов, а модель (напр. Kling) берёт лишь
 * 2–4. Этот попап даёт выбрать какие именно s3Key уйдут в `ref_element_N`.
 * Открывается сразу при подстановке элемента в промпт и переоткрывается по
 * клику на чип активного элемента. По умолчанию выбраны первые `maxImages`.
 */

export type ElementImageSelectPopupProps = {
  element: Element;
  /** Максимум картинок, который берёт модель (slot.maxImages, обычно 4). */
  maxImages: number;
  /** Изначально выбранные s3Key (из draft-store); пусто → дефолт первые maxImages. */
  initialSelected: string[];
  onConfirm: (s3Keys: string[]) => void;
  onClose: () => void;
};

export function ElementImageSelectPopup({
  element,
  maxImages,
  initialSelected,
  onConfirm,
  onClose,
}: ElementImageSelectPopupProps) {
  const { t } = useTranslation();

  // Дефолт — первые maxImages, если валидного выбора ещё нет.
  const [selected, setSelected] = useState<string[]>(() => {
    const available = new Set(element.media.map((m) => m.s3Key));
    const valid = initialSelected.filter((k) => available.has(k));
    if (valid.length > 0) return valid.slice(0, maxImages);
    return element.media.slice(0, maxImages).map((m) => m.s3Key);
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function toggle(s3Key: string) {
    setSelected((prev) => {
      if (prev.includes(s3Key)) return prev.filter((k) => k !== s3Key);
      if (prev.length >= maxImages) return prev; // не больше лимита модели
      return [...prev, s3Key];
    });
  }

  const atCap = selected.length >= maxImages;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-2 sm:p-4 bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden p-0 sm:max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-white/10 p-3 sm:p-4">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-text">@{element.name}</h3>
            <p className="truncate text-xs text-text-secondary">
              {t("elementSelect.hint", { max: maxImages })}
            </p>
          </div>
          <button
            className="btn btn-ghost btn-icon shrink-0"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-[40vh] max-h-[70vh] overflow-y-auto p-4 [scrollbar-gutter:stable] sm:max-h-[55vh]">
          {element.media.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-text-secondary">
              <ImagePlus size={24} />
              {t("elementSelect.empty")}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {element.media.map((m) => {
                const sel = selected.includes(m.s3Key);
                const disabled = !sel && atCap;
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => toggle(m.s3Key)}
                    className={clsx(
                      "relative aspect-square w-full overflow-hidden rounded-[var(--radius)] bg-bg-elevated ring-2 transition",
                      sel ? "ring-accent" : "ring-transparent hover:ring-white/30",
                      disabled && "cursor-not-allowed opacity-40",
                    )}
                  >
                    {m.url ? (
                      <img
                        src={m.url}
                        alt={m.name}
                        loading="lazy"
                        className="size-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-text-secondary">
                        <ImagePlus size={20} />
                      </div>
                    )}
                    {sel && (
                      <div className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-accent text-on-accent">
                        <Check size={12} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-4 border-t border-white/10 p-4">
          <span className="text-sm text-text-secondary">
            {t("mediaPicker.selectedOf", { n: selected.length, max: maxImages })}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={selected.length === 0}
            onClick={() => onConfirm(selected)}
          >
            {t("elementSelect.done")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
