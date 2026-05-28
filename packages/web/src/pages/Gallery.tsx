import {
  type CSSProperties,
  type FormEvent,
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
import { useNavigate, useParams } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FolderPlus,
  Heart,
  Image as ImageIcon,
  Loader2,
  MoreVertical,
  Music,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
  Video as VideoIcon,
  X,
} from "lucide-react";
import { getGalleryOriginalUrl, type GalleryFolder, type GalleryJob } from "@/api/gallery";
import {
  useAddJobToGalleryFolder,
  useAddToGalleryFavorites,
  useCreateGalleryFolder,
  useDeleteGalleryFolder,
  useDeleteGalleryJob,
  useGalleryFolders,
  useGalleryJob,
  useGalleryJobs,
  useGalleryModelCounts,
  useRemoveFromGalleryFavorites,
  useRemoveJobFromGalleryFolder,
  useUpdateGalleryFolder,
} from "@/hooks/useGallery";
import { Button } from "@/components/common/Button";
import { Input } from "@/components/common/Input";
import {
  GenerationPreviewModal,
  type PreviewOutput,
} from "@/components/common/GenerationPreviewModal";
import { useModelsStore } from "@/stores/modelsStore";
import { useUIStore } from "@/stores/uiStore";
import { navigateToGenerate, normalizeSection } from "@/utils/navigateToGenerate";
import { formatTokens } from "@/utils/format";

type Section = "" | "image" | "audio" | "video";

const PAGE_LIMIT = 24;

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
    for (const model of models) m.set(model.id, model.name);
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

/**
 * Модалка для ввода имени папки — общий компонент для create и rename.
 * Submit-кнопка disabled пока поле пустое или не изменилось от initialValue.
 */
