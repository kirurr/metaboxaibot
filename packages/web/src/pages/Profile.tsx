import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, History, Send, X } from "lucide-react";
import { useAuthStore } from "@/stores/authStore";
import * as authApi from "@/api/auth";
import { formatTokens, fullName, initials, parseTokens } from "@/utils/format";

/**
 * Профиль. Если Telegram не привязан — показываем кнопку «Привязать Telegram»,
 * которая открывает попап с deep-link на бота `/start linkweb_<state>`.
 * Параллельно poll'им status, и как только бот закрыл state — обновляем сессию
 * через me() (там бэк уже свяжет AI Box User с metabox-юзером).
 */
export default function Profile() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const tryRefresh = useAuthStore((s) => s.tryRefresh);

  const displayName = user ? fullName(user.firstName, user.lastName, user.email) : "—";
  const displayEmail = user?.email ?? "—";
  const displayInitials = user ? initials(user.firstName, user.lastName, user.email) : "··";
  const purchasedBalance = formatTokens(user?.tokenBalance ?? "0");
  const subscriptionBalance = formatTokens(user?.subscriptionTokenBalance ?? "0");
  const totalBalance = user
    ? formatTokens(
        String(parseTokens(user.tokenBalance) + parseTokens(user.subscriptionTokenBalance)),
      )
    : "0";

  // Telegram link modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [linkState, setLinkState] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPoll = useCallback(
    (state: string) => {
      stopPoll();
      pollRef.current = setInterval(async () => {
        try {
          const status = await authApi.linkTelegramStatus(state);
          if (status.linked) {
            stopPoll();
            // Refresh JWT — он мог не содержать aibUserId до linkweb'а.
            // После refresh'а ensureAibUserForMetabox синкнёт нужное.
            await tryRefresh();
            try {
              const { user: refreshedUser } = await authApi.me();
              setUser(refreshedUser);
            } catch {
              /* ignore */
            }
            setModalOpen(false);
          }
        } catch {
          /* молча игнорируем — следующая итерация попробует снова */
        }
      }, 3000);
    },
    [stopPoll, tryRefresh, setUser],
  );

  // Запуск flow при открытии модалки.
  useEffect(() => {
    if (!modalOpen) {
      stopPoll();
      setDeepLink(null);
      setLinkState(null);
      setLinkError(null);
      return;
    }
    setLinkLoading(true);
    setLinkError(null);
    authApi
      .linkTelegramInit()
      .then((res) => {
        setDeepLink(res.deepLinkUrl);
        setLinkState(res.state);
        startPoll(res.state);
      })
      .catch(() => setLinkError(t("profile.telegramLink.error")))
      .finally(() => setLinkLoading(false));
    return () => stopPoll();
  }, [modalOpen, startPoll, stopPoll, t]);

  // Close on Escape
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModalOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1 className="h1">{t("profile.title")}</h1>
          <p className="sub">{t("profile.subtitle")}</p>
        </div>
      </div>

      <div className="two-col rise d1">
        <div className="card" style={{ padding: 26 }}>
          <h3 className="section-title">{t("profile.sectionAccount")}</h3>
          <div className="row" style={{ gap: 18, marginBottom: 12 }}>
            <div className="avatar lg">{displayInitials}</div>
            <div>
              <div style={{ fontWeight: 600 }}>{displayName}</div>
              <div className="muted" style={{ fontSize: 13 }}>
                {displayEmail}
              </div>
            </div>
          </div>
          <div className="divider" style={{ margin: "12px 0 4px" }} />
          <div className="field-row">
            <span className="lbl">{t("profile.firstName")}</span>
            <span className="val">{user?.firstName?.trim() || "—"}</span>
            <span />
          </div>
          <div className="field-row">
            <span className="lbl">{t("profile.lastName")}</span>
            <span className="val">{user?.lastName?.trim() || "—"}</span>
            <span />
          </div>
          <div className="field-row">
            <span className="lbl">{t("profile.email")}</span>
            <span className="val">{displayEmail}</span>
            <span />
          </div>
          <div className="field-row">
            <span className="lbl">{t("profile.telegram")}</span>
            <span className="val">
              {user?.isTelegramLinked
                ? user.telegramUsername
                  ? `@${user.telegramUsername}`
                  : `id ${user.telegramId}`
                : t("profile.telegramNotLinked")}
            </span>
            {user?.isTelegramLinked ? (
              <span className="chip success">{t("profile.telegramLinked")}</span>
            ) : (
              <span className="chip warning">{t("profile.telegramNotLinkedChip")}</span>
            )}
          </div>
          {!user?.isTelegramLinked && (
            <div style={{ marginTop: 14 }}>
              <button
                className="btn btn-primary"
                onClick={() => setModalOpen(true)}
                style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
              >
                <Send size={14} />
                {t("profile.telegramLink.cta")}
              </button>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
                {t("profile.telegramLink.hint")}
              </div>
            </div>
          )}
        </div>

        <div className="col" style={{ gap: 18 }}>
          <div className="card" style={{ padding: 22 }}>
            <h3 className="section-title">{t("nav.history")}</h3>
            <Link
              to="/history"
              className="btn btn-primary"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                marginTop: 8,
              }}
            >
              <History size={14} />
              {t("home.allHistory")}
              <ArrowRight size={14} />
            </Link>
          </div>
          <div className="card" style={{ padding: 22 }}>
            <h3 className="section-title">{t("profile.sectionBalance")}</h3>
            <div className="field-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <div>
                <div style={{ fontSize: 14 }}>{t("profile.balanceTotal")}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {t("profile.balanceTotalHint")}
                </div>
              </div>
              <span className="mono" style={{ fontWeight: 600, fontSize: 18 }}>
                {totalBalance}
              </span>
            </div>
            <div className="field-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <div>
                <div style={{ fontSize: 14 }}>{t("profile.balancePurchased")}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {t("profile.balancePurchasedHint")}
                </div>
              </div>
              <span className="mono">{purchasedBalance}</span>
            </div>
            <div className="field-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <div>
                <div style={{ fontSize: 14 }}>{t("profile.balanceSubscription")}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {t("profile.balanceSubscriptionHint")}
                </div>
              </div>
              <span className="mono">{subscriptionBalance}</span>
            </div>
          </div>
        </div>
      </div>

      {modalOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="fixed inset-0"
            style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
          />
          <div
            className="relative card p-6 w-full"
            style={{ background: "var(--bg-elevated)", maxWidth: 420, zIndex: 1 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="absolute top-4 right-4 text-text-hint hover:text-text"
              aria-label={t("common.close")}
              style={{ background: "none", border: 0 }}
            >
              <X size={18} />
            </button>
            <div className="text-center">
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: "50%",
                  background: "rgba(42,171,238,0.15)",
                  margin: "0 auto 12px",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Send size={24} color="#2AABEE" />
              </div>
              <h3 className="h3" style={{ fontWeight: 700, marginBottom: 6 }}>
                {t("profile.telegramLink.modalTitle")}
              </h3>
              <p className="muted" style={{ fontSize: 13.5 }}>
                {t("profile.telegramLink.modalIntro")}
              </p>
              <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                {t("profile.telegramLink.modalSteps")}
              </p>
            </div>

            {linkError && (
              <p
                style={{ color: "var(--danger)", fontSize: 13, textAlign: "center", marginTop: 10 }}
              >
                {linkError}
              </p>
            )}

            {linkLoading ? (
              <div style={{ marginTop: 18, display: "flex", justifyContent: "center" }}>
                <div className="spinner" />
              </div>
            ) : deepLink ? (
              <a
                href={deepLink}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
                style={{
                  marginTop: 16,
                  width: "100%",
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  gap: 8,
                  background: "#2AABEE",
                  color: "#fff",
                }}
              >
                <Send size={14} />
                {t("profile.telegramLink.openBot")}
              </a>
            ) : null}

            {deepLink && linkState && (
              <p
                style={{
                  fontSize: 12,
                  textAlign: "center",
                  marginTop: 12,
                  color: "var(--text-hint)",
                }}
              >
                {t("profile.telegramLink.waiting")}
              </p>
            )}

            <button
              className="btn btn-ghost"
              onClick={() => setModalOpen(false)}
              style={{ marginTop: 10, width: "100%" }}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
