import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  getGalleryOriginalUrl,
  type GalleryFolder,
  type GalleryJobDetail,
  type GalleryOutput,
} from "@/api/gallery";
import {
  useAddOutputToGalleryFolder,
  useAddToGalleryFavorites,
  useCreateGalleryFolder,
  useDeleteGalleryOutput,
  useRemoveFromGalleryFavorites,
  useRemoveOutputFromGalleryFolder,
} from "@/hooks/useGallery";
import {
  GenerationPreviewModal,
  type PreviewOutput,
} from "@/components/common/GenerationPreviewModal";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { getModelDisplay } from "@/stores/modelsStore";
import { useUIStore } from "@/stores/uiStore";
import { navigateToGenerate, normalizeSection } from "@/utils/navigateToGenerate";
import { formatTokensSpent } from "@/utils/format";
import { parseShots } from "@/utils/multishot";
import { buildSettingsRows } from "@/utils/settingsDisplay";
import { openOutputInTool, REUSE_TARGETS, type ReuseOutput } from "@/utils/openOutputInTool";

/**
 * Единый адаптер `GalleryJobDetail` → `GenerationPreviewModal`. Используется и
 * галереей (`Gallery` page), и лентой генерации (`GenerationHistory`, после
 * дотягивания полного `GalleryJobDetail` по id) — обе модалки выглядят и
 * работают одинаково.
 *
 * Внутри проводит все действия над активным output'ом: повтор, скачивание
 * оригинала, избранное, папки (+ создание), удаление. Активный output —
 * локальный стейт (resets на каждое открытие через `key={job.id}` у
 * вызывающего). Favorites и папки переехали с job-level на output-level в
 * рефакторе 2026-05-31: каждая картинка в пачке лайкается отдельно.
 */

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Что-то пошло не так";
}

