import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import {
  ArrowUp,
  File as FileIcon,
  ImageIcon,
  Paperclip,
  RefreshCw,
  Settings as SettingsIcon,
  X,
} from "lucide-react";
import type { WebModelDto } from "@/api/models";
import type { ApiError } from "@/api/client";
import { uploadChatFile } from "@/api/uploads";
import { useObjectUrl } from "@/hooks/useObjectUrl";
import { ChipPopover } from "@/components/settings/ChipPopover";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { formatBytes } from "./chatHelpers";
import type { PendingAttachment } from "./chatTypes";

/** `accept` для file picker'а — синхронизирован с серверным `isAllowedUploadMime`. */
const ACCEPT_MIMES =
  "image/png,image/jpeg,image/webp,image/gif,application/pdf,application/json," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet," +
  "text/csv,text/plain,text/markdown";

/**
 * Форматирует число токенов как `1.2K` / `128K` / `850`. Для значений ≥10K
 * округляем до целого (`128K`, не `128.0K`); для 1K..10K оставляем 1 знак
 * после запятой (`1.2K`); ниже — как есть.
 */
function formatTokensK(n: number): string {
  if (n < 1000) return String(n);
  const v = n / 1000;
  return v >= 10 ? `${Math.round(v)}K` : `${v.toFixed(1)}K`;
}

export function ChatComposer({
  draft,
  onDraftChange,
  onSend,
  sending,
  selectedModel,
  currentContextTokens,
  pendingAttachments,
  setPendingAttachments,
  settingValues,
  onUpdateSetting,
  focusKey,
}: {
  draft: string;
  onDraftChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  selectedModel: WebModelDto | undefined;
  currentContextTokens: number;
  pendingAttachments: PendingAttachment[];
  setPendingAttachments: React.Dispatch<React.SetStateAction<PendingAttachment[]>>;
  settingValues: Record<string, unknown>;
  onUpdateSetting: (key: string, value: unknown) => void;
  /** Bumped by wrapper.newChat() to refocus textarea. */
  focusKey: number;
}) {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null);
  const settingsPopRef = useRef<HTMLDivElement | null>(null);

  const autosize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, []);

  // Re-autosize when draft is cleared (e.g., after send) or set (e.g., starter prompt).
  useEffect(() => {
    autosize();
  }, [draft, autosize]);

  // Focus textarea when wrapper bumps focusKey (newChat).
  useEffect(() => {
    if (focusKey === 0) return;
    taRef.current?.focus();
  }, [focusKey]);

  // Settings popover outside-click. Popover в portal'е → проверяем оба ref'а
  // (кнопку-anchor и сам popup), иначе клик внутри popover'а закроет его.
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (settingsBtnRef.current?.contains(tgt)) return;
      if (settingsPopRef.current?.contains(tgt)) return;
      setSettingsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [settingsOpen]);

  // Открыть system file picker. Допустимые MIME-типы синхронизированы с серверной
  // валидацией (см. `web-chat.ts`). multiple=true — можно прикрепить сразу пачку.
  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function removePending(id: string) {
    setPendingAttachments((prev) => prev.filter((p) => p.id !== id));
  }

  // Грузим каждый файл параллельно через POST /web/chat-uploads. Каждый файл —
  // отдельный chip с состоянием uploading/ready/error. Send блокируется пока
  // есть uploading'и (см. uploadingCount).
  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    // Создаём pending-chips сразу для всех файлов, чтобы у юзера был визуальный
    // фидбек о начатой загрузке.
    const initial: PendingAttachment[] = list.map((file) => ({
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: "uploading",
      file,
    }));
    setPendingAttachments((prev) => [...prev, ...initial]);

    // Каждый upload — независимая promise, обновляем стейт по мере готовности.
    await Promise.all(
      initial.map(async (p) => {
        try {
          const dto = await uploadChatFile(p.file);
          setPendingAttachments((prev) =>
            prev.map((x) => (x.id === p.id ? { id: p.id, status: "ready", file: p.file, dto } : x)),
          );
        } catch (err) {
          const e = err as ApiError;
          const msg =
            e.code === "UNSUPPORTED_MEDIA_TYPE"
              ? t("chat.errorUnsupportedMedia")
              : e.code === "FILE_TOO_LARGE"
                ? t("chat.errorFileTooLarge")
                : e.message || t("chat.errorUploadFailed");
          setPendingAttachments((prev) =>
            prev.map((x) =>
              x.id === p.id ? { id: p.id, status: "error", file: p.file, error: msg } : x,
            ),
          );
        }
      }),
    );
  }

  const uploadingCount = pendingAttachments.filter((p) => p.status === "uploading").length;
  const readyCount = pendingAttachments.filter((p) => p.status === "ready").length;

  return (
    <div className="composer">
      <div className="composer-inner">
        {pendingAttachments.length > 0 && (
          <div className="composer-attachments">
            {pendingAttachments.map((p) => (
              <PendingChip key={p.id} pending={p} onRemove={() => removePending(p.id)} />
            ))}
          </div>
        )}
        <div className="composer-row">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_MIMES}
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              handleFiles(e.target.files);
              // Сбрасываем value чтобы повторный пик того же файла сработал.
              e.target.value = "";
            }}
          />
          <button
            className="tool"
            title={t("chat.promptAttach")}
            onClick={openFilePicker}
            disabled={sending}
          >
            <Paperclip size={18} />
          </button>
          <button
            ref={settingsBtnRef}
            className={clsx("tool", settingsOpen && "is-open")}
            title={t("chat.settings.title")}
            onClick={() => setSettingsOpen((v) => !v)}
            disabled={!selectedModel}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
          >
            <SettingsIcon size={18} />
          </button>
          {settingsOpen && selectedModel && (
            <ChipPopover
              anchorRef={settingsBtnRef}
              popRef={settingsPopRef}
              className="chat-settings-pop"
            >
              <SettingsPanel
                settings={selectedModel.settings}
                values={settingValues}
                onChange={onUpdateSetting}
                advancedLabel={t("chat.settings.advanced")}
              />
            </ChipPopover>
          )}
          <textarea
            ref={taRef}
            placeholder={t("chat.promptPlaceholder")}
            value={draft}
            rows={1}
            onInput={autosize}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
          />
          <button
            className="send"
            disabled={(!draft.trim() && readyCount === 0) || sending || uploadingCount > 0}
            onClick={onSend}
            title={
              sending
                ? t("chat.sending")
                : uploadingCount > 0
                  ? t("chat.waitUploads")
                  : t("chat.send")
            }
          >
            {sending ? <RefreshCw size={18} className="anim-spin" /> : <ArrowUp size={18} />}
          </button>
        </div>
        <div className="composer-foot">
          {selectedModel?.contextWindow ? (
            <div className="hint">
              <span className="mono">
                {formatTokensK(currentContextTokens)} / {formatTokensK(selectedModel.contextWindow)}
              </span>
            </div>
          ) : null}
          <span className="hint" style={{ marginLeft: "auto" }}>
            ~ <span className="mono">{Math.max(1, Math.round(draft.length / 4))}</span>{" "}
            {t("chat.tokensEst")}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Chip pending-загрузки в composer'е (uploading / ready / error). */
