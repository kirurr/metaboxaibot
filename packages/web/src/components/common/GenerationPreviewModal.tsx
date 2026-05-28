import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Coins,
  Download,
  Music2,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/common/Button";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { GalleryFolder } from "@/api/gallery";

/**
 * Универсальная модалка просмотра output'а(-ов) генерации. Используется и в
 * ленте генерации (`GenerationHistory`), и в галерее (`Gallery` page).
 *
 * Layout: на весь экран замыленная копия медиа фоном, в центре сам медиа
 * (image/video/audio), инфо-карточка справа на >=lg (1024px) и снизу на мобиле.
 *
 * Поддерживает несколько output'ов одного job'а: prev/next стрелки + thumbnail
 * strip под медиа. Если output один — нав не рисуется. Эта же модалка лежит
 * в основе галерейного «Lightbox'а» — Gallery передаёт сюда все outputs job'а.
 *
 * Инфо-карточка опциональна (`info`). Внутри: title + meta-чипы (дата/токены),
 * сворачиваемый промпт, опциональные чипы папок (toggle add/remove),
 * кнопки «Повторить» / «Скачать оригинал» — рендерятся по наличию колбэков.
 */

export type PreviewOutput = {
  id: string;
  url: string;
  /** Картинка для backdrop blur и thumbnail-strip. Для image — own thumb (или
   *  сам url, если thumb'а нет); для video — thumb; для audio — null. */
  thumbnailUrl?: string | null;
};

export type PreviewFolders = {
  list: GalleryFolder[];
  /** Какие папки сейчас отмечены (из `job.folderIds`). */
  selectedIds: string[];
  onToggle: (folderId: string) => void;
};

export type PreviewInfo = {
  title: string;
  /** ISO-дата для чипа в шапке. */
  dateIso?: string | null;
  /** Уже отформатированное значение токенов — модалка не форматирует. */
  tokensValue?: string | null;
  prompt?: string | null;
  /** Закрытие модалки — на ответственности колбэка (нужно, чтобы caller мог
   *  показать toast при невалидной секции и оставить модалку открытой). */
  onRepeat?: () => void;
  /** Не закрывает модалку (скачивание открывается в новой вкладке). */
  onDownload?: () => void;
  /** Управление папками — только в галерее. Default-папка («Избранное»)
   *  отфильтровывается, ей управляют отдельной кнопкой-сердечком на карточке. */
  folders?: PreviewFolders;
};

export type GenerationPreviewModalProps = {
  outputs: PreviewOutput[];
  activeIdx: number;
  onActiveIdxChange: (idx: number) => void;
  /** "image" | "video" | "audio". */
  section: string;
  onClose: () => void;
  info?: PreviewInfo;
};

