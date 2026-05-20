import { useState, useEffect } from "react";
import { useTelegramInit } from "./hooks/useTelegramInit.js";
import { BottomNav } from "./components/BottomNav.js";
import { ProfilePage, type ProfileTab } from "./pages/ProfilePage.js";
import { ManagementPage } from "./pages/ManagementPage.js";
import { TariffsPage } from "./pages/TariffsPage.js";
import { ReferralPage } from "./pages/ReferralPage.js";
import { AdminPage } from "./pages/AdminPage.js";
import { LinkMetaboxPage, type LinkMetaboxReason } from "./pages/LinkMetaboxPage.js";
import { DownloadRedirectPage } from "./pages/DownloadRedirectPage.js";
import { I18nProvider, useI18n } from "./i18n.js";
import { AiboxLogo } from "./components/AiboxLogo.js";
import { api } from "./api/client.js";
import { closeMiniApp } from "./utils/telegram.js";
import type { Page, UserProfile } from "./types.js";

function parseHash(): { page: Page; section?: string; action?: string } {
  const validPages: Page[] = ["profile", "management", "tariffs", "referral", "admin"];
  // Prefer query params (?page=...) — avoids conflict with Telegram's #tgWebAppData hash injection
  const params = new URLSearchParams(window.location.search);
  const qPage = params.get("page");
  const qSection = params.get("section") ?? undefined;
  const qAction = params.get("action") ?? undefined;
  if (qPage && validPages.includes(qPage as Page)) {
    return { page: qPage as Page, section: qSection, action: qAction };
  }
  // Fallback: legacy hash routing (#page or #page/section)
  const [pagePart, sectionPart] = window.location.hash.slice(1).split("/");
  const page = validPages.includes(pagePart as Page) ? (pagePart as Page) : "profile";
  return { page, section: sectionPart };
}

function LangPicker() {
  const { locale, setLocale } = useI18n();
  return (
    <div className="lang-picker">
      <button
        className={`lang-picker__btn${locale === "en" ? " lang-picker__btn--active" : ""}`}
        onClick={() => setLocale("en")}
      >
        EN
      </button>
      <button
        className={`lang-picker__btn${locale === "ru" ? " lang-picker__btn--active" : ""}`}
        onClick={() => setLocale("ru")}
      >
        RU
      </button>
    </div>
  );
}

