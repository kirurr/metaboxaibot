import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/common/Button";

/**
 * Универсальный модальный confirm. Рендерится через `createPortal(document.body)`
 * чтобы не зависеть от stacking-context'а и `overflow:hidden` родителя
 * (важно для вызова изнутри bottom-sheet'а PreviewInfoCard, у которого
 * `transform` создаёт containing block для fixed-children).
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  pending,
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    // stopPropagation на onClick — клики по бэкдропу триггерят onCancel и не
    // распространяются на React-предков в дереве (важно для consumer'ов
    // вроде Gallery JobCard, где portal-child кликабельной <li>).
    <div
      className="fixed inset-0 z-[1500] flex items-center justify-center p-4 anim-page-in"
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <div
        className="fixed inset-0"
        style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative card w-full max-w-sm p-5 z-10"
        style={{ background: "var(--bg-elevated)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-2">{title}</h3>
        {message && <p className="text-sm text-text-secondary m-0 mb-4">{message}</p>}
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant={danger ? "danger" : "primary"}
            size="sm"
            onClick={onConfirm}
            loading={pending}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