export function GenerationPreviewModal({
  outputs,
  activeIdx,
  onActiveIdxChange,
  section,
  onClose,
  info,
}: GenerationPreviewModalProps) {
  const { t } = useTranslation();
  // Десктоп-layout с >=lg (1024px). Планшеты в портрете получают мобильную
  // верстку: медиа сверху, инфо-карточка снизу.
  const isMobile = useIsMobile(1024);

  const active = outputs[activeIdx] ?? outputs[0];
  const hasMultiple = outputs.length > 1;

  const backdropUrl = !active
    ? null
    : section === "audio"
      ? null
      : section === "video"
        ? (active.thumbnailUrl ?? null)
        : (active.thumbnailUrl ?? active.url);

  // step через ref, чтобы keydown-listener не переподписывался на каждый клик.
  const step = (delta: number) => {
    const n = outputs.length;
    if (n <= 1) return;
    onActiveIdxChange((((activeIdx + delta) % n) + n) % n);
  };
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") stepRef.current(-1);
      else if (e.key === "ArrowRight") stepRef.current(1);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  if (!active) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4 lg:p-8 overflow-hidden"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop: замыленная копия медиа во весь экран. Картинка должна
          оставаться различимой (цвета, формы) — затемнение лёгкое, а сильное
          размытие даёт boke-эффект. Поверх — мягкая чёрная подложка для
          контраста с инфо-карточкой. Для audio (нет backdropUrl) подкладка
          плотнее, чтобы не было «серой стены». */}
      {backdropUrl ? (
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none bg-center bg-cover"
          style={{
            backgroundImage: `url("${backdropUrl}")`,
            filter: "blur(40px) brightness(0.85)",
            transform: "scale(1.1)",
          }}
        />
      ) : null}
      <div
        aria-hidden
        className={clsx(
          "absolute inset-0 pointer-events-none backdrop-blur-sm",
          backdropUrl ? "bg-black/35" : "bg-black/75",
        )}
      />

      <button
        type="button"
        onClick={onClose}
        aria-label={t("common.close")}
        className="absolute top-4 right-4 lg:top-6 lg:right-6 z-50 btn btn-ghost btn-icon"
      >
        <X size={20} />
      </button>

      {/* Внутренний контейнер НЕ останавливает propagation — иначе кликнуть в
          летербокс/гэп для закрытия было бы нельзя (он заполняет весь viewport).
          stopPropagation навешен точечно на сам контент: медиа, навигацию,
          thumbnail strip, инфо-карточку. */}
      <div className="relative w-full h-full flex flex-col lg:flex-row gap-4 lg:gap-8 overflow-hidden">
        {/* Media column: media + thumbnails-strip снизу. */}
        <div className="flex-1 min-h-0 flex flex-col gap-3">
          <div className="flex-1 min-h-0 flex items-center justify-center relative">
            {section === "video" ? (
              <video
                key={active.id}
                src={active.url}
                controls
                playsInline
                preload="metadata"
                onClick={(e) => e.stopPropagation()}
                className="max-w-full max-h-full object-contain rounded-[var(--radius)] shadow-2xl"
              />
            ) : section === "audio" ? (
              <div
                className="flex flex-col items-center gap-6 p-8"
                onClick={(e) => e.stopPropagation()}
              >
                <Music2 size={96} className="text-white/70" />
                <audio key={active.id} src={active.url} controls className="w-full max-w-md" />
              </div>
            ) : (
              <img
                key={active.id}
                src={active.url}
                alt=""
                onClick={(e) => e.stopPropagation()}
                className="max-w-full max-h-full object-contain rounded-[var(--radius)] shadow-2xl"
              />
            )}

            {hasMultiple && (
              <>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    step(-1);
                  }}
                  aria-label={t("common.back")}
                  className="absolute left-3 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full flex items-center justify-center border transition-opacity opacity-70 hover:opacity-100"
                  style={{
                    background: "rgba(0,0,0,0.5)",
                    backdropFilter: "blur(8px)",
                    borderColor: "var(--border-strong)",
                    color: "var(--text)",
                  }}
                >
                  <ChevronLeft size={20} />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    step(1);
                  }}
                  aria-label={t("common.next")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full flex items-center justify-center border transition-opacity opacity-70 hover:opacity-100"
                  style={{
                    background: "rgba(0,0,0,0.5)",
                    backdropFilter: "blur(8px)",
                    borderColor: "var(--border-strong)",
                    color: "var(--text)",
                  }}
                >
                  <ChevronRight size={20} />
                </button>
              </>
            )}
          </div>

          {hasMultiple && (
            <div
              className="flex items-center gap-2 overflow-x-auto [scrollbar-width:thin] shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              {outputs.map((o, i) => {
                const thumb = o.thumbnailUrl ?? (section === "image" ? o.url : null);
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => onActiveIdxChange(i)}
                    className={clsx(
                      "shrink-0 w-16 h-16 rounded overflow-hidden border-2 transition-colors",
                      i === activeIdx
                        ? "border-[var(--accent)]"
                        : "border-transparent hover:border-[var(--border-strong)]",
                    )}
                  >
                    {thumb ? (
                      <img src={thumb} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full bg-bg-elevated flex items-center justify-center text-text-hint">
                        <Music2 size={20} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {info && <PreviewInfoCard info={info} isMobile={isMobile} />}
      </div>
    </div>,
    document.body,
  );
}

function MetaChip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs"
      style={{ background: "var(--accent-lighter)", color: "var(--accent-light)" }}
    >
      {icon}
      {label}
    </span>
  );
}

function formatPreviewDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

