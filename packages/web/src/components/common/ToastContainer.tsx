import { useUIStore } from "@/stores/uiStore";
import { CheckCircle2, AlertCircle, Info, AlertTriangle, Loader2, X } from "lucide-react";
import clsx from "clsx";

const iconMap = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
  loading: Loader2,
};

const colorMap = {
  success: "text-success",
  error: "text-danger",
  info: "text-accent",
  warning: "text-[color:var(--warning)]",
  loading: "text-accent",
};

export function ToastContainer() {
  const { toasts, dismissToast } = useUIStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed z-[9999] bottom-4 right-4 flex flex-col gap-2 max-w-sm pointer-events-none">
      {toasts.map((t) => {
        const Icon = iconMap[t.type];
        return (
          <div
            key={t.id}
            className={clsx(
              "card pointer-events-auto flex items-start gap-3 px-4 py-3",
              t.exiting ? "anim-toast-out" : "anim-page-in",
            )}
            style={{ minWidth: 260 }}
          >
            <Icon
              size={20}
              className={clsx(
                "shrink-0 mt-0.5",
                colorMap[t.type],
                t.type === "loading" && "animate-spin",
              )}
            />
            <div className="flex-1 text-sm min-w-0">
              <div>{t.message}</div>
              {t.description && (
                <div className="text-xs text-text-secondary mt-0.5">{t.description}</div>
              )}
            </div>
            <button
              onClick={() => dismissToast(t.id)}
              className="shrink-0 text-text-hint hover:text-text transition-colors"
              aria-label="Закрыть"
            >
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
