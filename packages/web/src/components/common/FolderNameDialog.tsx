import { type FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "@/components/common/Button";
import { Input } from "@/components/common/Input";

/**
 * Модалка для ввода имени папки — общий компонент для create и rename.
 * Submit-кнопка disabled пока поле пустое или не изменилось от initialValue.
 */
export function FolderNameDialog({
  title,
  initialValue = "",
  placeholder,
  submitLabel,
  pending,
  onSubmit,
  onClose,
}: {
  title: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel: string;
  pending: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== initialValue.trim() && !pending;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(trimmed);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1500] flex items-center justify-center p-4 anim-page-in"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="fixed inset-0"
        style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      />
      <form
        onSubmit={handleSubmit}
        className="relative card w-full max-w-sm p-5 z-10"
        style={{ background: "var(--bg-elevated)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="absolute top-3 right-3 text-text-hint hover:text-text"
        >
          <X size={18} />
        </button>
        <h3 className="text-base font-semibold mb-3">{title}</h3>
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          maxLength={64}
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={!canSubmit} loading={pending}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
