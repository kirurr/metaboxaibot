import { NavLink, useNavigate } from "react-router-dom";

export function MobileTop() {
  const navigate = useNavigate();

  return (
    <div className="mobile-top">
      <NavLink to="/app/chat" className="tn-brand">
        <div className="logo-mark">A</div>
        <span className="brand-text">AI Box</span>
      </NavLink>
      <div className="tn-right">
        <button
          className="tn-balance"
          style={{ padding: "0 10px 0 12px" }}
          onClick={() => navigate("/app/tokens")}
        >
          <span className="b-dot" />
          <span className="b-val mono">28,450</span>
        </button>
        <button
          className="account-btn"
          style={{ padding: 2 }}
          onClick={() => navigate("/app/profile")}
        >
          <div className="avatar">AM</div>
        </button>
      </div>
    </div>
  );
}
