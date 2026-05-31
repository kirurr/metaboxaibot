import {
  type CSSProperties,
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ChevronDown,
  Download,
  FolderPlus,
  Grid3x3,
  Heart,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  MoreVertical,
  Music,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
  Video as VideoIcon,
} from "lucide-react";
import {
  getGalleryOriginalUrl,
  type GalleryFolder,
  type GalleryJob,
  type GalleryOutput,
} from "@/api/gallery";
import {
  useAddJobToGalleryFolder,
  useAddToGalleryFavorites,
  useCreateGalleryFolder,
  useDeleteGalleryFolder,
  useDeleteGalleryOutput,
  useGalleryFailedToday,
  useGalleryFolders,
  useGalleryJob,
  useGalleryModelCounts,
  useInfiniteGalleryJobs,
  useRemoveFromGalleryFavorites,
  useRemoveJobFromGalleryFolder,
  useUpdateGalleryFolder,
} from "@/hooks/useGallery";
import type { GenerationJobDto } from "@/api/generation";
import { JobPreview } from "@/components/common/JobPreview";
import { FolderNameDialog } from "@/components/common/FolderNameDialog";
import { useModelsStore, getModelDisplay } from "@/stores/modelsStore";
import { ModelAvatar } from "@/components/common/ModelAvatar";
import { useUIStore } from "@/stores/uiStore";
import { usePendingJobsStore, type PendingJob } from "@/stores/pendingJobsStore";
import { useDismissedErrorsStore } from "@/stores/dismissedErrorsStore";
import { FailedTile, PendingTile } from "@/components/generate/GenerationHistory";
import { navigateToGenerate, normalizeSection } from "@/utils/navigateToGenerate";
import { preloadImage, queuePreload } from "@/utils/imagePreload";

type Section = "" | "image" | "audio" | "video";

const SECTIONS: { value: Section; label: string }[] = [
  { value: "", label: "Все" },
  { value: "image", label: "Изображения" },
  { value: "audio", label: "Аудио" },
  { value: "video", label: "Видео" },
];

/**
 * Masonry-span по aspect'у — повторяет логику из GenerationHistory.tsx, чтобы
 * галерея визуально совпадала с лентой генерации на странице создания.
 * Базовый ряд auto-rows-[80px] (на mobile 100px), gap 12px:
 *   span 3 → wide (16:9 и шире), span 4 → square-дефолт, span 5 → tall (9:16 и уже).
 */
function spanFromAspect(aspect: number | null): number {
  if (aspect == null) return 4;
  if (aspect > 1.3) return 3;
  if (aspect < 0.85) return 5;
  return 4;
}

function chipClass(active: boolean): string {
  return active
    ? "px-3 py-1.5 rounded text-sm bg-accent text-white"
    : "px-3 py-1.5 rounded text-sm bg-bg-elevated text-text-secondary hover:text-text";
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Что-то пошло не так";
}

// ── Section / Model filters ─────────────────────────────────────────────────

