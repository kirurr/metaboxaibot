import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ImagePlus,
  Loader2,
  Music,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { useUploadedMedia, useDeleteUploadedMedia } from "@/hooks/useUploadedMedia";
import { useInfiniteGalleryJobs } from "@/hooks/useGallery";
import { useElements, useDeleteElement } from "@/hooks/useElements";
import { type Element } from "@/api/elements";
import { ElementEditPopup } from "./ElementEditPopup";

/**
 * Переиспользуемый попап выбора медиа для media-слота генерации.
 *
 * Карточка-модалка с переключателем секций сверху: **Upload** (ранее
 * загруженные пользователем файлы + плитка загрузки нового) и **Generated**
 * (завершённые генерации той же секции). Грид квадратных плиток; клик выбирает
 * медиа. Single-слот — клик сразу добавляет и закрывает; multi — мульти-выбор
 * до остатка места + кнопка «Готово».
 *
 * Переиспользование = вернуть родителю `ReusedMedia` (s3Key + метаданные); он
 * кладёт его в слот как готовый `SlotFile` без аплоада. Слот принимает любой
 * s3Key — бэкенд (`resolveMediaInputs`) пресайнит его на submit.
 */

export type SlotMediaType = "image" | "video" | "audio";

export type ReusedMedia = {
  s3Key: string;
  url: string | null;
  mimeType: string;
  name: string;
  type: SlotMediaType;
};

type Tab = "upload" | "generated" | "elements";

/** Что открывает попап редактирования элемента. */
type ElementEditState = { mode: "create" } | { mode: "edit"; element: Element } | null;

/** Синтетический MIME для generated-output (нужен только для детекта previewKind в слоте). */
function synthMime(type: SlotMediaType): string {
  return type === "image" ? "image/jpeg" : type === "video" ? "video/mp4" : "audio/mpeg";
}

export type MediaReusePopupProps = {
  slotType: SlotMediaType;
  /** MIME-список для системного файл-пикера в плитке загрузки. */
  accept: string;
  /** Остаток места в слоте (maxImages − кол-во ready). */
  room: number;
  /** maxImages > 1 — мульти-выбор. */
  multi: boolean;
  /** Загрузка новых файлов — делегат в `addToSlot` родителя. */
  onUpload: (files: FileList) => void;
  /** Выбранные медиа → родитель кладёт в слот. */
  onSelect: (items: ReusedMedia[]) => void;
  onClose: () => void;
};

type Tile = {
  /** Уникальный ключ плитки в гриде. */
  key: string;
  previewUrl: string | null;
  media: ReusedMedia;
  /** Подпись под плиткой — имя файла (uploaded) / промпт (generated). Показываем
   *  для аудио, у которого нет визуального превью. */
  label: string;
  /** Кнопка удаления (только для uploaded). */
  onDelete?: () => void;
};

