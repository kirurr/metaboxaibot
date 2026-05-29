import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getGalleryOriginalUrl, type GalleryFolder, type GalleryJob } from "@/api/gallery";
import {
  useAddJobToGalleryFolder,
  useAddToGalleryFavorites,
  useCreateGalleryFolder,
  useDeleteGalleryOutput,
  useRemoveFromGalleryFavorites,
  useRemoveJobFromGalleryFolder,
} from "@/hooks/useGallery";
import {
  GenerationPreviewModal,
  type PreviewOutput,
} from "@/components/common/GenerationPreviewModal";
import { getModelDisplay } from "@/stores/modelsStore";
import { useUIStore } from "@/stores/uiStore";
import { navigateToGenerate, normalizeSection } from "@/utils/navigateToGenerate";
import { formatTokensSpent } from "@/utils/format";
import { parseShots } from "@/utils/multishot";
import { buildSettingsRows } from "@/utils/settingsDisplay";

/**
 * Единый адаптер `GalleryJob` → `GenerationPreviewModal`. Используется и галереей
 * (`Gallery` page), и лентой генерации (`GenerationHistory`, после дотягивания
 * полного `GalleryJob` по id) — чтобы обе модалки выглядели и работали одинаково.
 *
 * Внутри проводит все действия над джобой: повтор, скачивание оригинала,
 * избранное, папки (+ создание), удаление. Активный output — локальный стейт
 * (resets на каждое открытие через `key={job.id}` у вызывающего).
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
  job: GalleryJob;
  folders: GalleryFolder[];
  initialOutputIdx?: number;
  onClose: () => void;
  /** Вызывается после успешного удаления output'а (помимо инвалидации gallery-
   *  кэша) — нужно ленте, чей грид живёт в локальном стейте, а не в react-query.
   *  `jobRemoved` = был удалён последний output и снесена вся джоба. */
  onDeleted?: (jobId: string, jobRemoved: boolean) => void;
}) {
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);
  const addToFolder = useAddJobToGalleryFolder();
  const removeFromFolder = useRemoveJobFromGalleryFolder();
  const addFav = useAddToGalleryFavorites();
  const removeFav = useRemoveFromGalleryFavorites();
  const createFolder = useCreateGalleryFolder();
  const deleteOutput = useDeleteGalleryOutput();
  const [activeIdx, setActiveIdx] = useState(initialOutputIdx);
  // Локально скрытые (только что удалённые) output'ы — чтобы модалка обновилась
  // сразу, не дожидаясь рефетча `useGalleryJob`.
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const modelDisplay = getModelDisplay(job.modelId, job.modelName);

  const previewOutputs = useMemo<PreviewOutput[]>(
    () =>
      job.outputs
        .filter((o) => !removedIds.has(o.id))
        .map((o) => ({
          id: o.id,
          url: o.previewUrl ?? o.outputUrl ?? "",
          thumbnailUrl: o.thumbnailUrl,
        }))
        .filter((o) => o.url),
    [job.outputs, removedIds],
  );

  const handleRepeat = useCallback(() => {
    const section = normalizeSection(job.section);
    if (!section) {
      // Невалидную секцию показываем тостом, модалку оставляем открытой.
      pushToast({ type: "error", message: "Неизвестная секция" });
      return;
    }
    onClose();
    navigateToGenerate(navigate, {
      section,
      modelId: job.modelId,
      prompt: job.prompt,
      settings: job.modelSettings,
    });
  }, [job, navigate, pushToast, onClose]);

  const handleDownload = useCallback(async () => {
    // Ищем в `previewOutputs` (отфильтрован по url), а не в `job.outputs` —
    // иначе при отброшенном output'е activeIdx смещается и качаем не ту работу.
    const safe = Math.min(activeIdx, previewOutputs.length - 1);
    const out = previewOutputs[safe];
    if (!out) return;
    try {
      const { url } = await getGalleryOriginalUrl(out.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      pushToast({ type: "error", message: getErrorMessage(err) });
    }
  }, [previewOutputs, activeIdx, pushToast]);

  const handleToggleFolder = useCallback(
    (folderId: string) => {
      const isIn = job.folderIds.includes(folderId);
      const opts = {
        onError: (err: unknown) => pushToast({ type: "error", message: getErrorMessage(err) }),
      };
      if (isIn) removeFromFolder.mutate({ folderId, jobId: job.id }, opts);
      else addToFolder.mutate({ folderId, jobId: job.id }, opts);
    },
    [job.id, job.folderIds, addToFolder, removeFromFolder, pushToast],
  );

  const handleCreateFolder = useCallback(
    (name: string) => {
      createFolder.mutate(
        { name },
        {
          onSuccess: () => pushToast({ type: "success", message: "Папка создана" }),
          onError: (err) => pushToast({ type: "error", message: getErrorMessage(err) }),
        },
      );
    },
    [createFolder, pushToast],
  );

  const favId = folders.find((f) => f.isDefault)?.id;
  const isFavorite = favId ? job.folderIds.includes(favId) : false;
  const handleToggleFavorite = useCallback(() => {
    const opts = {
      onError: (err: unknown) => pushToast({ type: "error", message: getErrorMessage(err) }),
    };
    if (isFavorite) removeFav.mutate(job.id, opts);
    else addFav.mutate(job.id, opts);
  }, [isFavorite, addFav, removeFav, job.id, pushToast]);

  const handleDelete = useCallback(() => {
    const safe = Math.min(activeIdx, previewOutputs.length - 1);
    const out = previewOutputs[safe];
    if (!out) return;
    const isLast = previewOutputs.length <= 1;
    const msg = isLast ? "Удалить работу безвозвратно?" : "Удалить этот результат безвозвратно?";
    if (!window.confirm(msg)) return;
    deleteOutput.mutate(out.id, {
      onSuccess: (res) => {
        if (res.jobDeleted) {
          pushToast({ type: "success", message: "Работа удалена" });
          onDeleted?.(job.id, true);
          onClose();
        } else {
          setRemovedIds((s) => {
            const next = new Set(s);
            next.add(out.id);
            return next;
          });
          setActiveIdx((i) => Math.max(0, Math.min(i, previewOutputs.length - 2)));
          pushToast({ type: "success", message: "Результат удалён" });
          onDeleted?.(job.id, false);
        }
      },
      onError: (err) => pushToast({ type: "error", message: getErrorMessage(err) }),
    });
  }, [deleteOutput, previewOutputs, activeIdx, job.id, pushToast, onClose, onDeleted]);

  if (previewOutputs.length === 0) return null;

  const tokensValue =
    job.tokensSpent && job.tokensSpent !== "0" ? formatTokensSpent(job.tokensSpent) : null;
  const safeIdx = Math.min(activeIdx, previewOutputs.length - 1);

  return (
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
        onRepeat: handleRepeat,
        onDownload: handleDownload,
        folders: {
          list: folders,
          selectedIds: job.folderIds,
          onToggle: handleToggleFolder,
          onCreate: handleCreateFolder,
        },
      }}
    />
  );
}
