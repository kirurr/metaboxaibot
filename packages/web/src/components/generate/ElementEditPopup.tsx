import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ImagePlus, Loader2, Trash2, X } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { createElement, uploadElementMedia, elementKeys, type Element } from "@/api/elements";
import { ApiError } from "@/api/client";
import {
  useElements,
  useUpdateElement,
  useUploadElementMedia,
  useDeleteElementMedia,
} from "@/hooks/useElements";

/**
 * Попап создания/редактирования Element'а — именованного набора референсных
 * картинок. Стиль повторяет MediaReusePopup; рендерится через портал поверх него.
 *
 * Create: имя + картинки набираются локально (blob-превью). По «Создать» сначала
 * POST создаёт элемент (нужен elementId), затем заливаем все staged-файлы. После
 * успешного create компонент переходит в live-режим (committedId) — как edit.
 *
 * Edit: картинки и имя меняются «вживую» (мутации бьют в API сразу,
 * `useElements` рефетчит список).
 */

const ELEMENT_MAX_MEDIA = 10;

/** Локальная картинка: в create — staged до коммита; в live — in-flight/ошибка. */
type StagedEntry = {
  id: string;
  file: File;
  previewUrl: string;
  status: "staged" | "uploading" | "error";
};

export type ElementEditPopupProps =
  | { mode: "create"; onClose: () => void }
  | { mode: "edit"; element: Element; onClose: () => void };