function PreviewInfoCard({ info, isMobile }: { info: PreviewInfo; isMobile: boolean }) {
  const { t } = useTranslation();
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const promptRef = useRef<HTMLParagraphElement>(null);

  // Детект «реально ли промпт обрезан line-clamp'ом». Считаем один раз после
  // mount'а (промпт за время жизни модалки не меняется).
  useLayoutEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    setIsTruncated(el.scrollHeight - el.clientHeight > 1);
  }, [info.prompt]);

  const hasMeta = Boolean(info.dateIso || info.tokensValue);

  return (
    <aside
      className="relative shrink-0 w-full lg:w-[400px] card flex flex-col gap-4 text-white p-4 lg:p-6 min-h-0 overflow-hidden"
      style={{ background: "var(--bg-elevated)" }}
      onClick={(e) => e.stopPropagation()}
    >
      <h2 className="h2 shrink-0 break-words">{info.title}</h2>

      {hasMeta && (
        <div className="flex flex-wrap gap-1.5 shrink-0">
          {info.dateIso && (
            <MetaChip icon={<Calendar size={14} />} label={formatPreviewDate(info.dateIso)} />
          )}
          {info.tokensValue && (
            <MetaChip icon={<Coins size={14} />} label={`${info.tokensValue} ✦`} />
          )}
        </div>
      )}

      <div className="flex flex-col gap-2 min-h-0">
        <div
          className="text-xs uppercase tracking-wide shrink-0"
          style={{ color: "var(--text-secondary)" }}
        >
          {t("prompts.promptUsed")}
        </div>
        <div className="flex flex-col gap-2 bg-white/[0.04] rounded-[var(--radius)] p-3">
          <p
            ref={promptRef}
            className={clsx(
              "text-sm leading-relaxed whitespace-pre-wrap break-words text-text-secondary m-0",
              // Мобилка/планшет (<lg): всегда скролл, фикс. высота — карточка
              // не меняет размер при длинном промпте, нет кнопки «Развернуть».
              "max-lg:overflow-y-auto max-lg:max-h-[4.5rem] max-lg:pr-1",
              // Десктоп (lg+): line-clamp-3 в свёрнутом, max-h+scroll в раскрытом.
              !promptExpanded && "lg:line-clamp-3",
              promptExpanded && "lg:overflow-y-auto lg:max-h-[40vh] lg:pr-1",
            )}
          >
            {info.prompt || "—"}
          </p>
          {isTruncated && (
            <button
              type="button"
              onClick={() => setPromptExpanded((v) => !v)}
              aria-expanded={promptExpanded}
              className="hidden lg:inline-flex self-start items-center gap-1 text-xs text-text-hint hover:text-text transition-colors"
            >
              <ChevronDown
                size={14}
                className={clsx("transition-transform", promptExpanded && "rotate-180")}
              />
              {promptExpanded ? t("common.collapse") : t("common.expand")}
            </button>
          )}
        </div>
      </div>

      {info.folders && <FoldersSection folders={info.folders} />}

      <div className="flex flex-col gap-2 mt-auto shrink-0">
        {info.onRepeat && (
          <Button
            size={isMobile ? "md" : "lg"}
            rightIcon={<ArrowRight />}
            onClick={info.onRepeat}
            fullWidth
          >
            {t("common.retry")}
          </Button>
        )}
        {info.onDownload && (
          <Button
            variant="ghost"
            size={isMobile ? "md" : "lg"}
            leftIcon={<Download size={16} />}
            onClick={info.onDownload}
            fullWidth
          >
            {t("common.downloadOriginal")}
          </Button>
        )}
      </div>
    </aside>
  );
}

function FoldersSection({ folders }: { folders: PreviewFolders }) {
  const { t } = useTranslation();
  // Default («Избранное») управляется кнопкой-сердечком на карточке — не выводим.
  const nonDefault = useMemo(() => folders.list.filter((f) => !f.isDefault), [folders.list]);
  if (nonDefault.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 shrink-0">
      <div className="text-xs uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
        {t("common.addToFolders")}
      </div>
      <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
        {nonDefault.map((f) => {
          const active = folders.selectedIds.includes(f.id);
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => folders.onToggle(f.id)}
              className={clsx(
                "px-2.5 py-1 rounded-full text-xs transition-colors max-w-full truncate",
                active
                  ? "bg-accent text-white"
                  : "bg-white/[0.06] text-text-secondary hover:text-text hover:bg-white/[0.1]",
              )}
              title={f.name}
            >
              {f.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
