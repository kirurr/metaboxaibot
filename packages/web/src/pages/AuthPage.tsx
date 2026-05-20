import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, Eye, EyeOff, Lock, Mail, User as UserIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useAuthStore } from "@/stores/authStore";
import * as authApi from "@/api/auth";
import { ApiError } from "@/api/client";

type Props = { initialMode?: "login" | "signup" };

/**
 * Дизайн из заглушки `aibox_template`, форма — реальная: дергает
 * `/auth/web-login` / `/auth/web-signup`, ставит сессию через `authStore.setSession`.
 * После успеха возвращает на `?from=` либо на главную (`/`). Для админов это значит
 * автоматический редирект на `/admin` (т.к. они приходят сюда из `AdminRoute` с `from`).
 */
export default function AuthPage({ initialMode = "login" }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const setSession = useAuthStore((s) => s.setSession);

  const [mode, setMode] = useState<"login" | "signup">(initialMode);
  const [showPw, setShowPw] = useState(false);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // pendingVerification — после signup в prod-режиме metabox шлёт письмо
  // подтверждения, сессия НЕ выдаётся. Вместо формы показываем «проверьте
  // почту» с CTA вернуться на login и кнопкой «отправить повторно».
  const [pendingVerification, setPendingVerification] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        const session = await authApi.login({
          email: email.trim().toLowerCase(),
          password: pw,
          rememberMe: true,
        });
        setSession(session);
        const from = (location.state as { from?: string } | null)?.from;
        navigate(from && from.startsWith("/") ? from : "/", { replace: true });
      } else {
        const result = await authApi.signup({
          email: email.trim().toLowerCase(),
          password: pw,
          firstName: name.trim() || email.split("@")[0],
        });
        if ("requiresVerification" in result && result.requiresVerification) {
          // Прод-режим: письмо ушло, auto-login не делаем. Юзер получает
          // экран «проверьте почту» и должен подтвердить email перед login'ом.
          setPendingVerification(result.email);
        } else {
          // Stage / autoverify ветка — auto-login. TS-narrowing через guard:
          // в else мы знаем что requiresVerification отсутствует/false → result
          // имеет форму AuthSession.
          setSession(result as Exclude<typeof result, { requiresVerification: true }>);
          const from = (location.state as { from?: string } | null)?.from;
          navigate(from && from.startsWith("/") ? from : "/", { replace: true });
        }
      }
    } catch (e) {
      if (e instanceof ApiError) {
        // EMAIL_NOT_VERIFIED при login — фронт не должен показывать сухую
        // ошибку; перекидываем на тот же «проверьте почту» экран что и
        // signup, чтобы юзер мог кликнуть resend.
        if (e.code === "EMAIL_NOT_VERIFIED") {
          const details = e.details as { email?: string } | undefined;
          setPendingVerification(details?.email ?? email.trim().toLowerCase());
        } else {
          setError(e.message);
        }
      } else {
        setError(mode === "login" ? t("auth.loginError") : t("auth.signupError"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    if (!pendingVerification || busy) return;
    setBusy(true);
    setError(null);
    try {
      await authApi.resendVerification(pendingVerification);
    } catch (e) {
      // Невидим юзеру — UX-сообщение «мы попробовали ещё раз» прячется в toast'е;
      // сюда выводим только если совсем что-то сломалось.
      if (e instanceof ApiError) setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") submit();
  }

  return (
    <div className={"auth-shell" + (isMobile ? " mobile" : "")}>
      <div className="auth-hero">
        <div className="row" style={{ gap: 10, position: "relative" }}>
          <div className="logo-mark">A</div>
          <span className="brand-text" style={{ fontSize: 19 }}>
            AI Box
          </span>
        </div>
        <div className="grid-bg" />
        <div className="rise">
          <h1
            className="h1"
            style={{
              background: "linear-gradient(120deg, #f0f0f5 0%, #6ba3f7 100%)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            {t("auth.heroTitle")}
          </h1>
          <p className="sub">{t("auth.heroSubtitle")}</p>
        </div>
        <div className="quote rise d2">
          <div className="q">
            “Finally a chat app I can keep open all day without it screaming for attention. It just
            helps.”
          </div>
          <div className="a">— Lena R., Product Lead at Northbound</div>
        </div>
      </div>

      <div className="auth-form-wrap">
        <div className="auth-form rise">
          <div className="auth-brand">
            <div className="logo-mark">A</div>
            <span className="brand-text" style={{ fontSize: 20 }}>
              AI Box
            </span>
          </div>

          <h2 className="h2">
            {pendingVerification
              ? t("auth.checkEmail")
              : mode === "login"
                ? t("auth.welcomeBack")
                : t("auth.createAccount")}
          </h2>
          <p className="sub">
            {pendingVerification
              ? t("auth.checkEmailHint", { email: pendingVerification })
              : mode === "login"
                ? t("auth.loginHint")
                : t("auth.signupHint")}
          </p>

          {pendingVerification ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <button
                className="btn btn-primary"
                onClick={() => void resendVerification()}
                disabled={busy}
              >
                {t("auth.resendVerification")}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setPendingVerification(null);
                  setMode("login");
                  setPw("");
                  setError(null);
                }}
                disabled={busy}
              >
                {t("auth.backToLogin")}
              </button>
            </div>
          ) : (
            <>
              <div className="auth-tab">
                <button
                  className={mode === "login" ? "on" : ""}
                  onClick={() => {
                    setMode("login");
                    setError(null);
                  }}
                >
                  {t("auth.signIn")}
                </button>
                <button
                  className={mode === "signup" ? "on" : ""}
                  onClick={() => {
                    setMode("signup");
                    setError(null);
                  }}
                >
                  {t("auth.createAccountBtn")}
                </button>
              </div>

              {mode === "signup" && (
                <div className="field-block">
                  <span className="lbl">{t("auth.fullName")}</span>
                  <div className="input-group">
                    <span className="leading-icon">
                      <UserIcon size={16} />
                    </span>
                    <input
                      className="input"
                      placeholder={t("auth.fullNamePlaceholder")}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={handleKeyDown}
                    />
                  </div>
                </div>
              )}
              <div className="field-block">
                <span className="lbl">{t("auth.email")}</span>
                <div className="input-group">
                  <span className="leading-icon">
                    <Mail size={16} />
                  </span>
                  <input
                    className="input"
                    type="email"
                    autoComplete="email"
                    placeholder={t("auth.emailPlaceholder")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={handleKeyDown}
                  />
                </div>
              </div>
              <div className="field-block">
                <span className="lbl row between" style={{ display: "flex" }}>
                  <span>{t("auth.password")}</span>
                  {mode === "login" && (
                    <a
                      className="hint"
                      style={{ fontSize: 12, cursor: "pointer" }}
                      onClick={() => navigate("/forgot-password")}
                    >
                      {t("auth.forgot")}
                    </a>
                  )}
                </span>
                <div className="input-group">
                  <span className="leading-icon">
                    <Lock size={16} />
                  </span>
                  <input
                    className="input"
                    type={showPw ? "text" : "password"}
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    placeholder="••••••••"
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                    onKeyDown={handleKeyDown}
                    style={{ paddingRight: 44 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(!showPw)}
                    style={{
                      position: "absolute",
                      right: 10,
                      top: "50%",
                      transform: "translateY(-50%)",
                      width: 28,
                      height: 28,
                      display: "grid",
                      placeItems: "center",
                      color: "var(--text-hint)",
                      borderRadius: 6,
                    }}
                  >
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {error && (
                <div
                  style={{
                    background: "var(--danger-bg)",
                    color: "var(--danger)",
                    borderLeft: "3px solid var(--danger)",
                    borderRadius: "var(--radius-sm)",
                    padding: "10px 12px",
                    fontSize: 13,
                    marginBottom: 12,
                  }}
                >
                  {error}
                </div>
              )}

              <button
                className="btn btn-primary"
                style={{ width: "100%", marginTop: 8 }}
                onClick={submit}
                disabled={busy}
              >
                {busy
                  ? mode === "login"
                    ? t("auth.signingIn")
                    : t("auth.creating")
                  : mode === "login"
                    ? t("auth.signIn")
                    : t("auth.createAccountBtn")}{" "}
                {!busy && <ArrowRight size={16} />}
              </button>

              <div className="oauth-sep">{t("auth.orContinueWith")}</div>
              <div className="oauth-row">
                <button className="btn btn-secondary" style={{ flex: 1 }} disabled>
                  Google
                </button>
                <button className="btn btn-secondary" style={{ flex: 1 }} disabled>
                  Apple
                </button>
                <button className="btn btn-secondary" style={{ flex: 1 }} disabled>
                  GitHub
                </button>
              </div>

              <p className="hint" style={{ marginTop: 24, fontSize: 12, textAlign: "center" }}>
                {t("auth.termsHint")}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
