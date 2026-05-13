import { NavLink } from "react-router-dom";
import { GraduationCap, Home, Image as ImageIcon, Sparkles, User } from "lucide-react";
import clsx from "clsx";

type NavItem = {
  to: string;
  label: string;
  icon: typeof Home;
  center?: boolean;
};

const items: NavItem[] = [
  { to: "/", label: "Главная", icon: Home },
  { to: "/history", label: "Галерея", icon: ImageIcon },
  { to: "/tokens", label: "Генерировать", icon: Sparkles, center: true },
  { to: "/plans", label: "Обучение", icon: GraduationCap },
  { to: "/profile", label: "Профиль", icon: User },
];

export function BottomNav() {
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
              <span>{n.label}</span>
            </>
          ) : (
            <>
              <n.icon size={20} />
              <span>{n.label}</span>
              <span className="dot" />
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