function tempId() {
  return `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ElementEditPopup(props: ElementEditPopupProps) {
  const { onClose } = props;
  const initialElement = props.mode === "edit" ? props.element : null;
  const { t } = useTranslation();
  const qc = useQueryClient();

  const { elements } = useElements();
  const updateMutation = useUpdateElement();
  const uploadMutation = useUploadElementMedia();
  const deleteMediaMutation = useDeleteElementMedia();

  // null до коммита (create). После создания / в edit — id элемента; тогда
  // работаем live, а актуальные media берём из кэша useElements.
  const [committedId, setCommittedId] = useState<string | null>(initialElement?.id ?? null);
  const [staged, setStaged] = useState<StagedEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewUrlsRef = useRef<string[]>([]);

  // media уже отсортированы в listElements (creation order, новые в конце).
  const liveElement =
    committedId != null
      ? (elements.find((e) => e.id === committedId) ?? initialElement ?? undefined)
      : undefined;
  const serverMedia = liveElement?.media ?? [];

  const schema = useMemo(
    () =>
      z.object({
        name: z
          .string()
          .min(1, t("elementModal.nameRequired"))
          .max(64, t("elementModal.nameInvalid"))
          .regex(/^[a-zA-Z0-9_]+$/, t("elementModal.nameInvalid")),
      }),
    [t],
  );
  type FormValues = z.infer<typeof schema>;

  const {
    register,
    handleSubmit,
    getValues,
    trigger,
    setError,
    formState: { errors, isValid },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: { name: initialElement?.name ?? "" },
  });

  // Cleanup blob-URL'ов при unmount.
  useEffect(() => {
    return () => {
      for (const url of previewUrlsRef.current) URL.revokeObjectURL(url);
      previewUrlsRef.current = [];
    };
  }, []);

  // Esc закрывает попап.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const total = serverMedia.length + staged.length;
  const atMax = total >= ELEMENT_MAX_MEDIA;

  /** Загрузка одного файла в уже существующий элемент (live). */
  async function uploadLive(elementId: string, entry: StagedEntry) {
    setStaged((prev) => prev.map((x) => (x.id === entry.id ? { ...x, status: "uploading" } : x)));
    try {
      await uploadMutation.mutateAsync({ elementId, file: entry.file });
      // Успех — убираем локальную плитку, картинка придёт из рефетча списка.
      setStaged((prev) => prev.filter((x) => x.id !== entry.id));
    } catch {
      setStaged((prev) => prev.map((x) => (x.id === entry.id ? { ...x, status: "error" } : x)));
    }
  }

  function onFilesPicked(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const room = Math.max(0, ELEMENT_MAX_MEDIA - total);
    const toAdd = Array.from(fileList).slice(0, room);
    const entries: StagedEntry[] = toAdd.map((file) => {
      const previewUrl = URL.createObjectURL(file);
      previewUrlsRef.current.push(previewUrl);
      return { id: tempId(), file, previewUrl, status: committedId ? "uploading" : "staged" };
    });
    setStaged((prev) => [...prev, ...entries]);
    // Live-режим — заливаем сразу; create (pre-commit) — оставляем staged.
    if (committedId) entries.forEach((e) => void uploadLive(committedId, e));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeStaged(id: string) {
    setStaged((prev) => prev.filter((x) => x.id !== id));
  }

  /** create: POST элемента → заливка всех staged → закрыть (или показать ошибки). */
  const onCreate = handleSubmit(async ({ name }) => {
    setSubmitting(true);
    setSubmitError(null);
    let id: string;
    try {
      id = (await createElement(name.trim())).id;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("name", { message: t("elementModal.nameConflict") });
      } else {
        setSubmitError(err instanceof Error ? err.message : t("elementModal.uploadError"));
      }
      setSubmitting(false);
      return;
    }
    setCommittedId(id);

    const current = staged;
    setStaged((prev) => prev.map((x) => ({ ...x, status: "uploading" })));
    const results = await Promise.allSettled(current.map((e) => uploadElementMedia(id, e.file)));
    await qc.invalidateQueries({ queryKey: elementKeys.list() });

    const failedIds = current.filter((_, i) => results[i].status === "rejected").map((e) => e.id);
    setStaged((prev) =>
      prev.filter((x) => failedIds.includes(x.id)).map((x) => ({ ...x, status: "error" })),
    );
    setSubmitting(false);
    if (failedIds.length === 0) onClose();
    else setSubmitError(t("elementModal.uploadError"));
  });

  /** edit/committed: rename по blur, если имя изменилось и валидно. */
  async function onNameBlur() {
    if (!committedId) return;
    const ok = await trigger("name");
    if (!ok) return;
    const next = getValues("name").trim();
    if (next === liveElement?.name) return;
    try {
      await updateMutation.mutateAsync({ id: committedId, name: next });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("name", { message: t("elementModal.nameConflict") });
      }
    }
  }

  const nameReg = register("name");
  const isCommitted = committedId != null;

  function renderServerTile(media: Element["media"][number]) {
    const pending =
      deleteMediaMutation.isPending && deleteMediaMutation.variables?.mediaId === media.id;
    return (
      <div key={media.id} className="relative group">
        <div
          className={clsx(
            "relative aspect-square w-full overflow-hidden rounded-[var(--radius)] bg-bg-elevated",
            pending && "opacity-40",
          )}
        >
          {media.url ? (
            <img
              src={media.url}
              alt={media.name}
              loading="lazy"
              className="size-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-text-secondary">
              <ImagePlus size={20} />
            </div>
          )}
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            committedId && deleteMediaMutation.mutate({ elementId: committedId, mediaId: media.id })
          }
          aria-label={t("elementModal.removeImage")}
          className="absolute left-1 top-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
        >
          <Trash2 size={11} />
        </button>
      </div>
    );
  }

  function renderStagedTile(entry: StagedEntry) {
    return (
      <div key={entry.id} className="relative group">
        <div
          className={clsx(
            "relative aspect-square w-full overflow-hidden rounded-[var(--radius)] bg-bg-elevated",
            entry.status === "error" && "ring-2 ring-danger",
          )}
        >
          <img
            src={entry.previewUrl}
            alt=""
            className={clsx("size-full object-cover", entry.status !== "staged" && "opacity-40")}
          />
          {entry.status === "uploading" && (
            <div className="absolute inset-0 flex items-center justify-center text-white">
              <Loader2 size={18} className="spin" />
            </div>
          )}
          {entry.status === "error" && committedId && (
            <button
              type="button"
              onClick={() => void uploadLive(committedId, entry)}
              className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs font-medium text-white"
            >
              {t("elementModal.uploadError")}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => removeStaged(entry.id)}
          aria-label={t("elementModal.removeImage")}
          className="absolute left-1 top-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
        >
          <Trash2 size={11} />
        </button>
      </div>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-2 sm:p-4 bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden p-0 sm:max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-white/10 p-3 sm:p-4">
          <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-text">
            {isCommitted ? t("elementModal.editTitle") : t("elementModal.createTitle")}
          </h3>
          <button
            className="btn btn-ghost btn-icon shrink-0"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-[40vh] max-h-[70vh] overflow-y-auto p-4 [scrollbar-gutter:stable] sm:max-h-[55vh]">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {serverMedia.map((m) => renderServerTile(m))}
            {staged.map((e) => renderStagedTile(e))}
            {!atMax && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={submitting}
                className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-[var(--radius)] border border-dashed border-white/20 bg-bg-elevated text-text-secondary transition hover:border-white/40 hover:text-white disabled:opacity-50"
              >
                <ImagePlus size={20} />
                <span className="text-xs">{t("elementModal.addImage")}</span>
              </button>
            )}
          </div>

          {total === 0 && (
            <div className="py-6 text-center text-sm text-text-secondary">
              {t("elementModal.empty")}
            </div>
          )}

          <p className="mt-2 text-right text-xs text-text-secondary">
            {t("elementModal.maxImages", { n: total, max: ELEMENT_MAX_MEDIA })}
          </p>

          {/* Name */}
          <label className="mt-4 block">
            <span className="mb-1 block text-sm text-text-secondary">{t("elementModal.name")}</span>
            <input
              type="text"
              placeholder={t("elementModal.namePlaceholder")}
              disabled={submitting}
              className={clsx(
                "w-full rounded-[var(--radius)] bg-bg-elevated px-3 py-2 text-sm text-text outline-none ring-2 transition",
                errors.name ? "ring-danger" : "ring-transparent focus:ring-accent",
              )}
              {...nameReg}
              onBlur={(e) => {
                nameReg.onBlur(e);
                void onNameBlur();
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (isCommitted) e.currentTarget.blur();
                else void onCreate();
              }}
            />
          </label>
          {errors.name && <p className="mt-1 text-xs text-danger">{errors.name.message}</p>}
          {submitError && <p className="mt-2 text-xs text-danger">{submitError}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-white/10 p-4">
          {isCommitted ? (
            <button type="button" className="btn btn-primary" onClick={onClose}>
              {t("elementModal.done")}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onClose}
                disabled={submitting}
              >
                {t("elementModal.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void onCreate()}
                disabled={submitting || !isValid}
              >
                {submitting ? (
                  <>
                    <Loader2 size={14} className="spin" /> {t("elementModal.create")}
                  </>
                ) : (
                  t("elementModal.create")
                )}
              </button>
            </>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => onFilesPicked(e.target.files)}
        />
      </div>
    </div>,
    document.body,
  );
}
