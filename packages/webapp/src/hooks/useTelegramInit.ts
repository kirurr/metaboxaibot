import { useEffect, useState } from "react";
import { setInitDataRaw, setWebToken, clearWebToken, api } from "../api/client.js";
import { useI18n } from "../i18n.js";

type TelegramWebApp = {
  initData: string;
  ready?: () => void;
  expand?: () => void;
  disableVerticalSwipes?: () => void;
};

export interface TelegramInitState {
  ready: boolean;
  error: string | null;
  /** Distinguishes "user record missing in DB" from generic auth errors —
   *  фронт показывает специальный экран с CTA «Открыть бота», а не plain alert. */
  errorCode: string | null;
  /** Non-fatal warning shown while still polling (loader stays visible). */
  warning: string | null;
  userId: string | null;
  initDataRaw: string | null;
}

const WARN_AFTER_MS = 3000;
const POLL_INTERVAL_MS = 50;

function getTgWebApp(): TelegramWebApp | undefined {
  return (window as Window & { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
}

/** Read ?wtoken= from URL — issued by the bot for KeyboardButtonWebApp launches. */
function getUrlWebToken(): string {
  return new URLSearchParams(window.location.search).get("wtoken") ?? "";
}

export function useTelegramInit(): TelegramInitState {
  const { t } = useI18n();
  const [state, setState] = useState<TelegramInitState>({
    ready: false,
    error: null,
    errorCode: null,
    warning: null,
    userId: null,
    initDataRaw: null,
  });

  useEffect(() => {
    getTgWebApp()?.ready?.();

    getTgWebApp()?.expand?.();
    getTgWebApp()?.disableVerticalSwipes?.();

    if (import.meta.env.DEV) {
      setState({
        ready: true,
        error: null,
        errorCode: null,
        warning: null,
        userId: "dev",
        initDataRaw: null,
      });
      return;
    }

    // Try URL-based token immediately (KeyboardButtonWebApp / requestSimpleWebView
    // never injects initData by Telegram design — token in URL is the fallback).
    const wtoken = getUrlWebToken();
    if (wtoken) {
      // Set _webToken до verifyToken: иначе rolling-refresh из ответа (X-Refresh-Wtoken,
      // ставится в client.ts) был бы перезатёрт устаревшим wtoken из URL в .then.
      setWebToken(wtoken);
      api.auth
        .verifyToken(wtoken)
        .then((user) => {
          setState({
            ready: true,
            error: null,
            errorCode: null,
            warning: null,
            userId: user.id,
            initDataRaw: null,
          });
        })
        .catch((err: Error & { code?: string }) => {
          // wtoken оказался битым/протухшим — не оставляем его в памяти,
          // иначе любой последующий fetch уйдёт со сломанным Authorization
          // и получит шумные 401 поверх уже показанного error-экрана.
          if (err.code !== "USER_NOT_FOUND") clearWebToken();
          setState({
            ready: false,
            error: err.code === "USER_NOT_FOUND" ? err.message : t("auth.tokenExpired"),
            errorCode: err.code ?? null,
            warning: null,
            userId: null,
            initDataRaw: null,
          });
        });
      return;
    }

    // No wtoken — poll for initData (inline keyboard webApp buttons inject it normally)
    let elapsed = 0;
    let cancelled = false;
    let warned = false;
    let authInProgress = false;

    const poll = () => {
      if (cancelled) return;

      const tg = getTgWebApp();
      const raw = tg?.initData ?? "";

      if (raw && !authInProgress) {
        authInProgress = true;
        setInitDataRaw(raw);
        api.auth
          .verify(raw)
          .then((user) => {
            if (!cancelled) {
              setState({
                ready: true,
                error: null,
                errorCode: null,
                warning: null,
                userId: user.id,
                initDataRaw: raw,
              });
            }
          })
          .catch((err: Error & { code?: string }) => {
            if (!cancelled) {
              setState({
                ready: false,
                error: err.message,
                errorCode: err.code ?? null,
                warning: null,
                userId: null,
                initDataRaw: raw,
              });
            }
          });
        return;
      }

      if (!warned && elapsed >= WARN_AFTER_MS) {
        warned = true;
        setState((prev) => ({ ...prev, warning: t("auth.openFromTelegram") }));
      }

      elapsed += POLL_INTERVAL_MS;
      setTimeout(poll, POLL_INTERVAL_MS);
    };

    poll();

    return () => {
      cancelled = true;
    };
  }, []); // t is stable (never changes after mount)

  return state;
}