function AppContent() {
  const initial = parseHash();
  const [page, setPage] = useState<Page>(initial.page);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [managementTarget, setManagementTarget] = useState<{
    section: string;
    modelId: string;
  } | null>(null);
  // Контекст редиректа на LinkMetaboxPage. Дефолт "learning" для legacy-вызовов
  // (handleLearning из BottomNav). Tariffs/Referral передают свои значения.
  const [linkMetaboxReason, setLinkMetaboxReason] = useState<LinkMetaboxReason>("learning");
  const goToLinkMetabox = (reason: LinkMetaboxReason): void => {
    setLinkMetaboxReason(reason);
    setPage("linkMetabox");
  };
  const { ready, error, errorCode, warning } = useTelegramInit();
  const { t } = useI18n();

  useEffect(() => {
    if (ready) {
      api.profile.get().then(setProfile).catch(console.error);
    }
  }, [ready]);

  const isAdmin = profile?.role === "ADMIN" || profile?.role === "MODERATOR";

  const navigate = (p: Page) => {
    if (p === "management") setManagementTarget(null);
    setPage(p);
  };

  const goToManagement = (section: string, modelId: string) => {
    setManagementTarget({ section, modelId });
    setPage("management");
  };

  const handleLearning = async () => {
    // Refresh profile to check if metaboxUserId is still valid
    try {
      const fresh = await api.profile.get();
      setProfile(fresh);
      if (fresh?.metaboxUserId) {
        const result = await api.profile.metaboxSso();
        // Если email на сайте ещё не подтверждён — backend возвращает
        // requiresVerification вместо ssoUrl. Показываем pending-экран
        // в LinkMetaboxPage [он сам подтянет статус через metaboxStatus].
        if ("requiresVerification" in result && result.requiresVerification) {
          goToLinkMetabox("learning");
          return;
        }
        if ("ssoUrl" in result && result.ssoUrl) {
          const tg = (
            window as Window & { Telegram?: { WebApp?: { openLink?: (u: string) => void } } }
          ).Telegram?.WebApp;
          if (tg?.openLink) tg.openLink(result.ssoUrl);
          else window.open(result.ssoUrl, "_blank");
          return;
        }
      }
    } catch {
      // SSO failed or profile refresh failed
    }
    goToLinkMetabox("learning");
  };

  if (error) {
    const botUsername = import.meta.env.VITE_BOT_USERNAME as string | undefined;
    const openBotWith = (startPayload: string) => {
      if (!botUsername) return;
      const url = `https://t.me/${botUsername}?start=${startPayload}`;
      const tg = (
        window as Window & { Telegram?: { WebApp?: { openTelegramLink?: (u: string) => void } } }
      ).Telegram?.WebApp;
      if (tg?.openTelegramLink) tg.openTelegramLink(url);
      else window.open(url, "_blank");
      // Закрываем mini-app — дальнейший flow идёт в боте.
      closeMiniApp();
    };

    // USER_NOT_FOUND — юзер открыл mini-app до регистрации в боте (или после
    // удаления аккаунта). Блокируем UI, объясняем что нужно нажать /start
    // в боте, и даём deep-link на бота.
    if (errorCode === "USER_NOT_FOUND") {
      return (
        <div className="splash">
          <div className="splash__icon">👋</div>
          <div className="splash__title">{t("auth.notRegisteredTitle")}</div>
          <div className="splash__text">{t("auth.notRegisteredText")}</div>
          {botUsername && (
            <button
              className="btn btn--primary splash__cta"
              onClick={() => openBotWith("fromminiapp")}
            >
              {t("auth.openBot")}
            </button>
          )}
        </div>
      );
    }

    // TOKEN_EXPIRED — wtoken в URL пережил soft TTL (30д с последнего refresh'а)
    // или absolute cap (90д с issuance). TOKEN_INVALID — битый формат / подпись:
    // на практике у юзера такой же flow восстановления (тапнуть Профиль ещё раз),
    // поэтому показываем тот же экран, чтобы не плодить три копии UI.
    if (errorCode === "TOKEN_EXPIRED" || errorCode === "TOKEN_INVALID") {
      return (
        <div className="splash">
          <div className="splash__icon">⚠️</div>
          <div className="splash__title">{t("auth.tokenExpiredTitle")}</div>
          <div className="splash__text">{t("auth.tokenExpiredText")}</div>
          {botUsername && (
            <button
              className="btn btn--primary splash__cta"
              onClick={() => openBotWith("refresh_menu")}
            >
              {t("auth.refreshMenu")}
            </button>
          )}
        </div>
      );
    }

    return (
      <div className="splash">
        <div className="splash__icon">⚠️</div>
        <div className="splash__text">{error}</div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="splash">
        <div className="splash__icon">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <defs>
              <linearGradient id="sg" x1="0" y1="0" x2="48" y2="48">
                <stop offset="0%" stopColor="#5A9DF7" />
                <stop offset="100%" stopColor="#3A7DE5" />
              </linearGradient>
            </defs>
            <rect x="4" y="4" width="40" height="40" rx="12" fill="url(#sg)" />
            <path
              d="M16 24l6 6 10-12"
              stroke="#fff"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
        </div>
        <div className="splash__text">{t("common.loading")}</div>
        {warning && <div className="splash__warning">{warning}</div>}
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <AiboxLogo className="app-header__logo" />
        <div className="app-header__right">
          <LangPicker />
        </div>
      </header>

      <main className="app-main">
        {page === "profile" && (
          <ProfilePage
            initialSection={
              initial.section && ["overview", "gallery", "settings"].includes(initial.section)
                ? (initial.section as ProfileTab)
                : undefined
            }
            onGoToManagement={goToManagement}
          />
        )}
        {page === "management" && (
          <ManagementPage
            initialSection={managementTarget?.section ?? initial.section}
            initialModelId={managementTarget?.modelId}
            initialAction={initial.action}
            finishedOnboarding={profile?.finishedOnboarding ?? true}
          />
        )}
        {page === "tariffs" && (
          <TariffsPage profile={profile} onLinkMetabox={() => goToLinkMetabox("subscription")} />
        )}
        {page === "referral" && (
          <ReferralPage onLinkMetabox={() => goToLinkMetabox("withdrawal")} />
        )}
        {page === "admin" && <AdminPage />}
        {page === "linkMetabox" && (
          <LinkMetaboxPage
            firstName={profile?.firstName}
            username={profile?.username}
            reason={linkMetaboxReason}
            onBack={() => setPage("profile")}
            onSuccess={() => api.profile.get().then(setProfile).catch(console.error)}
          />
        )}
      </main>

      {page !== "linkMetabox" && (
        <BottomNav
          current={page}
          onChange={navigate}
          showAdmin={isAdmin}
          onLearning={() => void handleLearning()}
        />
      )}
    </div>
  );
}

export function App() {
  // Bridge route: Telegram inline `web_app:` buttons land here so the
  // mini-app can call `Telegram.WebApp.openLink(...)` (the only way to
  // trigger a real download from inside the WebView). Short-circuits the
  // normal app shell (no auth, no nav, no API calls).
  const params = new URLSearchParams(window.location.search);
  if (params.get("page") === "download") {
    return (
      <I18nProvider>
        <DownloadRedirectPage token={params.get("token") ?? ""} />
      </I18nProvider>
    );
  }

  return (
    <I18nProvider>
      <AppContent />
    </I18nProvider>
  );
}
