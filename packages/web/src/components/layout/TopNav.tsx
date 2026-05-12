import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  CreditCard,
  History as HistoryIcon,
  Layers,
  LogOut,
  Plus,
  Settings,
  User,
} from "lucide-react";
import clsx from "clsx";
import { useAuthStore } from "@/stores/authStore";
import { formatTokens, fullName, initials, parseTokens } from "@/utils/format";

const CAPABILITIES = [
  { id: "text", label: "Text" },
  { id: "image", label: "Image" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
] as const;

type CapabilityId = (typeof CAPABILITIES)[number]["id"];

export function TopNav() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [capability, setCapability] = useState<CapabilityId>("text");
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Баланс: сумма покупного + подписочного — единая цифра, как у бота.
  const totalBalanceRaw = user
    ? String(parseTokens(user.tokenBalance) + parseTokens(user.subscriptionTokenBalance))
    : "0";
  const displayBalance = formatTokens(totalBalanceRaw);
  const displayName = user ? fullName(user.firstName, user.lastName, user.email) : "Гость";
  const displayInitials = user ? initials(user.firstName, user.lastName, user.email) : "··";
  const displayEmail = user?.email ?? "";
  const firstNameOnly =
    user?.firstName?.trim() ||
    (displayName.includes(" ") ? displayName.split(" ")[0] : displayName);

  return (
    <header className="topnav">
      <NavLink to="/app/chat" className="tn-brand" style={{ cursor: "pointer" }}>
        <div className="logo-mark">A</div>
        <span className="brand-text">AI Box</span>
      </NavLink>

      <div className="cap-tabs">
        {CAPABILITIES.map((c) => (
          <button
            key={c.id}
            className={clsx("cap", capability === c.id && "on")}
            onClick={() => setCapability(c.id)}
          >
            <span className="cap-dot" />
            <span>{c.label}</span>
          </button>
        ))}
      </div>

      <div className="tn-right">
        <button
          className="tn-balance"
          onClick={() => navigate("/app/tokens")}
          title="Tokens balance"
        >
          <span className="b-dot" />
          <span className="b-val mono">{displayBalance}</span>
          <span className="b-lbl">tokens</span>
          <span className="b-plus">
            <Plus size={12} />
          </span>
        </button>
        <button className="tn-icon-btn" title="Notifications">
          <Bell size={18} />
          <span className="pip" />
        </button>

        <div ref={menuRef} style={{ position: "relative" }}>
          <button className="account-btn" onClick={() => setOpen(!open)}>
            <div className="avatar">{displayInitials}</div>
            <span className="a-name">{firstNameOnly}</span>
            <ChevronDown size={14} />
          </button>
          {open && (
            <div className="menu-pop">
              <div className="menu-head">
                <div className="avatar">{displayInitials}</div>
                <div className="who">
                  <div className="name">{displayName}</div>
                  <div className="mail">{displayEmail}</div>
                </div>
              </div>
              <MenuLink to="/app/profile" icon={<User size={16} />} onSelect={() => setOpen(false)}>
                Profile
              </MenuLink>
              <MenuLink
                to="/app/billing"
                icon={<CreditCard size={16} />}
                onSelect={() => setOpen(false)}
              >
                Billing
              </MenuLink>
              <MenuLink to="/app/plans" icon={<Layers size={16} />} onSelect={() => setOpen(false)}>
                Plans
              </MenuLink>
              <MenuLink
                to="/app/history"
                icon={<HistoryIcon size={16} />}
                onSelect={() => setOpen(false)}
              >
                History
              </MenuLink>
              <div className="menu-sep" />
              <button className="menu-item">
                <Settings size={16} /> Settings <ChevronRight size={14} className="chev" />
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item danger"
                onClick={async () => {
                  setOpen(false);
                  await logout();
                  navigate("/login", { replace: true });
                }}
              >
                <LogOut size={16} /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function MenuLink({
  to,
  icon,
  children,
  onSelect,
}: {
  to: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <NavLink
      to={to}
      onClick={onSelect}
      className={({ isActive }) => clsx("menu-item", isActive && "active")}
    >
      {icon}
      {children}
      <ChevronRight size={14} className="chev" />
    </NavLink>
  );
}
