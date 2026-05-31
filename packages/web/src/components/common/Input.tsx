import { forwardRef, useState } from "react";
import type { InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";
import clsx from "clsx";

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string | null;
  hint?: string;
  /** Если true — даёт кнопку показать/скрыть. Тип переключается password↔text. */
  togglePassword?: boolean;
  wrapperClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { label, error, hint, togglePassword, wrapperClassName, className, type, id, ...rest },
  ref,
) {
  const [show, setShow] = useState(false);
  const effectiveType = togglePassword ? (show ? "text" : "password") : type;

  return (
    <div className={clsx("flex flex-col gap-1.5", wrapperClassName)}>
      {label && (
        <label htmlFor={id} className="text-xs font-medium text-text-secondary">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          id={id}
          ref={ref}
          type={effectiveType}
          className={clsx("input", togglePassword && "pr-11", error && "!border-danger", className)}
          aria-invalid={!!error}
          {...rest}
        />
        {togglePassword && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShow((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-text-hint hover:text-text transition-colors"
            aria-label={show ? "Скрыть пароль" : "Показать пароль"}
          >
            {show ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        )}
      </div>
      {error ? (
        <div className="text-xs text-danger">{error}</div>
      ) : hint ? (
        <div className="text-xs text-text-hint">{hint}</div>
      ) : null}
    </div>
  );
});