export function MediaReusePopup({
  slotType,
  accept,
  room,
  multi,
  onUpload,
  onSelect,
  onClose,
}: MediaReusePopupProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("upload");
  const [selected, setSelected] = useState<ReusedMedia[]>([]);
  const [editing, setEditing] = useState<ElementEditState>(null);
  // Drill-in: открытый элемент, чьи картинки выбираем в слот (null — список элементов).
  const [viewingElementId, setViewingElementId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const uploaded = useUploadedMedia(slotType);
  const deleteMutation = useDeleteUploadedMedia(slotType);
  const generated = useInfiniteGalleryJobs({ section: slotType });

  // Elements — управление наборами референсных картинок. Только для image-слотов
  // (на video/audio вкладка скрыта — список не грузим).
  const elementsEnabled = slotType === "image";
  const { elements, isLoading: elementsLoading } = useElements(elementsEnabled);
  const deleteElementMutation = useDeleteElement();
  // Свежий объект (после рефетча списка), а не залипший — как в ElementEditPopup.
  const viewingElement = elements.find((e) => e.id === viewingElementId);

  // Переключение вкладки сбрасывает drill-in (возврат на Elements → список).
  function selectTab(next: Tab) {
    setTab(next);
    setViewingElementId(null);
  }

  // Esc закрывает попап. Но пока открыт вложенный ElementEditPopup (у него свой
  // Esc-листенер) — не реагируем, иначе Esc закрыл бы оба попапа разом.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editing) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, editing]);

  const uploadTiles: Tile[] = useMemo(
    () =>
      uploaded.items.map((it) => ({
        key: it.id,
        previewUrl: it.url,
        media: {
          s3Key: it.s3Key,
          url: it.url,
          mimeType: it.mimeType,
          name: it.name,
          type: it.type as SlotMediaType,
        },
        label: it.name,
        onDelete: () => deleteMutation.mutate(it.id),
      })),
    [uploaded.items, deleteMutation],
  );

  const generatedTiles: Tile[] = useMemo(
    () =>
      generated.jobs.flatMap((job) =>
        job.outputs
          .filter((o) => o.s3Key)
          .map((o) => ({
            key: o.id,
            previewUrl: o.thumbnailUrl ?? o.previewUrl,
            media: {
              s3Key: o.s3Key as string,
              url: o.previewUrl,
              mimeType: synthMime(slotType),
              name: job.modelName,
              type: slotType,
            },
            label: job.prompt || job.modelName,
          })),
      ),
    [generated.jobs, slotType],
  );

  // Картинки открытого элемента как выбираемые плитки (тот же механизм, что Uploads).
  const elementImageTiles: Tile[] = useMemo(
    () =>
      (viewingElement?.media ?? []).map((m) => ({
        key: m.id,
        previewUrl: m.url,
        media: { s3Key: m.s3Key, url: m.url, mimeType: m.mimeType, name: m.name, type: "image" },
        label: m.name,
      })),
    [viewingElement],
  );

  const active = tab === "upload" ? uploaded : generated;
  const tiles = tab === "upload" ? uploadTiles : generatedTiles;

  // Infinite-scroll: один сентинел, подгружает активную секцию.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && active.hasNextPage && !active.isFetchingNextPage) {
          active.fetchNextPage();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [active]);

  function isSelected(s3Key: string) {
    return selected.some((s) => s.s3Key === s3Key);
  }

  function pick(media: ReusedMedia) {
    if (!multi) {
      onSelect([media]);
      onClose();
      return;
    }
    setSelected((prev) => {
      if (prev.some((s) => s.s3Key === media.s3Key)) {
        return prev.filter((s) => s.s3Key !== media.s3Key);
      }
      if (prev.length >= room) return prev; // не больше остатка места в слоте
      return [...prev, media];
    });
  }

  function confirm() {
    if (selected.length > 0) onSelect(selected);
    onClose();
  }

  const sectionLabel =
    slotType === "video"
      ? t("mediaReuse.generatedVideo")
      : slotType === "audio"
        ? t("mediaReuse.generatedAudio")
        : t("mediaReuse.generatedImage");

  function renderPreview(type: SlotMediaType, url: string | null, alt: string) {
    if (!url || type === "audio") {
      return (
        <div className="flex h-full w-full items-center justify-center text-text-secondary">
          <Music size={20} />
        </div>
      );
    }
    if (type === "video") {
      return (
        <video src={url} muted playsInline preload="metadata" className="size-full object-cover" />
      );
    }
    return <img src={url} alt={alt} loading="lazy" className="size-full object-cover" />;
  }

  function renderTile(tile: Tile) {
    const sel = isSelected(tile.media.s3Key);
    const atCap = multi && !sel && selected.length >= room;
    return (
      <div key={tile.key} className="relative group">
        <button
          type="button"
          disabled={atCap}
          onClick={() => pick(tile.media)}
          className={clsx(
            "relative aspect-square w-full overflow-hidden rounded-[var(--radius)] bg-bg-elevated",
            "ring-2 transition",
            sel ? "ring-accent" : "ring-transparent hover:ring-white/30",
            atCap && "opacity-40 cursor-not-allowed",
          )}
        >
          {renderPreview(tile.media.type, tile.previewUrl, tile.media.name)}
          {tile.media.type === "audio" && (
            <div
              className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-2 py-1.5 text-left text-xs font-medium text-white backdrop-blur-sm"
              title={tile.label}
            >
              {tile.label}
            </div>
          )}
          {sel && (
            <div className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-accent text-on-accent">
              <Check size={12} />
            </div>
          )}
        </button>
        {tile.onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              tile.onDelete?.();
            }}
            aria-label={t("mediaReuse.delete")}
            className="absolute left-1 top-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 sm:hidden sm:group-hover:flex"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    );
  }

  function renderElementCard(el: Element) {
    const cover = el.media[0]?.url ?? null;
    const pending = deleteElementMutation.isPending && deleteElementMutation.variables === el.id;
    return (
      <div key={el.id} className={clsx("group", pending && "opacity-40")}>
        <div className="relative">
          <button
            type="button"
            onClick={() => setViewingElementId(el.id)}
            className="relative aspect-square w-full overflow-hidden rounded-[var(--radius)] bg-bg-elevated ring-2 ring-transparent transition hover:ring-white/30"
          >
            {cover ? (
              <img src={cover} alt={el.name} loading="lazy" className="size-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-text-secondary">
                <ImagePlus size={20} />
              </div>
            )}
          </button>
          {/* Кнопки редактировать / удалить (siblings, не вложены в кнопку-плитку).
              На мобилке видны всегда (нет hover), на десктопе — по наведению. */}
          <div className="absolute right-1 top-1 flex gap-1 sm:hidden sm:group-hover:flex">
            <button
              type="button"
              onClick={() => setEditing({ mode: "edit", element: el })}
              aria-label={t("mediaReuse.editElement")}
              className="flex size-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
            >
              <Pencil size={11} />
            </button>
            <button
              type="button"
              onClick={() => deleteElementMutation.mutate(el.id)}
              aria-label={t("mediaReuse.delete")}
              className="flex size-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
            >
              <Trash2 size={11} />
            </button>
          </div>
        </div>
        <div className="mt-1 truncate text-center text-xs text-text" title={el.name}>
          @{el.name}
        </div>
      </div>
    );
  }

  // Вкладка Elements: drill-in (картинки открытого элемента) либо список элементов.
  function renderElementsTab() {
    if (viewingElement) {
      return (
        <>
          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setViewingElementId(null)}
              className="btn btn-ghost btn-icon shrink-0"
              aria-label={t("mediaReuse.back")}
            >
              <ChevronLeft size={16} />
            </button>
            <span className="min-w-0 truncate text-sm font-medium text-text">
              @{viewingElement.name}
            </span>
          </div>
          {elementImageTiles.length === 0 ? (
            <div className="py-8 text-center text-text-secondary">
              {t("mediaReuse.elementImagesEmpty")}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {elementImageTiles.map((tile) => renderTile(tile))}
            </div>
          )}
        </>
      );
    }
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <button
          type="button"
          onClick={() => setEditing({ mode: "create" })}
          className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-[var(--radius)] border border-dashed border-white/20 bg-bg-elevated text-text-secondary transition hover:border-white/40 hover:text-white"
        >
          <Plus size={20} />
          <span className="text-xs">{t("mediaReuse.createElement")}</span>
        </button>

        {elementsLoading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="aspect-square w-full rounded-[var(--radius)] skeleton" />
            ))
          : elements.map((el) => renderElementCard(el))}
      </div>
    );
  }

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      >
        <div
          className="card flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden p-0 sm:max-h-[80vh]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header: переключатель секций (скроллится по горизонтали на узких
            экранах) + кнопка закрытия (всегда видна справа). */}
          <div className="flex items-center gap-3 border-b border-white/10 p-3 sm:p-4">
            <div className="min-w-0 flex-1 snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="inline-flex gap-2 rounded-xl bg-bg-elevated p-1">
                {(
                  [
                    ["upload", t("mediaReuse.tabUpload")],
                    ["generated", sectionLabel],
                    ...(elementsEnabled
                      ? ([["elements", t("mediaReuse.tabElements")]] as const)
                      : []),
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => selectTab(key)}
                    className={clsx(
                      "h-9 shrink-0 snap-start whitespace-nowrap rounded-lg px-3.5 text-sm font-medium transition",
                      tab === key
                        ? "bg-bg-card text-text shadow-sm"
                        : "text-text-secondary hover:text-text",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <button
              className="btn btn-ghost btn-icon shrink-0"
              onClick={onClose}
              aria-label={t("common.close")}
            >
              <X size={16} />
            </button>
          </div>

          {/* Body. Mobile: заметная высота (min 55vh, потолок 70vh) — попап не
            выглядит куцым. Desktop (sm+): высота от контента (по умолчанию одна
            row), растёт до 45vh, дальше скроллит. scrollbar-gutter:stable —
            чтобы появление скроллбара не сдвигало контент по горизонтали. */}
          <div className="min-h-[55vh] max-h-[70vh] overflow-y-auto p-4 [scrollbar-gutter:stable] sm:min-h-0 sm:max-h-[45vh]">
            {tab === "elements" ? (
              renderElementsTab()
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {tab === "upload" && (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-[var(--radius)] border border-dashed border-white/20 bg-bg-elevated text-text-secondary transition hover:border-white/40 hover:text-white"
                    >
                      <Upload size={20} />
                      <span className="text-xs">{t("mediaReuse.upload")}</span>
                    </button>
                  )}

                  {active.isLoading
                    ? Array.from({ length: 8 }).map((_, i) => (
                        <div
                          key={i}
                          className="aspect-square w-full rounded-[var(--radius)] skeleton"
                        />
                      ))
                    : tiles.map((tile) => renderTile(tile))}
                </div>

                {!active.isLoading && tab === "generated" && tiles.length === 0 && (
                  <div className="py-8 text-center text-text-secondary">
                    {t("mediaReuse.emptyGenerated")}
                  </div>
                )}

                <div ref={sentinelRef} className="h-6" />
                {active.isFetchingNextPage && (
                  <div className="flex justify-center py-2 text-text-secondary">
                    <Loader2 size={18} className="spin" />
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer (multi only) */}
          {multi && (
            <div className="flex items-center justify-between gap-4 border-t border-white/10 p-4">
              <span className="text-sm text-text-secondary">
                {t("mediaPicker.selectedOf", { n: selected.length, max: room })}
              </span>
              <button
                className="btn btn-primary"
                disabled={selected.length === 0}
                onClick={confirm}
              >
                {t("mediaReuse.done")}
              </button>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept={accept}
            multiple={multi}
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) onUpload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {editing && <ElementEditPopup {...editing} onClose={() => setEditing(null)} />}
    </>
  );
}