export function JobPreview({
  job,
  folders,
  initialOutputIdx = 0,
  onClose,
  onDeleted,
}: {
  job: GalleryJobDetail;
  folders: GalleryFolder[];
  initialOutputIdx?: number;
  onClose: () => void;
  /** Вызывается после успешного удаления output'а (помимо инвалидации gallery-
   *  кэша) — нужно ленте, чей грид живёт в локальном стейте, а не в react-query.
   *  `jobRemoved` = был удалён последний output и снесена вся джоба. */
  onDeleted?: (jobId: string, jobRemoved: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);
  const addToFolder = useAddOutputToGalleryFolder();
  const removeFromFolder = useRemoveOutputFromGalleryFolder();
  const addFav = useAddToGalleryFavorites();
  const removeFav = useRemoveFromGalleryFavorites();
  const createFolder = useCreateGalleryFolder();
  const deleteOutput = useDeleteGalleryOutput();
  // `initialOutputIdx` — это DB-поле `GenerationJobOutput.index`, а не позиция в
  // массиве. После удаления одного output'а из середины пачки индексы становятся
  // несплошными (например, 0,2,3), и наивная индексация массивом откроет не ту
  // картинку (или undefined). Конвертируем DB-index → array idx; если совпадения
  // нет (output уже удалён) — открываем первый.
  const initialArrayIdx = useMemo(() => {
    const found = job.outputs.findIndex((o) => o.index === initialOutputIdx);
    return found >= 0 ? found : 0;
  }, [job.outputs, initialOutputIdx]);
  const [activeIdx, setActiveIdx] = useState(initialArrayIdx);
  // Локально скрытые (только что удалённые) output'ы — чтобы модалка обновилась
  // сразу, не дожидаясь рефетча `useGalleryJob`.
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const modelDisplay = getModelDisplay(job.modelId, job.modelName);

  const visibleOutputs: GalleryOutput[] = useMemo(
    () => job.outputs.filter((o) => !removedIds.has(o.id)),
    [job.outputs, removedIds],
  );

  const previewOutputs = useMemo<PreviewOutput[]>(
    () =>
      visibleOutputs
        .map((o) => ({
          id: o.id,
          url: o.previewUrl ?? o.outputUrl ?? "",
          thumbnailUrl: o.thumbnailUrl,
        }))
        .filter((o) => o.url),
    [visibleOutputs],
  );

  const handleRepeat = useCallback(() => {
    const section = normalizeSection(job.section);
    if (!section) {
      // Невалидную секцию показываем тостом, модалку оставляем открытой.
      pushToast({ type: "error", message: t("common.unknownSection") });
      return;
    }
    onClose();
    navigateToGenerate(navigate, {
      section,
      modelId: job.modelId,
      prompt: job.prompt,
      settings: job.modelSettings,
    });
  }, [job, navigate, pushToast, onClose, t]);

  const safeIdx = Math.min(activeIdx, Math.max(0, previewOutputs.length - 1));
  const activeOutput: GalleryOutput | undefined = useMemo(() => {
    const id = previewOutputs[safeIdx]?.id;
    return id ? visibleOutputs.find((o) => o.id === id) : undefined;
  }, [previewOutputs, safeIdx, visibleOutputs]);

  const handleDownload = useCallback(async () => {
    const out = previewOutputs[safeIdx];
    if (!out) return;
    try {
      const { url } = await getGalleryOriginalUrl(out.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      pushToast({ type: "error", message: getErrorMessage(err) });
    }
  }, [previewOutputs, safeIdx, pushToast]);

  const handleToggleFolder = useCallback(
    (folderId: string) => {
      if (!activeOutput) return;
      const isIn = activeOutput.folderIds.includes(folderId);
      const opts = {
        onError: (err: unknown) => pushToast({ type: "error", message: getErrorMessage(err) }),
      };
      if (isIn) removeFromFolder.mutate({ folderId, outputId: activeOutput.id }, opts);
      else addToFolder.mutate({ folderId, outputId: activeOutput.id }, opts);
    },
    [activeOutput, addToFolder, removeFromFolder, pushToast],
  );

  const handleCreateFolder = useCallback(
    (name: string) => {
      createFolder.mutate(
        { name },
        {
          onSuccess: () => pushToast({ type: "success", message: t("common.folderCreated") }),
          onError: (err) => pushToast({ type: "error", message: getErrorMessage(err) }),
        },
      );
    },
    [createFolder, pushToast, t],
  );

  const favId = folders.find((f) => f.isDefault)?.id;
  const isFavorite = favId && activeOutput ? activeOutput.folderIds.includes(favId) : false;
  const handleToggleFavorite = useCallback(() => {
    if (!activeOutput) return;
    const opts = {
      onError: (err: unknown) => pushToast({ type: "error", message: getErrorMessage(err) }),
    };
    if (isFavorite) removeFav.mutate(activeOutput.id, opts);
    else addFav.mutate(activeOutput.id, opts);
  }, [isFavorite, addFav, removeFav, activeOutput, pushToast]);

  const handleDelete = useCallback(() => {
    setConfirmDeleteOpen(true);
  }, []);

  const performDelete = useCallback(() => {
    const out = previewOutputs[safeIdx];
    if (!out) return;
    deleteOutput.mutate(out.id, {
      onSuccess: (res) => {
        setConfirmDeleteOpen(false);
        if (res.jobDeleted) {
          pushToast({ type: "success", message: t("common.jobDeleted") });
          onDeleted?.(job.id, true);
          onClose();
        } else {
          setRemovedIds((s) => {
            const next = new Set(s);
            next.add(out.id);
            return next;
          });
          setActiveIdx((i) => Math.max(0, Math.min(i, previewOutputs.length - 2)));
          pushToast({ type: "success", message: t("common.resultDeleted") });
          onDeleted?.(job.id, false);
        }
      },
      onError: (err) => pushToast({ type: "error", message: getErrorMessage(err) }),
    });
  }, [deleteOutput, previewOutputs, safeIdx, job.id, pushToast, onClose, onDeleted, t]);

  // Активный output как источник для «открыть в инструменте». s3Key есть только
  // у сохранённых в наш S3 output'ов (provider-only → null, кнопки прячем).
  const makeReuseOutput = useCallback((): ReuseOutput | null => {
    if (!activeOutput?.s3Key) return null;
    return {
      s3Key: activeOutput.s3Key,
      url: activeOutput.previewUrl ?? activeOutput.outputUrl ?? null,
      name: modelDisplay.name,
    };
  }, [activeOutput, modelDisplay.name]);

  const handleAnimate = useCallback(() => {
    const o = makeReuseOutput();
    if (!o) return;
    onClose();
    void openOutputInTool(navigate, REUSE_TARGETS.animate, o);
  }, [makeReuseOutput, navigate, onClose]);

  const handleReference = useCallback(() => {
    const o = makeReuseOutput();
    if (!o) return;
    onClose();
    void openOutputInTool(navigate, REUSE_TARGETS.reference, o);
  }, [makeReuseOutput, navigate, onClose]);

  const handleUpscale = useCallback(() => {
    const o = makeReuseOutput();
    if (!o) return;
    const target =
      normalizeSection(job.section) === "video"
        ? REUSE_TARGETS.upscaleVideo
        : REUSE_TARGETS.upscaleImage;
    onClose();
    void openOutputInTool(navigate, target, o);
  }, [makeReuseOutput, navigate, onClose, job.section]);

  if (previewOutputs.length === 0) return null;

  const tokensValue =
    job.tokensSpent && job.tokensSpent !== "0" ? formatTokensSpent(job.tokensSpent) : null;

  // Доступность reuse-кнопок: тип секции + наличие s3Key у активного output.
  const sec = normalizeSection(job.section);
  const canReuse = !!activeOutput?.s3Key;

  const isLastOutput = previewOutputs.length <= 1;

  return (
    <>
      <GenerationPreviewModal
        outputs={previewOutputs}
        activeIdx={safeIdx}
        onActiveIdxChange={setActiveIdx}
        section={job.section}
        onClose={onClose}
        info={{
          title: modelDisplay.name,
          iconPath: modelDisplay.icon,
          dateIso: job.completedAt,
          tokensValue,
          prompt: job.prompt,
          shots: parseShots(job.modelSettings?.shots),
          settings: buildSettingsRows(job.modelId, job.modelSettings),
          isFavorite,
          onToggleFavorite: handleToggleFavorite,
          onDelete: handleDelete,
          onAnimate: sec === "image" && canReuse ? handleAnimate : undefined,
          onReference: sec === "image" && canReuse ? handleReference : undefined,
          onUpscale: (sec === "image" || sec === "video") && canReuse ? handleUpscale : undefined,
          onRepeat: handleRepeat,
          onDownload: handleDownload,
          folders: {
            list: folders,
            selectedIds: activeOutput?.folderIds ?? [],
            onToggle: handleToggleFolder,
            onCreate: handleCreateFolder,
          },
        }}
      />
      {confirmDeleteOpen && (
        <ConfirmDialog
          title={isLastOutput ? t("common.deleteJob") : t("common.deleteResult")}
          message={t("common.cannotUndo")}
          confirmLabel={t("common.delete")}
          danger
          pending={deleteOutput.isPending}
          onConfirm={performDelete}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}
    </>
  );
}
