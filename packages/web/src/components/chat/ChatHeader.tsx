import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Download, Menu, Plus } from "lucide-react";
import type { DialogDto } from "@/api/dialogs";
import { dialogTitle } from "./chatHelpers";

export const ChatHeader = memo(function ChatHeader({
  activeDialog,
  messagesLoading,
  messagesCount,
  isMobile,
  sideOpen,
  sideCollapsed,
  onExpandSide,
  onNewChat,
}: {
  activeDialog: DialogDto | null;
  messagesLoading: boolean;
  messagesCount: number;
  isMobile: boolean;
  sideOpen: boolean;
  sideCollapsed: boolean;
  onExpandSide: () => void;
  onNewChat: () => void;
}) {
  const { t } = useTranslation();
  const expandVisible = isMobile ? !sideOpen : sideCollapsed;
  return (
    <div className="chat-head">
      {expandVisible && (
        <button className="expand-side" title={t("chat.dialogsExpand")} onClick={onExpandSide}>
          <Menu size={18} />
        </button>
      )}
      <div className="chat-title">
        <div className="ct-name">
          {activeDialog ? dialogTitle(activeDialog, t("chat.newDialog")) : t("chat.newDialog")}
        </div>
        <div className="ct-sub">
          {messagesLoading
            ? t("chat.loadingHistory")
            : messagesCount === 0
              ? t("chat.startNew")
              : t("chat.messagesCount", { count: messagesCount })}
        </div>
      </div>
      <div className="ch-actions">
        <button className="btn btn-ghost btn-sm" onClick={onNewChat}>
          <Plus size={15} /> {t("chat.newShort")}
        </button>
        {!isMobile && activeDialog && (
          <button className="btn btn-ghost btn-sm" disabled title={t("chat.exportSoon")}>
            <Download size={15} /> Export
          </button>
        )}
      </div>
    </div>
  );
});
