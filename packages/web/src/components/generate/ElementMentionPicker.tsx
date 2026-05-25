import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ImagePlus, Plus, X } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { useElements } from "@/hooks/useElements";
import { type Element } from "@/api/elements";
import { ElementEditPopup } from "./ElementEditPopup";

/**
 * Модальный пикер элементов для кнопки @Elements в промпте генерации.
 *
 * Показывает все элементы юзера + создание (через ElementEditPopup). Клик по
 * элементу подставляет его @-меншен в промпт (родитель решает что дальше —
 * обычно открывает выбор картинок). Уже активные элементы помечены галочкой и
 * некликабельны; при достижении лимита модели остальные дизейблятся.
 */

export type ElementMentionPickerProps = {
  /** id уже упомянутых в промпте элементов — помечаем, не даём добавить повторно. */
  activeElementIds: Set<string>;
  /** Достигнут лимит элементов модели — добавление новых заблокировано. */
  atLimit: boolean;
  onPick: (element: Element) => void;
  onClose: () => void;
};

export function ElementMentionPicker({
  activeElementIds,
  atLimit,
  onPick,
  onClose,
}: ElementMentionPickerProps) {
  const { t } = useTranslation();
  const { elements, isLoading } = useElements();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Пока открыт ElementEditPopup (свой Esc) — не закрываем оба разом.
      if (e.key === "Escape" && !creating) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, creating]);

  function renderCard(el: Element) {
    const cover = el.media[0]?.url ?? null;
    const isActive = activeElementIds.has(el.id);
    const disabled = isActive || (atLimit && !isActive);
    return (
      <div key={el.id} className="group">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onPick(el)}
          title={atLimit && !isActive ? t("elementMention.limitReached") : undefined}
          className={clsx(
            "relative aspect-square w-full overflow-hidden rounded-[var(--radius)] bg-bg-elevated ring-2 transition",
            isActive ? "ring-accent" : "ring-transparent hover:ring-white/30",
            disabled && "cursor-not-allowed opacity-40",
          )}
        >
          {cover ? (
            <img src={cover} alt={el.name} loading="lazy" className="size-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-text-secondary">
              <ImagePlus size={20} />
            </div>
          )}
          {isActive && (
            <div className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-accent text-on-accent">
              <Check size={12} />
            </div>
          )}
        </button>
        <div className="mt-1 truncate text-center text-xs text-text" title={el.name}>
          @{el.name}
        </div>
      </div>
    );
  }

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      >
        <div
          className="card flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden p-0 sm:max-h-[80vh]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center gap-3 border-b border-white/10 p-3 sm:p-4">
            <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-text">
              {t("elementMention.title")}
            </h3>
            <button
              className="btn btn-ghost btn-icon shrink-0"
              onClick={onClose}
              aria-label={t("common.close")}
            >
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="min-h-[55vh] max-h-[70vh] overflow-y-auto p-4 [scrollbar-gutter:stable] sm:min-h-0 sm:max-h-[45vh]">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-[var(--radius)] border border-dashed border-white/20 bg-bg-elevated text-text-secondary transition hover:border-white/40 hover:text-white"
              >
                <Plus size={20} />
                <span className="text-xs">{t("mediaReuse.createElement")}</span>
              </button>

              {isLoading
                ? Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="aspect-square w-full rounded-[var(--radius)] skeleton" />
                  ))
                : elements.map((el) => renderCard(el))}
            </div>

            {!isLoading && elements.length === 0 && (
              <div className="py-8 text-center text-text-secondary">
                {t("elementMention.empty")}
              </div>
            )}
          </div>
        </div>
      </div>

      {creating && <ElementEditPopup mode="create" onClose={() => setCreating(false)} />}
    </>,
    document.body,
  );
}