function SectionChips({ section, onChange }: { section: Section; onChange: (s: Section) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {SECTIONS.map((s) => (
        <button
          key={s.value}
          type="button"
          onClick={() => onChange(s.value)}
          className={chipClass(s.value === section)}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

function ModelFilterChips({
  section,
  folderId,
  modelId,
  onChange,
}: {
  section: Section;
  folderId: string | undefined;
  modelId: string | undefined;
  onChange: (id: string | undefined) => void;
}) {
  const countsQuery = useGalleryModelCounts(section || undefined, folderId);
  const counts = countsQuery.data ?? [];
  const models = useModelsStore((s) => s.models);
  const modelNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const model of models) m.set(model.id, model.webName);
    return m;
  }, [models]);

  // Мобилка: два ряда с горизонтальным скроллом (моделей бывает много);
  // на md+ возвращаемся к привычному flex-wrap (grid-* утилиты инертны под flex).
  const containerClass =
    "grid grid-flow-col grid-rows-2 auto-cols-max items-center gap-2 overflow-x-auto pb-1 " +
    "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden " +
    "md:flex md:flex-wrap md:overflow-visible md:pb-0";

  if (countsQuery.isPending) {
    return (
      <div className={containerClass}>
        <div className="skeleton h-7 w-24 rounded" />
        <div className="skeleton h-7 w-28 rounded" />
      </div>
    );
  }
  if (counts.length === 0) return null;

  return (
    <div className={containerClass}>
      {counts.map((c) => {
        const label = modelNameById.get(c.modelId) ?? c.modelId;
        const active = modelId === c.modelId;
        return (
          <button
            key={c.modelId}
            type="button"
            onClick={() => onChange(active ? undefined : c.modelId)}
            className={`${chipClass(active)} shrink-0 whitespace-nowrap`}
          >
            {label} <span className="text-text-hint ml-1">({c.count})</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Folder sidebar ──────────────────────────────────────────────────────────

function FolderRow({
  folder,
  active,
  onSelect,
}: {
  folder: GalleryFolder;
  active: boolean;
  onSelect: () => void;
}) {
  const pushToast = useUIStore((s) => s.pushToast);
  const update = useUpdateGalleryFolder(folder.id);
  const del = useDeleteGalleryFolder();
  const [renameOpen, setRenameOpen] = useState(false);

  const handlePin = (e: MouseEvent) => {
    e.stopPropagation();
    update.mutate(
      { isPinned: !folder.isPinned },
      {
        onError: (err) => pushToast({ type: "error", message: getErrorMessage(err) }),
      },
    );
  };

  const handleRename = (e: MouseEvent) => {
    e.stopPropagation();
    setRenameOpen(true);
  };

  const submitRename = (name: string) => {
    update.mutate(
      { name },
      {
        onSuccess: () => {
          pushToast({ type: "success", message: "Папка переименована" });
          setRenameOpen(false);
        },
        onError: (err) => pushToast({ type: "error", message: getErrorMessage(err) }),
      },
    );
  };

  const handleDelete = (e: MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Удалить папку «${folder.name}»? Работы внутри не удалятся.`)) return;
    del.mutate(folder.id, {
      onSuccess: () => pushToast({ type: "success", message: "Папка удалена" }),
      onError: (err) => pushToast({ type: "error", message: getErrorMessage(err) }),
    });
  };

  const baseRow =
    "group flex items-center gap-2 px-3 py-2 rounded cursor-pointer text-sm transition-colors min-w-fit";
  const stateRow = active
    ? "bg-accent text-white"
    : "bg-bg-elevated text-text-secondary hover:text-text";

  return (
    <>
      <div onClick={onSelect} className={`${baseRow} ${stateRow}`}>
        <span className="truncate flex-1">
          {folder.isDefault ? "★ " : ""}
          {folder.name}
        </span>
        <span className="text-text-hint text-xs">{folder.itemCount}</span>
        <button
          type="button"
          onClick={handlePin}
          title={folder.isPinned ? "Открепить" : "Закрепить"}
          className="opacity-0 group-hover:opacity-100 hover:text-text p-1"
        >
          {folder.isPinned ? <PinOff size={14} /> : <Pin size={14} />}
        </button>
        {!folder.isDefault && (
          <>
            <button
              type="button"
              onClick={handleRename}
              title="Переименовать"
              className="opacity-0 group-hover:opacity-100 hover:text-text p-1"
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              onClick={handleDelete}
              title="Удалить"
              className="opacity-0 group-hover:opacity-100 hover:text-danger p-1"
              disabled={del.isPending}
            >
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
      {renameOpen && (
        <FolderNameDialog
          title="Переименовать папку"
          initialValue={folder.name}
          submitLabel="Сохранить"
          pending={update.isPending}
          onSubmit={submitRename}
          onClose={() => setRenameOpen(false)}
        />
      )}
    </>
  );
}

function FolderSidebar({
  folderId,
  onChange,
}: {
  folderId: string | undefined;
  onChange: (id: string | undefined) => void;
}) {
  const { data: folders = [], isLoading, error } = useGalleryFolders();
  const pushToast = useUIStore((s) => s.pushToast);
  const createMut = useCreateGalleryFolder();
  const [createOpen, setCreateOpen] = useState(false);

  const sorted = useMemo(() => {
    return [...folders].sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [folders]);

  const submitCreate = (name: string) => {
    createMut.mutate(
      { name },
      {
        onSuccess: () => {
          pushToast({ type: "success", message: "Папка создана" });
          setCreateOpen(false);
        },
        onError: (err) => pushToast({ type: "error", message: getErrorMessage(err) }),
      },
    );
  };

  return (
    <aside>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">Папки</h2>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          title="Создать папку"
          className="p-1 hover:bg-bg-elevated rounded text-text-secondary hover:text-text"
          disabled={createMut.isPending}
        >
          <FolderPlus size={16} />
        </button>
      </div>

      <div className="flex flex-row overflow-x-auto gap-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div
          onClick={() => onChange(undefined)}
          className={`flex items-center gap-2 px-3 py-2 rounded cursor-pointer text-sm transition-colors min-w-fit whitespace-nowrap ${
            folderId === undefined
              ? "bg-accent text-white"
              : "bg-bg-elevated text-text-secondary hover:text-text"
          }`}
        >
          Все работы
        </div>
        {error && <div className="text-danger text-sm px-3">{getErrorMessage(error)}</div>}
        {isLoading && (
          <div className="text-text-secondary text-sm px-3 inline-flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Загрузка
          </div>
        )}
        {sorted.map((f) => (
          <FolderRow
            key={f.id}
            folder={f}
            active={folderId === f.id}
            onSelect={() => onChange(f.id)}
          />
        ))}
      </div>
      {createOpen && (
        <FolderNameDialog
          title="Новая папка"
          placeholder="Например, Концепты"
          submitLabel="Создать"
          pending={createMut.isPending}
          onSubmit={submitCreate}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </aside>
  );
}

// ── Job card + menu ─────────────────────────────────────────────────────────

function ThumbnailPlaceholder({ section }: { section: string }) {
  const Icon = section === "audio" ? Music : section === "video" ? VideoIcon : ImageIcon;
  return (
    <div className="w-full h-full flex items-center justify-center bg-bg-elevated text-text-hint">
      <Icon size={32} />
    </div>
  );
}

function JobCardThumbnail({
  section,
  output,
  onAspect,
}: {
  section: string;
  output: GalleryOutput;
  onAspect: (aspect: number) => void;
}) {
  const imgSrc = output.thumbnailUrl ?? (section === "image" ? output.previewUrl : null);
  if (imgSrc) {
    return (
      <img
        src={imgSrc}
        alt=""
        loading="lazy"
        className="w-full h-full object-cover"
        onLoad={(e) => {
          const { naturalWidth, naturalHeight } = e.currentTarget;
          if (naturalWidth && naturalHeight) onAspect(naturalWidth / naturalHeight);
        }}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  if (section === "video") {
    // Кадр-превью бэк не отдал — рендерим само видео без controls и без
    // возможности запустить (pointer-events:none пробрасывает клик на карточку,
    // которая открывает Lightbox). `#t=0.001` гарантирует, что Safari/Firefox
    // отобразят первый кадр, а не чёрный poster.
    const videoSrc = output.previewUrl ?? output.outputUrl ?? null;
    if (videoSrc) {
      return (
        <video
          src={`${videoSrc}#t=0.001`}
          muted
          playsInline
          preload="metadata"
          disablePictureInPicture
          controlsList="nodownload nofullscreen noremoteplayback"
          className="w-full h-full object-cover pointer-events-none"
          onLoadedMetadata={(e) => {
            const { videoWidth, videoHeight } = e.currentTarget;
            if (videoWidth && videoHeight) onAspect(videoWidth / videoHeight);
          }}
          onError={(e) => {
            (e.currentTarget as HTMLVideoElement).style.display = "none";
          }}
        />
      );
    }
  }
  return <ThumbnailPlaceholder section={section} />;
}

const MENU_WIDTH = 224;

function JobCardMenu({
  job,
  output,
  folders,
  anchorRef,
  onClose,
  onOpenLightbox,
}: {
  job: GalleryJob;
  output: GalleryOutput;
  folders: GalleryFolder[];
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onOpenLightbox: () => void;
}) {
  const pushToast = useUIStore((s) => s.pushToast);
  const navigate = useNavigate();
  const addToFolder = useAddJobToGalleryFolder();
  const removeFromFolder = useRemoveJobFromGalleryFolder();
  const deleteOutput = useDeleteGalleryOutput();
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  // Считаем координаты после первого рендера меню — берём реальную высоту,
  // чтобы корректно решать "выше" vs "ниже" триггера. До получения координат
  // меню отрисовано off-screen (top:-9999), не моргает на месте якоря.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;
    const a = anchor.getBoundingClientRect();
    const menuH = menu.offsetHeight;
    const fitsAbove = a.top - menuH - 8 >= 8;
    const top = fitsAbove
      ? a.top - menuH - 4
      : Math.min(a.bottom + 4, window.innerHeight - menuH - 8);
    const left = Math.max(8, Math.min(window.innerWidth - MENU_WIDTH - 8, a.right - MENU_WIDTH));
    setCoords({ top, left });
  }, [anchorRef]);

  useEffect(() => {
    const onDocClick = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [onClose, anchorRef]);

  useEffect(() => {
    const onScroll = () => onClose();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose]);

  const toggleFolder = (folder: GalleryFolder) => {
    const isIn = job.folderIds.includes(folder.id);
    const opts = {
      onError: (err: unknown) => pushToast({ type: "error", message: getErrorMessage(err) }),
    };
    if (isIn) {
      removeFromFolder.mutate({ folderId: folder.id, jobId: job.id }, opts);
    } else {
      addToFolder.mutate({ folderId: folder.id, jobId: job.id }, opts);
    }
  };

  const handleDownload = async () => {
    try {
      const { url } = await getGalleryOriginalUrl(output.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      pushToast({ type: "error", message: getErrorMessage(err) });
    }
    onClose();
  };

  const handleDelete = () => {
    // Карточка = один output. Удаляем именно его; бэкенд снесёт всю джобу, только
    // если это был последний output (тогда `jobDeleted: true`).
    if (!window.confirm("Удалить этот результат безвозвратно?")) return;
    deleteOutput.mutate(output.id, {
      onSuccess: (res) =>
        pushToast({
          type: "success",
          message: res.jobDeleted ? "Работа удалена" : "Результат удалён",
        }),
      onError: (err) => pushToast({ type: "error", message: getErrorMessage(err) }),
    });
    onClose();
  };

  const handleRepeat = () => {
    const section = normalizeSection(job.section);
    if (!section) {
      pushToast({ type: "error", message: "Неизвестная секция" });
      return;
    }
    navigateToGenerate(navigate, {
      section,
      modelId: job.modelId,
      prompt: job.prompt,
      settings: job.modelSettings,
    });
    onClose();
  };

  const nonDefault = folders.filter((f) => !f.isDefault);

  const style: CSSProperties = coords
    ? { position: "fixed", top: coords.top, left: coords.left, width: MENU_WIDTH }
    : { position: "fixed", top: -9999, left: -9999, width: MENU_WIDTH };

  return createPortal(
    <div
      ref={menuRef}
      className="z-[110] card p-2 shadow-lg"
      style={{ ...style, background: "var(--bg-elevated)" }}
      onClick={(e) => e.stopPropagation()}
    >
      {nonDefault.length > 0 && (
        <>
          <div className="text-xs text-text-hint px-2 py-1">В папки</div>
          <div className="max-h-40 overflow-y-auto">
            {nonDefault.map((f) => (
              <label
                key={f.id}
                className="flex items-center gap-2 px-2 py-1 text-sm hover:bg-bg-secondary rounded cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={job.folderIds.includes(f.id)}
                  onChange={() => toggleFolder(f)}
                />
                <span className="truncate">{f.name}</span>
              </label>
            ))}
          </div>
          <div className="my-1 border-t border-[color:var(--border)]" />
        </>
      )}
      <button
        type="button"
        onClick={handleRepeat}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-bg-secondary rounded text-text"
      >
        <RotateCcw size={14} /> Повторить
      </button>
      <button
        type="button"
        onClick={handleDownload}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-bg-secondary rounded text-text"
      >
        <Download size={14} /> Скачать оригинал
      </button>
      <button
        type="button"
        onClick={() => {
          onClose();
          onOpenLightbox();
        }}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-bg-secondary rounded text-text"
      >
        <ImageIcon size={14} /> Открыть превью
      </button>
      <button
        type="button"
        onClick={handleDelete}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-bg-secondary rounded text-danger"
        disabled={deleteOutput.isPending}
      >
        <Trash2 size={14} /> Удалить
      </button>
    </div>,
    document.body,
  );
}

function JobCard({
  job,
  output,
  folders,
  favoritesFolderId,
  layout,
  onOpen,
}: {
  job: GalleryJob;
  output: GalleryOutput;
  folders: GalleryFolder[];
  favoritesFolderId: string | undefined;
  layout: GridLayout;
  onOpen: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pushToast = useUIStore((s) => s.pushToast);
  const addFav = useAddToGalleryFavorites();
  const removeFav = useRemoveFromGalleryFavorites();

  const isFav = favoritesFolderId ? job.folderIds.includes(favoritesFolderId) : false;
  const favPending = addFav.isPending || removeFav.isPending;
  // Имя + иконка модели (без эмодзи) из каталога; фоллбек — сохранённый modelName.
  const modelDisplay = getModelDisplay(job.modelId, job.modelName);

  // Аудио — нет визуального аспекта; всегда квадрат. Для image/video подождём
  // metadata из <img>/<video>, до этого рендерим квадрат-дефолт (span 4).
  const [aspect, setAspect] = useState<number | null>(job.section === "audio" ? 1 : null);
  const rowSpan = spanFromAspect(aspect);
  // В compact-режиме все тайлы квадратные на всех брейкпоинтах — masonry-span
  // отключаем, иначе тайлы вытягиваются в прямоугольники.
  const isCompact = layout === "compact";

  // Прогрев полного URL картинки: фоном при попадании во вьюпорт + точечно
  // на hover. Открытие Lightbox показывает full из кеша без задержки.
  const liRef = useRef<HTMLLIElement>(null);
  const fullUrl = job.section === "image" ? (output.previewUrl ?? output.outputUrl ?? null) : null;
  const shouldPrefetch = !!fullUrl && fullUrl !== output.thumbnailUrl;
  useEffect(() => {
    if (!shouldPrefetch || !fullUrl) return;
    const el = liRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            queuePreload(fullUrl);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [shouldPrefetch, fullUrl]);
  const handleHoverPrefetch = shouldPrefetch && fullUrl ? () => preloadImage(fullUrl) : undefined;

  const handleToggleFav = (e: MouseEvent) => {
    e.stopPropagation();
    const opts = {
      onError: (err: unknown) => pushToast({ type: "error", message: getErrorMessage(err) }),
    };
    if (isFav) removeFav.mutate(job.id, opts);
    else addFav.mutate(job.id, opts);
  };

  return (
    <li
      ref={liRef}
      onMouseEnter={handleHoverPrefetch}
      style={isCompact ? undefined : { gridRow: `span ${rowSpan}` }}
      className={`group relative card overflow-hidden cursor-pointer ${
        isCompact ? "aspect-square" : ""
      }`}
      onClick={onOpen}
    >
      <JobCardThumbnail section={job.section} output={output} onAspect={setAspect} />

      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/20 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

      <button
        type="button"
        onClick={handleToggleFav}
        disabled={favPending}
        title={isFav ? "Убрать из избранного" : "В избранное"}
        className="absolute top-2 right-2 p-1.5 rounded-full bg-black/40 hover:bg-black/60 text-white disabled:opacity-50"
      >
        <Heart size={16} fill={isFav ? "currentColor" : "none"} />
      </button>

      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        title="Действия"
        className="absolute bottom-2 right-2 p-1.5 rounded-full bg-black/40 hover:bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <MoreVertical size={16} />
      </button>

      <div className="absolute bottom-0 left-0 right-0 p-2 text-xs text-white opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        <div className="flex items-center gap-1.5 font-semibold min-w-0">
          {modelDisplay.icon && (
            <ModelAvatar
              className="shrink-0 w-4 h-4 flex items-center justify-center"
              icon={modelDisplay.icon}
              name={modelDisplay.name}
              iconSize={14}
            />
          )}
          <span className="truncate">{modelDisplay.name}</span>
        </div>
        {job.prompt && <div className="truncate text-white/70">{job.prompt}</div>}
      </div>

      {menuOpen && (
        <JobCardMenu
          job={job}
          output={output}
          folders={folders}
          anchorRef={triggerRef}
          onClose={() => setMenuOpen(false)}
          onOpenLightbox={onOpen}
        />
      )}
    </li>
  );
}

// ── Grid layout + grouping helpers ──────────────────────────────────────────

type GridLayout = "compact" | "large";

const GRID_CLASS: Record<GridLayout, string> = {
  // Compact: на всех брейкпоинтах квадратные тайлы (aspect-square на карточке);
  // без auto-rows — masonry не нужен.
  compact:
    "grid grid-cols-3 gap-2 sm:grid-cols-4 sm:gap-3 xl:grid-cols-6 2xl:grid-cols-8 list-none p-0 m-0",
  large:
    "grid grid-flow-dense grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 auto-rows-[100px] sm:auto-rows-[80px] gap-3 list-none p-0 m-0",
};

/** Локальная дата YYYY-MM-DD из ISO. en-CA-локаль даёт ISO-формат напрямую. */
function dayKey(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toLocaleDateString("en-CA");
}

function formatDayLabel(key: string): string {
  if (key === "unknown") return "Без даты";
  const today = new Date().toLocaleDateString("en-CA");
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = yesterdayDate.toLocaleDateString("en-CA");
  if (key === today) return "Сегодня";
  if (key === yesterday) return "Вчера";
  return new Date(key).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function groupByDay(
  jobs: GalleryJob[],
): Array<{ key: string; label: string; items: GalleryJob[] }> {
  const map = new Map<string, GalleryJob[]>();
  for (const j of jobs) {
    const key = dayKey(j.completedAt);
    const bucket = map.get(key);
    if (bucket) bucket.push(j);
    else map.set(key, [j]);
  }
  // Сортируем по убыванию ключа (новые сверху). "unknown" — в конец.
  return [...map.entries()]
    .sort(([a], [b]) => {
      if (a === "unknown") return 1;
      if (b === "unknown") return -1;
      return a < b ? 1 : -1;
    })
    .map(([key, items]) => ({ key, label: formatDayLabel(key), items }));
}

function GridLayoutSwitcher({
  value,
  onChange,
}: {
  value: GridLayout;
  onChange: (v: GridLayout) => void;
}) {
  const btn = (active: boolean) =>
    `p-1.5 rounded ${
      active ? "bg-accent text-white" : "bg-bg-elevated text-text-secondary hover:text-text"
    }`;
  return (
    <div className="flex items-center gap-1 md:hidden">
      <button
        type="button"
        onClick={() => onChange("compact")}
        className={btn(value === "compact")}
        title="Компактная сетка"
        aria-label="Компактная сетка"
      >
        <Grid3x3 size={16} />
      </button>
      <button
        type="button"
        onClick={() => onChange("large")}
        className={btn(value === "large")}
        title="Крупная сетка"
        aria-label="Крупная сетка"
      >
        <LayoutGrid size={16} />
      </button>
    </div>
  );
}

// ── Page root ───────────────────────────────────────────────────────────────

export default function GalleryPage() {
  const [section, setSection] = useState<Section>("");
  const [modelId, setModelId] = useState<string | undefined>(undefined);
  const [folderId, setFolderId] = useState<string | undefined>(undefined);
  const [gridLayout, setGridLayout] = useState<GridLayout>("large");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const { jobId } = useParams<{ jobId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);

  const previewOutputIdx = (() => {
    const raw = searchParams.get("o");
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  })();

  const params = useMemo(
    () => ({
      section: section || undefined,
      modelId,
      folderId,
    }),
    [section, modelId, folderId],
  );

  const { jobs, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage, error } =
    useInfiniteGalleryJobs(params);
  const { data: folders = [] } = useGalleryFolders();
  const detail = useGalleryJob(jobId);
  const favoritesFolderId = folders.find((f) => f.isDefault)?.id;

  const pendingJobs = usePendingJobsStore((s) => s.pendingJobs);
  const removePending = usePendingJobsStore((s) => s.remove);

  // Pending'и не привязаны к папкам и не имеют modelId-фильтрации до завершения —
  // если активен фильтр folder, прячем pending'и (иначе бы они «вылетали» из
  // выбранной папки). modelId сравниваем точно, section — нормализованный.
  // Success-pending'и не показываем: gallery query инвалидируется в момент
  // success WS и сама подхватит готовую работу (loader на success-тайле
  // визуально вводит в заблуждение). Error-pending — показываем, чтобы юзер
  // увидел причину и dismiss'нул.
  const visiblePending = useMemo<PendingJob[]>(() => {
    if (folderId) return [];
    const jobIds = new Set(jobs.map((j) => j.id));
    return pendingJobs.filter((p) => {
      if (p.status === "success") return false;
      if (jobIds.has(p.id)) return false;
      if (section && p.section !== section) return false;
      if (modelId && p.modelId !== modelId) return false;
      return true;
    });
  }, [pendingJobs, folderId, section, modelId, jobs]);

  // Сегодняшние failed-генерации. Gallery API возвращает только "done", поэтому
  // тянем отдельным запросом через `/web/generations` (тот же эндпоинт, что у
  // GenerationHistory). Скрытые юзером (`onDismiss`) фильтруем по persisted
  // store; in-session WS-error дедуплицируем по pendingIds (та же job уже
  // живёт как PendingTile-error до рефреша).
  const { data: failedToday = [] } = useGalleryFailedToday(section || undefined);
  const dismissedIds = useDismissedErrorsStore((s) => s.ids);
  const dismissError = useDismissedErrorsStore((s) => s.dismiss);
  const visibleFailed = useMemo<GenerationJobDto[]>(() => {
    if (folderId) return [];
    const dismissed = new Set(dismissedIds);
    const pendingIds = new Set(pendingJobs.map((p) => p.id));
    return failedToday.filter((j) => {
      if (dismissed.has(j.id)) return false;
      if (pendingIds.has(j.id)) return false;
      if (modelId && j.modelId !== modelId) return false;
      return true;
    });
  }, [failedToday, folderId, modelId, dismissedIds, pendingJobs]);

  const groups = useMemo(() => groupByDay(jobs), [jobs]);

  // Pending'и и сегодняшние failed идут в группу «Сегодня» — они логически
  // часть сегодняшней ленты. Если такой группы ещё нет (только что зашли,
  // jobs пустой / в jobs нет сегодняшних) — создаём пустую плейсхолдер-группу
  // под них.
  const todayKey = new Date().toLocaleDateString("en-CA");
  const groupsWithPending = useMemo(() => {
    if (visiblePending.length === 0 && visibleFailed.length === 0) return groups;
    if (groups.some((g) => g.key === todayKey)) return groups;
    return [
      { key: todayKey, label: formatDayLabel(todayKey), items: [] as GalleryJob[] },
      ...groups,
    ];
  }, [groups, visiblePending.length, visibleFailed.length, todayKey]);

  // Избранные работы — отдельной секцией наверху, дублируются в датах (видны и
  // там, и там, как «закреплённые» сверху). Скрываем секцию когда юзер уже
  // отфильтровал по папке — там и так показывается её содержимое.
  const favoriteJobs = useMemo<GalleryJob[]>(() => {
    if (folderId !== undefined || !favoritesFolderId) return [];
    return jobs.filter((j) => j.folderIds.includes(favoritesFolderId));
  }, [jobs, folderId, favoritesFolderId]);

  // 404 при прямом заходе на /gallery/{несуществующий-id} — toast + редирект.
  useEffect(() => {
    if (jobId && detail.isError) {
      pushToast({ type: "error", message: "Работа не найдена" });
      navigate("/gallery", { replace: true });
    }
  }, [jobId, detail.isError, navigate, pushToast]);

  // Infinite scroll: sentinel внизу страницы; пересечение viewport (с запасом
  // rootMargin) триггерит fetchNextPage. Перевешиваем observer когда меняются
  // hasNextPage/isFetchingNextPage (иначе колбэк держит stale ссылку).
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const handleSection = useCallback((s: Section) => {
    setSection(s);
    setModelId(undefined);
  }, []);

  const handleModel = useCallback((id: string | undefined) => {
    setModelId(id);
  }, []);

  const handleFolder = useCallback((id: string | undefined) => {
    setFolderId(id);
    // Сбрасываем выбранную модель — после смены фолдера её counts могут
    // отсутствовать в чипах, и список окажется пустым без видимой причины.
    setModelId(undefined);
  }, []);

  const toggleCollapsed = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleOpen = useCallback(
    (job: GalleryJob, outputIdx: number) =>
      navigate(outputIdx > 0 ? `/gallery/${job.id}?o=${outputIdx}` : `/gallery/${job.id}`),
    [navigate],
  );

  // Закрытие лайтбокса всегда ведёт на /gallery — не на предыдущий URL,
  // чтобы пользователь возвращался в галерею (а не, скажем, на /image).
  const handleCloseLightbox = useCallback(() => {
    navigate("/gallery");
  }, [navigate]);

  const gridClass = GRID_CLASS[gridLayout];
  const isEmpty =
    !isLoading && jobs.length === 0 && visiblePending.length === 0 && visibleFailed.length === 0;

  return (
    <div className="page">
      <div className="page-head rise flex items-start justify-between gap-3">
        <div>
          <h1 className="h1">Галерея</h1>
          <p className="sub">Все ваши генерации в одном месте.</p>
        </div>
        <GridLayoutSwitcher value={gridLayout} onChange={setGridLayout} />
      </div>

      <div className="flex flex-col gap-6 mt-4">
        <FolderSidebar folderId={folderId} onChange={handleFolder} />

        <div className="flex-1 min-w-0">
          <div className="flex flex-col gap-3 mb-4">
            <SectionChips section={section} onChange={handleSection} />
            <ModelFilterChips
              section={section}
              folderId={folderId}
              modelId={modelId}
              onChange={handleModel}
            />
          </div>

          {error && <div className="p-8 text-center text-danger">{getErrorMessage(error)}</div>}

          {isLoading && (
            <div className={gridClass}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} style={{ gridRow: "span 4" }} className="skeleton rounded" />
              ))}
            </div>
          )}

          {!isLoading && !error && (
            <div className="space-y-8">
              {favoriteJobs.length > 0 &&
                (() => {
                  const FAV_KEY = "__favorites";
                  const isCollapsed = collapsed.has(FAV_KEY);
                  return (
                    <section>
                      <button
                        type="button"
                        onClick={() => toggleCollapsed(FAV_KEY)}
                        className="flex items-center gap-2 mb-4 text-text-secondary hover:text-text transition-colors w-full text-left"
                      >
                        <ChevronDown
                          size={16}
                          className={`transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                        />
                        <Heart size={14} fill="currentColor" className="text-danger" />
                        <span className="text-sm font-semibold">Избранное</span>
                        <span className="text-xs text-text-hint">({favoriteJobs.length})</span>
                      </button>
                      {!isCollapsed && (
                        <ul className={gridClass}>
                          {favoriteJobs.flatMap((j) =>
                            j.outputs.map((o, idx) => (
                              <JobCard
                                key={`fav-${j.id}-${o.id}`}
                                job={j}
                                output={o}
                                folders={folders}
                                favoritesFolderId={favoritesFolderId}
                                layout={gridLayout}
                                onOpen={() => handleOpen(j, idx)}
                              />
                            )),
                          )}
                        </ul>
                      )}
                    </section>
                  );
                })()}

              {groupsWithPending.map((g) => {
                const isCollapsed = collapsed.has(g.key);
                const isToday = g.key === todayKey;
                const pendingHere = isToday ? visiblePending : [];
                const failedHere = isToday ? visibleFailed : [];
                const totalCount = g.items.length + pendingHere.length + failedHere.length;
                return (
                  <section key={g.key}>
                    <button
                      type="button"
                      onClick={() => toggleCollapsed(g.key)}
                      className="flex items-center gap-2 mb-4 text-text-secondary hover:text-text transition-colors w-full text-left"
                    >
                      <ChevronDown
                        size={16}
                        className={`transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                      />
                      <span className="text-sm font-semibold">{g.label}</span>
                      <span className="text-xs text-text-hint">({totalCount})</span>
                    </button>
                    {!isCollapsed && (
                      <ul className={gridClass}>
                        {failedHere.map((j) => (
                          <FailedTile
                            key={`f-${j.id}`}
                            job={j}
                            onDismiss={() => dismissError(j.id)}
                            compact={gridLayout === "compact"}
                          />
                        ))}
                        {pendingHere.map((p) => (
                          <PendingTile
                            key={`p-${p.id}`}
                            job={p}
                            onDismiss={() => removePending(p.id)}
                            compact={gridLayout === "compact"}
                          />
                        ))}
                        {g.items.flatMap((j) =>
                          j.outputs.map((o, idx) => (
                            <JobCard
                              key={`${j.id}-${o.id}`}
                              job={j}
                              output={o}
                              folders={folders}
                              favoritesFolderId={favoritesFolderId}
                              layout={gridLayout}
                              onOpen={() => handleOpen(j, idx)}
                            />
                          )),
                        )}
                      </ul>
                    )}
                  </section>
                );
              })}

              {isEmpty && (
                <div className="p-8 text-center text-text-secondary">Пока ничего нет</div>
              )}

              {/* Sentinel — последняя строка триггерит подгрузку. Высоты не имеет,
                  растягивается по ширине родителя, чтобы IntersectionObserver сработал. */}
              {hasNextPage && <div ref={sentinelRef} className="h-px w-full" aria-hidden />}

              {isFetchingNextPage && (
                <div className="flex justify-center py-4">
                  <Loader2 size={20} className="animate-spin text-text-hint" />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {jobId && detail.data && (
        <JobPreview
          key={detail.data.id}
          job={detail.data}
          folders={folders}
          initialOutputIdx={previewOutputIdx}
          onClose={handleCloseLightbox}
        />
      )}
    </div>
  );
}
