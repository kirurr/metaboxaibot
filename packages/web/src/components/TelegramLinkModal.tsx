import { useEffect, useRef, useState, useCallback } from "react";
import { X, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { linkTelegramInit, linkTelegramStatus } from "@/api/auth";
import { useAuthStore } from "@/stores/authStore";
import { useUIStore } from "@/stores/uiStore";
import * as authApi from "@/api/auth";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Контекст. Например: "чтобы начать общение с нейросетью" */
  context?: string;
}

/**
 * Модалка «Привяжите Telegram» — по аналогии с TelegramVerifyPopup на metabox.global,
 * адаптирована под тёмный дизайн AI Box.
 *
 * Поведение:
 * 1. При открытии дергает /auth/web-link-telegram/init — получает deep-link `t.me/bot?start=linkweb_<state>`
 * 2. Показывает кнопку «Открыть Telegram-бот» + polling статуса каждые 3 сек
 * 3. Как только бэк вернул `linked: true` — закрывается + тост об успехе + рефреш сессии
 */
export function TelegramLinkModal({ open, onClose, context }: Props) {
  const { t } = useTranslation();
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const tryRefresh = useAuthStore((s) => s.tryRefresh);
  const setUser = useAuthStore((s) => s.setUser);
  const pushToast = useUIStore((s) => s.pushToast);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (s: string) => {
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const status = await linkTelegramStatus(s);
          if (status.linked) {
            stopPolling();
            // Обновляем токены — теперь JWT будет содержать aibUserId
            await tryRefresh();
            try {
              const { user } = await authApi.me();
              setUser(user);
            } catch {
              /* ignore */
            }
            pushToast({
              type: "success",
              message: status.telegramUsername
                ? t("telegramLink.linkedToast", { username: status.telegramUsername })
                : t("telegramLink.linkedToastNoUsername"),
            });
            onClose();
          }
        } catch {
          /* молча игнорируем и продолжаем */
        }
      }, 3000);
    },
    [stopPolling, tryRefresh, setUser, pushToast, onClose],
  );

  useEffect(() => {
    if (!open) {
      stopPolling();
      setDeepLink(null);
      setState(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    linkTelegramInit()
      .then((res) => {
        setDeepLink(res.deepLinkUrl);
        setState(res.state);
        startPolling(res.state);
      })
      .catch(() => setError(t("telegramLink.linkError")))
      .finally(() => setLoading(false));

    return () => stopPolling();
  }, [open, startPolling, stopPolling]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const contextText = context
    ? t("telegramLink.introWithContext", { context })
    : t("telegramLink.intro");

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 anim-page-in"
      onClick={onClose}
    >
      <div
        className="fixed inset-0"
        style={{
          background: "rgba(0, 0, 0, 0.6)",
          backdropFilter: "blur(4px)",
        }}
      />
      <div
        className="relative card w-full max-w-md p-6 z-10"
        style={{ background: "var(--bg-elevated)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-text-hint hover:text-text transition-colors"
          aria-label={t("common.close")}
        >
          <X size={20} />
        </button>

        <div className="text-center">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{ background: "rgba(42, 171, 238, 0.15)" }}
          >
            <Send size={28} className="text-[#2AABEE]" />
          </div>

          <h3 className="text-lg font-bold mb-2">{t("telegramLink.title")}</h3>
          <p className="text-sm text-text-secondary leading-relaxed mb-4">{contextText}</p>
          <p className="text-xs text-text-hint leading-relaxed">{t("telegramLink.instructions")}</p>
        </div>

        {error && <p className="text-sm text-danger text-center mt-3">{error}</p>}

        {loading ? (
          <div className="mt-5 flex justify-center">
            <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          </div>
        ) : deepLink ? (
          <a
            href={deepLink}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 w-full py-3 rounded text-sm font-semibold flex items-center justify-center gap-2 transition-colors"
            style={{
              background: "#2AABEE",
              color: "#fff",
            }}
          >
            <Send size={16} />
            {t("telegramLink.openBot")}
          </a>
        ) : null}

        <button
          onClick={onClose}
          className="mt-3 w-full py-2 text-text-hint text-sm hover:text-text transition-colors"
        >
          {t("telegramLink.cancel")}
        </button>

        {deepLink && state && (
          <p className="text-xs text-center text-text-hint mt-3 animate-pulse">
            {t("telegramLink.waiting")}
          </p>
        )}
      </div>
    </div>
  );
}
