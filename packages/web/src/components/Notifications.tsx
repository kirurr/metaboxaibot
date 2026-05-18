import { useNotificationsStore } from "@/stores/notificationsStore";
import type { WebNotificationDTO } from "@metabox/shared-browser/ws";
import { ArrowRight, Bell, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./common/Button";
import clsx from "clsx";
import { useNavigate } from "react-router-dom";

export function Notifications() {
  const navigate = useNavigate();

  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const notifications = useNotificationsStore((s) => s.list);
  const remove = useNotificationsStore((s) => s.remove);
  const markAsSeen = useNotificationsStore((s) => s.markAsSeen);

  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        dialogRef.current &&
        !dialogRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const hasNewNotif = notifications.some((n) => !n.isSeen);

  const handleClick = () => {
    if (open === false) {
      const notSeen = notifications.filter((n) => !n.isSeen);
      markAsSeen(notSeen.map((n) => n.id));
    }
    setOpen((v) => !v);
  };
  return (
    <div className="relative">
      <button ref={buttonRef} className="tn-icon-btn" title="Notifications" onClick={handleClick}>
        <Bell size={18} />
        {hasNewNotif && <span className="pip" />}
      </button>
      <dialog
        ref={dialogRef}
        className="max-h-[60vh] max-w-[30rem] overflow-auto absolute z-10 top-10 -left-[20rem] card p-2 text-white rise min-w-[30rem]"
        open={open}
      >
        <p className="text-[10px] font-medium tracking-widest uppercase text-white/30 px-2 pb-2 pt-1">
          Уведомления
        </p>
        <ul className="flex flex-col gap-4 ">
          {notifications.length === 0 && (
            <li className="p-4 text-center text-text-hint">Нет новых уведомлений</li>
          )}
          {notifications.map((n) => (
            <Notification
              navigate={() => navigate(`/gallery/${n.jobId}`)}
              key={n.id}
              remove={() => remove(n.id)}
              data={n}
            />
          ))}
        </ul>
      </dialog>
    </div>
  );
}

function Notification({
  data,
  remove,
  navigate,
}: {
  data: WebNotificationDTO;
  remove: () => void;
  navigate: () => void;
}) {
  const isSuccess = data.type.includes("success");
  const category = getCategory(data.type);

  return (
    <li
      className={clsx(
        "flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius)] border transition-colors",
        isSuccess
          ? "bg-teal-500/5 border-teal-500/20 hover:bg-teal-500/10"
          : "bg-red-500/5 border-red-500/15 hover:bg-red-500/10",
      )}
    >
      <span
        className={clsx(
          "w-2 h-2 rounded-full flex-shrink-0",
          isSuccess
            ? "bg-teal-400 shadow-[0_0_6px_rgba(45,212,191,0.7)]"
            : "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.7)]",
        )}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <h4 className="text-[13px] font-medium text-white/90 leading-tight truncate h4">
            {data.title}
          </h4>
          {category && (
            <span
              className={clsx(
                "text-[9px] font-semibold tracking-wider uppercase px-1.5 py-0.5 rounded-full flex-shrink-0",
                categoryStyles[category],
              )}
            >
              {category}
            </span>
          )}
        </div>
        <p
          className={clsx(
            "text-[11px] mt-0.5 leading-tight truncate",
            isSuccess ? "text-teal-400/70" : "text-red-400/70",
          )}
        >
          {data.message}
        </p>
      </div>

      <div className="flex items-center gap-0.5 flex-shrink-0">
        {isSuccess && (
          <Button
            variant="ghost"
            className="btn-icon
							hover:bg-transparent
							hover:scale-[1.1]
						"
            onClick={navigate}
          >
            <ArrowRight size={16} />
          </Button>
        )}
        <Button
          variant="ghost"
          className="btn-icon
						hover:bg-transparent
						hover:scale-[1.1]
					"
          onClick={remove}
        >
          <X size={16} />
        </Button>
      </div>
    </li>
  );
}

function getCategory(type: string): string {
  if (type.includes("image")) return "Image";
  if (type.includes("video")) return "Video";
  if (type.includes("audio")) return "Audio";
  if (type.includes("avatar")) return "Avatar";
  return "";
}

const categoryStyles: Record<string, string> = {
  Image: "bg-violet-500/15 text-violet-400 border border-violet-500/25",
  Video: "bg-amber-500/15 text-amber-400 border border-amber-500/25",
  Audio: "bg-teal-500/15 text-teal-400 border border-teal-500/25",
  Avatar: "bg-blue-500/15 text-blue-400 border border-blue-500/25",
};
