import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImagePlus, Loader2, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { uploadChatFile } from "@/api/uploads";
import { createHeyGenAvatar, createSoulAvatar, type UserAvatarDto } from "@/api/userAvatars";

/**
 * Модалка создания пользовательского аватара.
 *
 * HeyGen: одно фото → синхронный аплоад в HeyGen `/v3/assets` → готовый аватар
 * со status="ready" возвращается сразу.
 *
 * Soul: 10-30 фото → аплоад каждого в /web/chat-uploads → POST на soul-create
 * stub → запись со status="creating" (worker-джоба ассинхронно дотренирует).
 */

const SOUL_MIN = 10;
const SOUL_MAX = 30;

type UploadEntry = {
  id: string;
  file: File;
  previewUrl: string;
  status: "uploading" | "ready" | "error";
  s3Key?: string;
  error?: string;
};

export type CreateAvatarModalProps = {
  provider: "heygen" | "higgsfield_soul";
  onClose: () => void;
  onCreated: (avatar: UserAvatarDto) => void;
};

export function CreateAvatarModal({ provider, onClose, onCreated }: CreateAvatarModalProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef<string[]>([]);

  const isSoul = provider === "higgsfield_soul";
  const maxFiles = isSoul ? SOUL_MAX : 1;
  const minFiles = isSoul ? SOUL_MIN : 1;
  const titleText = isSoul ? t("avatarModal.soulTitle") : t("avatarModal.heygenTitle");
  const hintText = isSoul
    ? t("avatarModal.soulHint", { min: SOUL_MIN, max: SOUL_MAX })
    : t("avatarModal.heygenHint");

  // Cleanup local blob: URLs при unmount.
  useEffect(() => {
    return () => {
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
      previewUrlsRef.current = [];
    };
  }, []);

  function openPicker() {
    fileInputRef.current?.click();
  }

  async function onFilesPicked(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const incoming = Array.from(fileList);
    const room = Math.max(0, maxFiles - entries.length);
    const toAdd = incoming.slice(0, room);

    const initial: UploadEntry[] = toAdd.map((file) => {
      const blobUrl = URL.createObjectURL(file);
      previewUrlsRef.current.push(blobUrl);
      return {
        id: `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        previewUrl: blobUrl,
        status: "uploading",
      };
    });
    setEntries((prev) => [...prev, ...initial]);

    // Параллельный upload — не блокирует один медленный файл остальные.
    await Promise.all(
      initial.map(async (entry) => {
        try {
          const dto = await uploadChatFile(entry.file);
          setEntries((prev) =>
            prev.map((x) => (x.id === entry.id ? { ...x, status: "ready", s3Key: dto.s3Key } : x)),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : t("avatarModal.uploadError");
          setEntries((prev) =>
            prev.map((x) => (x.id === entry.id ? { ...x, status: "error", error: msg } : x)),
          );
        }
      }),
    );

    // Сброс <input value> чтобы при повторной попытке тех же файлов сработал change.
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeEntry(id: string) {
    setEntries((prev) => prev.filter((x) => x.id !== id));
  }

  const readyEntries = entries.filter((e) => e.status === "ready" && e.s3Key);
  const uploadingCount = entries.filter((e) => e.status === "uploading").length;
  const canSubmit =
    !submitting &&
    uploadingCount === 0 &&
    readyEntries.length >= minFiles &&
    readyEntries.length <= maxFiles;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const avatar =
        provider === "heygen"
          ? await createHeyGenAvatar({
              s3Key: readyEntries[0].s3Key!,
              name: name.trim() || undefined,
            })
          : await createSoulAvatar({
              s3Keys: readyEntries.map((e) => e.s3Key!),
              name: name.trim() || undefined,
            });
      onCreated(avatar);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("avatarModal.createError");
      setSubmitError(msg);
      setSubmitting(false);
    }
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal create-avatar-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{titleText}</h3>
          <button className="modal-close" onClick={onClose} aria-label={t("common.close")}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p className="modal-hint">{hintText}</p>

          <label className="modal-field">
            <span>{t("avatarModal.name")}</span>
            <input
              type="text"
              value={name}
              placeholder={
                isSoul
                  ? t("avatarModal.namePlaceholderSoul")
                  : t("avatarModal.namePlaceholderHeygen")
              }
              onChange={(e) => setName(e.target.value)}
              disabled={submitting}
            />
          </label>

          <div className="create-avatar-grid">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className={clsx(
                  "create-avatar-tile",
                  entry.status === "error" && "is-error",
                  entry.status === "uploading" && "is-uploading",
                )}
              >
                <img src={entry.previewUrl} alt={entry.file.name} />
                {entry.status === "uploading" && (
                  <div className="create-avatar-overlay">
                    <Loader2 size={16} className="spin" />
                  </div>
                )}
                {entry.status === "error" && (
                  <div className="create-avatar-overlay">{entry.error ?? "!"}</div>
                )}
                <button
                  type="button"
                  className="create-avatar-remove"
                  onClick={() => removeEntry(entry.id)}
                  disabled={submitting}
                  aria-label={t("avatarModal.removePhoto")}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
            {entries.length < maxFiles && (
              <button
                type="button"
                className="create-avatar-add"
                onClick={openPicker}
                disabled={submitting}
              >
                <ImagePlus size={20} />
                <span>
                  {isSoul
                    ? t("avatarModal.addMore", { n: entries.length, max: maxFiles })
                    : t("avatarModal.addPhoto")}
                </span>
              </button>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple={isSoul}
            hidden
            onChange={(e) => onFilesPicked(e.target.files)}
          />

          {submitError && <div className="modal-error">{submitError}</div>}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={submitting}>
            {t("avatarModal.cancel")}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting ? (
              <>
                <Loader2 size={14} className="spin" /> {t("avatarModal.creating")}
              </>
            ) : (
              t("avatarModal.create")
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
