import { NavLink, Outlet } from "react-router-dom";
import { Key, Globe, Tags, FileText } from "lucide-react";
import clsx from "clsx";
import { ToastContainer } from "@/components/common/ToastContainer";

const links = [
  { to: "/admin/keys", label: "API-ключи", icon: Key },
  { to: "/admin/proxies", label: "Прокси", icon: Globe },
  { to: "/admin/pricing", label: "Цены моделей", icon: Tags },
  { to: "/admin/prompts", label: "Промпты", icon: FileText },
];

export default function AdminLayout() {
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 border-r border-border-default bg-bg-elev p-3 shrink-0">
        <div className="text-xs uppercase tracking-wide text-text-hint mb-2 px-2">Админ</div>
        <nav className="flex flex-col gap-1">
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                clsx(
                  "flex items-center gap-2 rounded px-3 py-2 text-sm transition-colors",
                  isActive ? "bg-accent text-white" : "text-text hover:bg-bg-elev-2",
                )
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
      <ToastContainer />
    </div>
  );
}
