import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { ChevronLeft, MoreHorizontal, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import type { DialogDto } from "@/api/dialogs";
import { dialogTitle } from "./chatHelpers";

/**
 * "сейчас" / "5м" / "2ч" / "Вчера" / "Пн" / "Apr 28" — компактная подпись справа.
 * `t` обязателен, потому что часть строк (now/yesterday/weekday) локализована.
 */
function formatRelative(
  iso: string,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return t("chat.relTime.now");
  if (diffMin < 60) return t("chat.relTime.minutes", { n: diffMin });
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return t("chat.relTime.hours", { n: diffH });
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dayStart = new Date(d);
  dayStart.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today.getTime() - dayStart.getTime()) / 86_400_000);
  if (diffDays === 1) return t("chat.relTime.yesterday");
  if (diffDays < 7) return t(`chat.relTime.weekday.${d.getDay()}`);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export const ChatSidebar = memo(function ChatSidebar({
  dialogs,
  dialogsLoaded,
  dialogsLoading,
  dialogsErrorCode,
  activeId,
  onSelectDialog,
  onNewChat,
  onRename,
  onDelete,
  menuForId,
  setMenuForId,
  isMobile,
  sideOpen,
  onCloseMobileDrawer,
  onCollapseDesktop,
}: {
  dialogs: DialogDto[];
  dialogsLoaded: boolean;
  dialogsLoading: boolean;
  dialogsErrorCode: string | null;
  activeId: string | null;
  onSelectDialog: (id: string) => void;
  onNewChat: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  menuForId: string | null;
  setMenuForId: (id: string | null) => void;
  isMobile: boolean;
  sideOpen: boolean;
  onCloseMobileDrawer: () => void;
  onCollapseDesktop: () => void;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const sideRef = useRef<HTMLElement | null>(null);

  // Mobile drawer outside-click.
  useEffect(() => {
    if (!isMobile || !sideOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (sideRef.current && !sideRef.current.contains(e.target as Node)) onCloseMobileDrawer();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [isMobile, sideOpen, onCloseMobileDrawer]);

  const filteredDialogs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return dialogs;
    return dialogs.filter((d) => dialogTitle(d, t("chat.newDialog")).toLowerCase().includes(q));
  }, [dialogs, search, t]);

  return (
    <aside ref={sideRef} className={clsx("chat-side", sideOpen && "open open-backdrop")}>
      <div className="cs-head">
        <button className="btn btn-primary btn-sm cs-new" onClick={onNewChat}>
          <Plus size={14} /> {t("chat.newDialogBtn")}
        </button>
        <button
          className="cs-collapse"
          title={isMobile ? t("chat.dialogsClose") : t("chat.dialogsCollapse")}
          onClick={() => {
            if (isMobile) onCloseMobileDrawer();
            else onCollapseDesktop();
          }}
        >
          {isMobile ? <X size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>
      <div className="cs-search">
        <Search size={14} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("chat.searchDialogs")}
        />
      </div>
      <div className="cs-list">
        {!dialogsLoaded && dialogsLoading && (
          <div className="cs-group">{t("chat.loadingDialogs")}</div>
        )}
        {dialogsLoaded && dialogsErrorCode === "TELEGRAM_NOT_LINKED" && (
          <div className="cs-group" style={{ color: "var(--text-secondary)" }}>
            {t("chat.linkTgToSeeDialogs")}
          </div>
        )}
        {dialogsLoaded && filteredDialogs.length === 0 && !dialogsErrorCode && (
          <div className="cs-group">{search ? t("common.empty") : t("chat.noDialogs")}</div>
        )}
        {filteredDialogs.length > 0 && <div className="cs-group">{t("chat.recent")}</div>}
        {filteredDialogs.map((d) => (
          <div key={d.id} style={{ position: "relative" }}>
            <button
              className={clsx("cs-item", d.id === activeId && "active")}
              onClick={() => onSelectDialog(d.id)}
            >
              <div className="cs-title">{dialogTitle(d, t("chat.newDialog"))}</div>
              <div className="cs-meta">
                <span className="mono">{d.modelId}</span>
                <span>{formatRelative(d.updatedAt, t)}</span>
              </div>
            </button>
            <button
              className="cs-item-menu"
              aria-label={t("common.actions")}
              onClick={(e) => {
                e.stopPropagation();
                setMenuForId(menuForId === d.id ? null : d.id);
              }}
            >
              <MoreHorizontal size={14} />
            </button>
            {menuForId === d.id && (
              <div className="cs-item-pop" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => onRename(d.id)}>
                  <Pencil size={13} /> {t("common.rename")}
                </button>
                <button className="danger" onClick={() => onDelete(d.id)}>
                  <Trash2 size={13} /> {t("common.delete")}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
});
