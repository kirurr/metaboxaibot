import { NavLink } from "react-router-dom";
import { GraduationCap, Home, Image as ImageIcon, Sparkles, User } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";

type NavItem = {
  to: string;
  /** i18n-ключ для подписи (резолвится в рендере). */
  labelKey: string;
  icon: typeof Home;
  center?: boolean;
};

const items: NavItem[] = [
  { to: "/", labelKey: "nav.bottom.home", icon: Home },
  { to: "/history", labelKey: "nav.bottom.gallery", icon: ImageIcon },
  { to: "/tokens", labelKey: "nav.bottom.generate", icon: Sparkles, center: true },
  { to: "/plans", labelKey: "nav.bottom.learn", icon: GraduationCap },
  { to: "/profile", labelKey: "nav.bottom.profile", icon: User },
];

export function BottomNav() {
  const { t } = useTranslation();
  return (
    <nav className="bottom-nav">
      {items.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          // `end` нужен только для корня (`/`), иначе NavLink считал бы Главную
          // активной на любой вложенной странице (т.к. `/` — родитель всех).
          end={n.to === "/"}
          className={({ isActive }) =>
            clsx("bn-item", n.center && "bn-center", isActive && "active")
          }
        >
          {n.center ? (
            <>
              <span className="bn-fab">
                <n.icon size={22} />
              </span>
              <span>{t(n.labelKey)}</span>
            </>
          ) : (
            <>
              <n.icon size={20} />
              <span>{t(n.labelKey)}</span>
              <span className="dot" />
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