function FolderNameDialog({
  title,
  initialValue = "",
  placeholder,
  submitLabel,
  pending,
  onSubmit,
  onClose,
}: {
  title: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel: string;
  pending: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== initialValue.trim() && !pending;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 anim-page-in"
      onClick={onClose}
    >
      <div
        className="fixed inset-0"
        style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      />
      <form
        onSubmit={handleSubmit}
        className="relative card w-full max-w-sm p-5 z-10"
        style={{ background: "var(--bg-elevated)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          className="absolute top-3 right-3 text-text-hint hover:text-text"
        >
          <X size={18} />
        </button>
        <h3 className="text-base font-semibold mb-3">{title}</h3>
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          maxLength={64}
        />
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" size="sm" disabled={!canSubmit} loading={pending}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}

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
  job,
  onAspect,
}: {
  job: GalleryJob;
  onAspect: (aspect: number) => void;
}) {
  const first = job.outputs[0];
  const imgSrc = first?.thumbnailUrl ?? (job.section === "image" ? first?.previewUrl : null);
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
  if (job.section === "video") {
    // Кадр-превью бэк не отдал — рендерим само видео без controls и без
    // возможности запустить (pointer-events:none пробрасывает клик на карточку,
    // которая открывает Lightbox). `#t=0.001` гарантирует, что Safari/Firefox
    // отобразят первый кадр, а не чёрный poster.
    const videoSrc = first?.previewUrl ?? first?.outputUrl ?? null;
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
  return <ThumbnailPlaceholder section={job.section} />;
}

const MENU_WIDTH = 224;

function JobCardMenu({
  job,
  folders,
  anchorRef,
  onClose,
  onOpenLightbox,
}: {
  job: GalleryJob;
  folders: GalleryFolder[];
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onOpenLightbox: () => void;
}) {
  const pushToast = useUIStore((s) => s.pushToast);
  const navigate = useNavigate();
  const addToFolder = useAddJobToGalleryFolder();
  const removeFromFolder = useRemoveJobFromGalleryFolder();
  const deleteJob = useDeleteGalleryJob();
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
    const out = job.outputs[0];
    if (!out) return;
    try {
      const { url } = await getGalleryOriginalUrl(out.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      pushToast({ type: "error", message: getErrorMessage(err) });
    }
    onClose();
  };

  const handleDelete = () => {
    if (!window.confirm("Удалить работу безвозвратно?")) return;
    deleteJob.mutate(job.id, {
      onSuccess: () => pushToast({ type: "success", message: "Работа удалена" }),
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
        disabled={deleteJob.isPending}
      >
        <Trash2 size={14} /> Удалить
      </button>
    </div>,
    document.body,
  );
}

function JobCard({
  job,
  folders,
  favoritesFolderId,
  onOpen,
}: {
  job: GalleryJob;
  folders: GalleryFolder[];
  favoritesFolderId: string | undefined;
  onOpen: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pushToast = useUIStore((s) => s.pushToast);
  const addFav = useAddToGalleryFavorites();
  const removeFav = useRemoveFromGalleryFavorites();

  const isFav = favoritesFolderId ? job.folderIds.includes(favoritesFolderId) : false;
  const favPending = addFav.isPending || removeFav.isPending;

  // Аудио — нет визуального аспекта; всегда квадрат. Для image/video подождём
  // metadata из <img>/<video>, до этого рендерим квадрат-дефолт (span 4).
  const [aspect, setAspect] = useState<number | null>(job.section === "audio" ? 1 : null);
  const rowSpan = spanFromAspect(aspect);

  const handleToggleFav = (e: MouseEvent) => {
    e.stopPropagation();
    const opts = {
      onError: (err: unknown) => pushToast({ type: "error", message: getErrorMessage(err) }),
    };
    if (isFav) removeFav.mutate(job.id, opts);
    else addFav.mutate(job.id, opts);
  };

  return (
    <div
      style={{ gridRow: `span ${rowSpan}` }}
      className="group relative card overflow-hidden cursor-pointer"
      onClick={onOpen}
    >
      <JobCardThumbnail job={job} onAspect={setAspect} />

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
        <div className="truncate font-semibold">{job.modelName}</div>
        {job.prompt && <div className="truncate text-white/70">{job.prompt}</div>}
      </div>

      {menuOpen && (
        <JobCardMenu
          job={job}
          folders={folders}
          anchorRef={triggerRef}
          onClose={() => setMenuOpen(false)}
          onOpenLightbox={onOpen}
        />
      )}
    </div>
  );
}

// ── Preview (общая модалка) ─────────────────────────────────────────────────

/**
 * Адаптер `GalleryJob` → пропсы `GenerationPreviewModal`. Активный output
 * хранится локально (resets на каждое открытие — `key={job.id}` в GalleryPage).
 * Кроме повтор/скачивания — здесь же чипы папок (toggle add/remove).
 */
function GalleryPreview({
  job,
  folders,
  onClose,
}: {
  job: GalleryJob;
  folders: GalleryFolder[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);
  const addToFolder = useAddJobToGalleryFolder();
  const removeFromFolder = useRemoveJobFromGalleryFolder();
  const [activeIdx, setActiveIdx] = useState(0);

  const previewOutputs = useMemo<PreviewOutput[]>(
    () =>
      job.outputs
        .map((o) => ({
          id: o.id,
          url: o.previewUrl ?? o.outputUrl ?? "",
          thumbnailUrl: o.thumbnailUrl,
        }))
        .filter((o) => o.url),
    [job.outputs],
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

  if (previewOutputs.length === 0) return null;

  const tokensValue =
    job.tokensSpent && job.tokensSpent !== "0" ? formatTokens(job.tokensSpent) : null;
  const safeIdx = Math.min(activeIdx, previewOutputs.length - 1);

  return (
    <GenerationPreviewModal
      outputs={previewOutputs}
      activeIdx={safeIdx}
      onActiveIdxChange={setActiveIdx}
      section={job.section}
      onClose={onClose}
      info={{
        title: job.modelName,
        dateIso: job.completedAt,
        tokensValue,
        prompt: job.prompt,
        onRepeat: handleRepeat,
        onDownload: handleDownload,
        folders: {
          list: folders,
          selectedIds: job.folderIds,
          onToggle: handleToggleFolder,
        },
      }}
    />
  );
}

// ── Job grid ────────────────────────────────────────────────────────────────

function JobGrid({
  jobs,
  isLoading,
  error,
  folders,
  favoritesFolderId,
  onOpen,
}: {
  jobs: GalleryJob[];
  isLoading: boolean;
  error: unknown;
  folders: GalleryFolder[];
  favoritesFolderId: string | undefined;
  onOpen: (job: GalleryJob) => void;
}) {
  if (error) {
    return <div className="p-8 text-center text-danger">{getErrorMessage(error)}</div>;
  }
  if (isLoading) {
    return (
      <div className="grid grid-flow-dense grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 auto-rows-[100px] sm:auto-rows-[80px] gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ gridRow: "span 4" }} className="skeleton rounded" />
        ))}
      </div>
    );
  }
  if (jobs.length === 0) {
    return <div className="p-8 text-center text-text-secondary">Пока ничего нет</div>;
  }
  return (
    <div className="grid grid-flow-dense grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 auto-rows-[100px] sm:auto-rows-[80px] gap-3">
      {jobs.map((j) => (
        <JobCard
          key={j.id}
          job={j}
          folders={folders}
          favoritesFolderId={favoritesFolderId}
          onOpen={() => onOpen(j)}
        />
      ))}
    </div>
  );
}

// ── Pagination ──────────────────────────────────────────────────────────────

function Pagination({
  page,
  total,
  limit,
  onChange,
}: {
  page: number;
  total: number;
  limit: number;
  onChange: (p: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-3 mt-6 text-sm text-text-secondary">
      <Button
        variant="ghost"
        size="sm"
        leftIcon={<ChevronLeft size={14} />}
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        Назад
      </Button>
      <span>
        Стр. {page} из {totalPages}, всего {total}
      </span>
      <Button
        variant="ghost"
        size="sm"
        rightIcon={<ChevronRight size={14} />}
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        Вперёд
      </Button>
    </div>
  );
}

// ── Page root ───────────────────────────────────────────────────────────────

export default function GalleryPage() {
  const [section, setSection] = useState<Section>("");
  const [modelId, setModelId] = useState<string | undefined>(undefined);
  const [folderId, setFolderId] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);

  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);

  const params = useMemo(
    () => ({
      section: section || undefined,
      modelId,
      folderId,
      page,
      limit: PAGE_LIMIT,
    }),
    [section, modelId, folderId, page],
  );

  const { data: jobsData, isLoading, error } = useGalleryJobs(params);
  const { data: folders = [] } = useGalleryFolders();
  const detail = useGalleryJob(jobId);
  const favoritesFolderId = folders.find((f) => f.isDefault)?.id;
  const jobs = jobsData?.items ?? [];
  const total = jobsData?.total ?? 0;

  // 404 при прямом заходе на /gallery/{несуществующий-id} — toast + редирект.
  useEffect(() => {
    if (jobId && detail.isError) {
      pushToast({ type: "error", message: "Работа не найдена" });
      navigate("/gallery", { replace: true });
    }
  }, [jobId, detail.isError, navigate, pushToast]);

  const handleSection = useCallback((s: Section) => {
    setSection(s);
    setModelId(undefined);
    setPage(1);
  }, []);

  const handleModel = useCallback((id: string | undefined) => {
    setModelId(id);
    setPage(1);
  }, []);

  const handleFolder = useCallback((id: string | undefined) => {
    setFolderId(id);
    // Сбрасываем выбранную модель — после смены фолдера её counts могут
    // отсутствовать в чипах, и список окажется пустым без видимой причины.
    setModelId(undefined);
    setPage(1);
  }, []);

  const handleOpen = useCallback((job: GalleryJob) => navigate(`/gallery/${job.id}`), [navigate]);

  // Закрытие лайтбокса всегда ведёт на /gallery — не на предыдущий URL,
  // чтобы пользователь возвращался в галерею (а не, скажем, на /image).
  const handleCloseLightbox = useCallback(() => {
    navigate("/gallery");
  }, [navigate]);

  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1 className="h1">Галерея</h1>
          <p className="sub">Все ваши генерации в одном месте.</p>
        </div>
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

          <JobGrid
            jobs={jobs}
            isLoading={isLoading}
            error={error}
            folders={folders}
            favoritesFolderId={favoritesFolderId}
            onOpen={handleOpen}
          />

          <Pagination page={page} total={total} limit={PAGE_LIMIT} onChange={setPage} />
        </div>
      </div>

      {jobId && detail.data && (
        <GalleryPreview
          key={detail.data.id}
          job={detail.data}
          folders={folders}
          onClose={handleCloseLightbox}
        />
      )}
    </div>
  );
}
