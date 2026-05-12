import { ChevronDown, Download, Trash2 } from "lucide-react";
import { useAuthStore } from "@/stores/authStore";
import { formatTokens, fullName, initials, parseTokens } from "@/utils/format";

export default function Profile() {
  const user = useAuthStore((s) => s.user);

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

  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1 className="h1">Profile</h1>
          <p className="sub">How you appear inside AI Box and how the product behaves for you.</p>
        </div>
      </div>

      <div className="two-col rise d1">
        <div className="card" style={{ padding: 26 }}>
          <h3 className="section-title">Account</h3>
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
            <span className="lbl">First name</span>
            <span className="val">{user?.firstName?.trim() || "—"}</span>
            <span />
          </div>
          <div className="field-row">
            <span className="lbl">Last name</span>
            <span className="val">{user?.lastName?.trim() || "—"}</span>
            <span />
          </div>
          <div className="field-row">
            <span className="lbl">Email</span>
            <span className="val">{displayEmail}</span>
            <span />
          </div>
          <div className="field-row">
            <span className="lbl">Telegram</span>
            <span className="val">
              {user?.isTelegramLinked
                ? user.telegramUsername
                  ? `@${user.telegramUsername}`
                  : `id ${user.telegramId}`
                : "Не привязан"}
            </span>
            {user?.isTelegramLinked ? (
              <span className="chip success">Linked</span>
            ) : (
              <span className="chip warning">Not linked</span>
            )}
          </div>
        </div>

        <div className="col" style={{ gap: 18 }}>
          <div className="card" style={{ padding: 22 }}>
            <h3 className="section-title">Balance</h3>
            <div className="field-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <div>
                <div style={{ fontSize: 14 }}>Всего токенов</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  Купленные + по подписке
                </div>
              </div>
              <span className="mono" style={{ fontWeight: 600, fontSize: 18 }}>
                {totalBalance}
              </span>
            </div>
            <div className="field-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <div>
                <div style={{ fontSize: 14 }}>Купленные</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  Не сгорают
                </div>
              </div>
              <span className="mono">{purchasedBalance}</span>
            </div>
            <div className="field-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <div>
                <div style={{ fontSize: 14 }}>По подписке</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  Списываются при истечении периода
                </div>
              </div>
              <span className="mono">{subscriptionBalance}</span>
            </div>
          </div>

          <div className="card" style={{ padding: 22 }}>
            <h3 className="section-title">Preferences</h3>
            <div className="field-row" style={{ gridTemplateColumns: "1fr auto" }}>
              <div>
                <div style={{ fontSize: 14 }}>Response language</div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  AI replies in this language by default
                </div>
              </div>
              <div className="model-picker">
                {user?.language === "en" ? "English" : "Русский"} <ChevronDown size={14} />
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 22 }}>
            <h3 className="section-title">Data &amp; privacy</h3>
            <p className="muted" style={{ fontSize: 13.5, margin: "0 0 14px" }}>
              Your conversations are never used to train models. Export or delete everything any
              time.
            </p>
            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="btn btn-secondary btn-sm">
                <Download size={14} /> Export data
              </button>
              <button className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }}>
                <Trash2 size={14} /> Delete account
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
