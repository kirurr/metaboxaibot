import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { GraduationCap, Home, Image as ImageIcon, Sparkles, User } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { GenerateSheet } from "@/components/layout/GenerateSheet";

/**
 * Мобильная нижняя нав-бар. 5 пунктов: Главная / Галерея / Генерировать /
 * Обучение / Профиль. Центральная «Генерировать» — это FAB-кнопка, которая
 * открывает `GenerateSheet` (bottom-sheet с табами image/video/audio + features
 * + models), а не навигирует на отдельный маршрут.
 */

type NavItem = {
  to: string;
  /** i18n-ключ для подписи (резолвится в рендере). */
  labelKey: string;
  icon: typeof Home;
};

const items: NavItem[] = [
  { to: "/", labelKey: "nav.bottom.home", icon: Home },
  { to: "/gallery", labelKey: "nav.bottom.gallery", icon: ImageIcon },
  // Центральный пункт рендерится отдельно — см. рендер ниже.
  { to: "/plans", labelKey: "nav.bottom.learn", icon: GraduationCap },
  { to: "/profile", labelKey: "nav.bottom.profile", icon: User },
];

export function BottomNav() {
  const { t } = useTranslation();
  const location = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);

  // Любая навигация (включая внутреннюю из самого sheet'а после клика по
  // feature/модели) закрывает sheet. Дополнительная страховка на случай
  // hardware-back на Android.
  useEffect(() => {
    setSheetOpen(false);
  }, [location.pathname]);

  return (
    <>
      <nav className="bottom-nav">
        {items.slice(0, 2).map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            // `end` нужен только для корня (`/`), иначе NavLink считал бы Главную
            // активной на любой вложенной странице (т.к. `/` — родитель всех).
            end={n.to === "/"}
            className={({ isActive }) => clsx("bn-item", isActive && "active")}
          >
            <n.icon size={20} />
            <span>{t(n.labelKey)}</span>
            <span className="dot" />
          </NavLink>
        ))}

        <button
          type="button"
          className={clsx("bn-item bn-center", sheetOpen && "active")}
          onClick={() => setSheetOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
        >
          <span className="bn-fab">
            <Sparkles size={22} />
          </span>
          <span>{t("nav.bottom.generate")}</span>
        </button>

        {items.slice(2).map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === "/"}
            className={({ isActive }) => clsx("bn-item", isActive && "active")}
          >
            <n.icon size={20} />
            <span>{t(n.labelKey)}</span>
            <span className="dot" />
          </NavLink>
        ))}
      </nav>

      <GenerateSheet open={sheetOpen} onClose={() => setSheetOpen(false)} />
    </>
  );
}
