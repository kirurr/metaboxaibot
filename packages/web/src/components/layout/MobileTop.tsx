import { NavLink, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import { formatTokens, initials, parseTokens } from "@/utils/format";

export function MobileTop() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  const totalBalanceRaw = user
    ? String(parseTokens(user.tokenBalance) + parseTokens(user.subscriptionTokenBalance))
    : "0";
  const displayBalance = formatTokens(totalBalanceRaw);
  const displayInitials = user ? initials(user.firstName, user.lastName, user.email) : "··";

  return (
    <div className="mobile-top">
      <NavLink to="/" className="tn-brand">
        <div className="logo-mark">A</div>
        <span className="brand-text">AI Box</span>
      </NavLink>
      <div className="tn-right">
        <button
          className="tn-balance"
          style={{ padding: "0 10px 0 12px" }}
          onClick={() => navigate("/tokens")}
        >
          <span className="b-dot" />
          <span className="b-val mono">{displayBalance}</span>
        </button>
        <button className="account-btn" style={{ padding: 2 }} onClick={() => navigate("/profile")}>
          <div className="avatar">{displayInitials}</div>
        </button>
      </div>
    </div>
  );
}
