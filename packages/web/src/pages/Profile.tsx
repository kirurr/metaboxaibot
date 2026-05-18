import { useTranslation } from "react-i18next";
import { useAuthStore } from "@/stores/authStore";
import { formatTokens, fullName, initials, parseTokens } from "@/utils/format";

export default function Profile() {
  const { t } = useTranslation();
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
        </div>

        <div className="col" style={{ gap: 18 }}>
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
    </div>
  );
}