function PendingChip({ pending, onRemove }: { pending: PendingAttachment; onRemove: () => void }) {
  const { t } = useTranslation();
  const isImage =
    pending.status === "ready"
      ? pending.dto.kind === "image"
      : pending.file.type.startsWith("image/");
  // Для uploading-state делаем локальный preview через ObjectURL, чтобы юзер
  // видел картинку сразу, не дожидаясь S3-presigned. ObjectURL чистим на unmount.
  const previewUrl = useObjectUrl(pending.file, isImage);
  const finalUrl = pending.status === "ready" ? pending.dto.url : null;
  const url = finalUrl || previewUrl;
  return (
    <div
      className={
        "att-chip" +
        (pending.status === "error" ? " att-chip-error" : "") +
        (pending.status === "uploading" ? " att-chip-loading" : "")
      }
    >
      <div className="att-chip-icon">
        {isImage && url ? (
          <img src={url} alt={pending.file.name} />
        ) : isImage ? (
          <ImageIcon size={14} />
        ) : (
          <FileIcon size={14} />
        )}
      </div>
      <div className="att-chip-body">
        <div className="att-chip-name" title={pending.file.name}>
          {pending.file.name}
        </div>
        <div className="att-chip-meta">
          {pending.status === "uploading"
            ? t("chat.uploading")
            : pending.status === "error"
              ? pending.error
              : formatBytes(pending.file.size, t)}
        </div>
      </div>
      <button className="att-chip-remove" onClick={onRemove} aria-label={t("chat.removeFile")}>
        <X size={12} />
      </button>
    </div>
  );
}
