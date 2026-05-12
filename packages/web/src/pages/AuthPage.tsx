import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, Eye, EyeOff, Lock, Mail, User as UserIcon } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useAuthStore } from "@/stores/authStore";
import * as authApi from "@/api/auth";
import { ApiError } from "@/api/client";

type Props = { initialMode?: "login" | "signup" };

/**
 * Дизайн из заглушки `aibox_template`, форма — реальная: дергает
 * `/auth/web-login` / `/auth/web-signup`, ставит сессию через `authStore.setSession`.
 * После успеха возвращает на `?from=` либо в `/app`. Для админов это значит
 * автоматический редирект на `/admin` (т.к. они приходят сюда из `AdminRoute` с `from`).
 */
export default function AuthPage({ initialMode = "login" }: Props) {
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

  async function submit() {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const session =
        mode === "login"
          ? await authApi.login({
              email: email.trim().toLowerCase(),
              password: pw,
              rememberMe: true,
            })
          : await authApi.signup({
              email: email.trim().toLowerCase(),
              password: pw,
              firstName: name.trim() || email.split("@")[0],
            });
      setSession(session);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from.startsWith("/") ? from : "/app", { replace: true });
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError(
          mode === "login"
            ? "Не удалось войти. Проверьте email и пароль."
            : "Не удалось создать аккаунт. Попробуйте позже.",
        );
      }
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
            A calmer way to work with intelligence.
          </h1>
          <p className="sub">
            Pay for what you use. Eight frontier models. One quiet, focused workspace built for
            people who do real work.
          </p>
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

          <h2 className="h2">{mode === "login" ? "Welcome back." : "Create your account."}</h2>
          <p className="sub">
            {mode === "login"
              ? "Sign in to continue your conversation."
              : "Start with 50,000 free tokens. No card required."}
          </p>

          <div className="auth-tab">
            <button
              className={mode === "login" ? "on" : ""}
              onClick={() => {
                setMode("login");
                setError(null);
              }}
            >
              Sign in
            </button>
            <button
              className={mode === "signup" ? "on" : ""}
              onClick={() => {
                setMode("signup");
                setError(null);
              }}
            >
              Create account
            </button>
          </div>

          {mode === "signup" && (
            <div className="field-block">
              <span className="lbl">Full name</span>
              <div className="input-group">
                <span className="leading-icon">
                  <UserIcon size={16} />
                </span>
                <input
                  className="input"
                  placeholder="Ada Lovelace"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
              </div>
            </div>
          )}
          <div className="field-block">
            <span className="lbl">Email</span>
            <div className="input-group">
              <span className="leading-icon">
                <Mail size={16} />
              </span>
              <input
                className="input"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>
          </div>
          <div className="field-block">
            <span className="lbl row between" style={{ display: "flex" }}>
              <span>Password</span>
              {mode === "login" && (
                <a
                  className="hint"
                  style={{ fontSize: 12, cursor: "pointer" }}
                  onClick={() => navigate("/forgot-password")}
                >
                  Forgot?
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
                ? "Signing in…"
                : "Creating…"
              : mode === "login"
                ? "Sign in"
                : "Create account"}{" "}
            {!busy && <ArrowRight size={16} />}
          </button>

          <div className="oauth-sep">or continue with</div>
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
            By continuing you agree to our Terms &amp; Privacy. Data never used for training.
          </p>
        </div>
      </div>
    </div>
  );
}
