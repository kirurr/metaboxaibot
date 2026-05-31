import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Coins,
  Copy,
  Download,
  FolderPlus,
  Heart,
  Images,
  Maximize2,
  Music2,
  Trash2,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/common/Button";
import { ModelAvatar } from "@/components/common/ModelAvatar";
import { FolderNameDialog } from "@/components/common/FolderNameDialog";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { ShotEntry } from "@/utils/multishot";
import type { SettingRow } from "@/utils/settingsDisplay";
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
  /** Создать новую папку (открывает диалог ввода имени). */
  onCreate?: (name: string) => void;
};

export type PreviewInfo = {
  title: string;
  /** Путь к монохромной иконке модели рядом с заголовком (если есть). */
  iconPath?: string | null;
  /** ISO-дата для чипа в шапке. */
  dateIso?: string | null;
  /** Уже отформатированное значение токенов — модалка не форматирует. */
  tokensValue?: string | null;
  prompt?: string | null;
  /** Мультишот (Kling): промпты живут по шотам, top-level `prompt` пустой. Если
   *  список непустой — секция промпта рендерит список шотов вместо одиночного. */
  shots?: ShotEntry[];
  /** Настройки генерации (label/value), уже отрезолвленные caller'ом. */
  settings?: SettingRow[];
  /** Избранное: текущее состояние + тоггл. Кнопка-сердечко рендерится только
   *  если задан `onToggleFavorite`. */
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  /** Удаление джобы (на ответственности колбэка: confirm + закрытие модалки). */
  onDelete?: () => void;
  /** Открыть текущий output в другом инструменте. Рендерятся по наличию колбэка
   *  (image-output: animate/reference/upscale; video-output: только upscale). */
  onAnimate?: () => void;
  onReference?: () => void;
  onUpscale?: () => void;
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

      {/* Крестик уровня overlay — только когда нет инфо-карточки (она держит
          свой крестик в шапке). Иначе на экране было бы два крестика. */}
      {!info && (
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="absolute top-4 right-4 lg:top-6 lg:right-6 z-50 btn btn-ghost btn-icon"
        >
          <X size={20} />
        </button>
      )}

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
              <ProgressiveImage
                key={active.id}
                src={active.url}
                thumbnailUrl={active.thumbnailUrl ?? null}
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

        {info && <PreviewInfoCard info={info} isMobile={isMobile} onClose={onClose} />}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Прогрессивная картинка: thumb рисуется как `background-image` контейнера —
 * стабильный фон без `<img>`-flicker'а. Full абсолютно поверх с `opacity-0`,
 * грузится с `fetchPriority="high"`; в `onLoad` ждём `decode()` (готовность
 * к paint без частичного кадра), только потом фейдим в `opacity-100`.
 * Если thumb нет — рендерим один `<img>` как раньше.
 */
function ProgressiveImage({ src, thumbnailUrl }: { src: string; thumbnailUrl: string | null }) {
  const hasThumb = !!thumbnailUrl && thumbnailUrl !== src;
  const [fullLoaded, setFullLoaded] = useState(false);

  const handleLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    img
      .decode()
      .then(() => setFullLoaded(true))
      .catch(() => setFullLoaded(true));
  };

  if (!hasThumb) {
    return (
      <img
        src={src}
        alt=""
        fetchPriority="high"
        decoding="async"
        onClick={(e) => e.stopPropagation()}
        className="max-w-full max-h-full object-contain rounded-[var(--radius)] shadow-2xl"
      />
    );
  }

  return (
    <div
      className="relative w-full h-full"
      style={{
        backgroundImage: `url("${thumbnailUrl}")`,
        backgroundSize: "contain",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <img
        src={src}
        alt=""
        fetchPriority="high"
        decoding="async"
        onLoad={handleLoad}
        className={clsx(
          "absolute inset-0 w-full h-full object-contain rounded-[var(--radius)] shadow-2xl transition-opacity duration-300",
          !fullLoaded && "opacity-0",
        )}
      />
    </div>
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

function PreviewInfoCard({
  info,
  isMobile,
  onClose,
}: {
  info: PreviewInfo;
  isMobile: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const hasMeta = Boolean(info.dateIso || info.tokensValue);
  const shots = info.shots ?? [];

  return (
    <aside
      className="relative shrink-0 w-full lg:w-[400px] card flex flex-col gap-4 text-white p-4 lg:p-6 min-h-0 overflow-hidden"
      style={{ background: "var(--bg-elevated)" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 shrink-0 min-w-0">
        {info.iconPath && (
          <ModelAvatar
            className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center bg-white/10 text-white"
            icon={info.iconPath}
            name={info.title}
            iconSize={16}
          />
        )}
        <h2 className="text-base font-semibold break-words m-0 min-w-0 flex-1">{info.title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="shrink-0 -mr-1 -mt-1 btn btn-ghost btn-icon"
        >
          <X size={18} />
        </button>
      </div>

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

      {/* Секция промпта: мультишот (список шотов) → одиночный промпт → ничего
          (пустой промпт прочерком больше не рисуем). */}
      {shots.length > 0 ? (
        <MultiShotSection shots={shots} />
      ) : info.prompt?.trim() ? (
        <SinglePromptSection prompt={info.prompt} />
      ) : null}

      {info.settings && info.settings.length > 0 && <SettingsSection rows={info.settings} />}

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

        {/* Творческие продолжения — равные тайлы (иконка над подписью). */}
        {(info.onAnimate || info.onReference || info.onUpscale) && (
          <div className="flex gap-2">
            {info.onAnimate && (
              <ActionTile
                icon={<Clapperboard size={18} />}
                label={t("common.animate")}
                onClick={info.onAnimate}
              />
            )}
            {info.onReference && (
              <ActionTile
                icon={<Images size={18} />}
                label={t("common.reference")}
                onClick={info.onReference}
              />
            )}
            {info.onUpscale && (
              <ActionTile
                icon={<Maximize2 size={18} />}
                label={t("common.upscale")}
                onClick={info.onUpscale}
              />
            )}
          </div>
        )}

        {/* Утилиты — компактный ряд иконок с подписью, отделён линией. */}
        {(info.onDownload || info.onToggleFavorite || info.onDelete) && (
          <>
            <div className="border-t border-[color:var(--border)] mt-1" />
            <div className="flex items-center gap-1">
              {info.onDownload && (
                <UtilityAction
                  icon={<Download size={16} />}
                  label={t("common.save")}
                  onClick={info.onDownload}
                />
              )}
              {info.onToggleFavorite && (
                <UtilityAction
                  icon={<Heart size={16} fill={info.isFavorite ? "currentColor" : "none"} />}
                  label={info.isFavorite ? t("common.inFavorites") : t("common.favorite")}
                  onClick={info.onToggleFavorite}
                />
              )}
              {info.onDelete && (
                <UtilityAction
                  icon={<Trash2 size={16} />}
                  label={t("common.delete")}
                  onClick={info.onDelete}
                  danger
                />
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

/** Тайл «творческого» действия: иконка над короткой подписью, равная ширина. */
function ActionTile({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 min-w-0 flex flex-col items-center justify-center gap-1 py-2.5 rounded-[var(--radius)] bg-white/[0.06] text-text hover:bg-white/[0.1] transition-colors"
    >
      {icon}
      <span className="text-xs truncate max-w-full">{label}</span>
    </button>
  );
}

/** Компактное действие-утилита: иконка + подпись в строку, ghost-стиль. */
function UtilityAction({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex-1 min-w-0 inline-flex items-center justify-center gap-1.5 px-2 py-2 rounded text-xs transition-colors",
        danger ? "text-danger hover:text-text" : "text-text-secondary hover:text-text",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function PromptSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="text-xs uppercase tracking-wide shrink-0"
      style={{ color: "var(--text-secondary)" }}
    >
      {children}
    </div>
  );
}

/** Иконка-кнопка «копировать» с transient-состоянием «скопировано». */
function CopyButton({ text, className }: { text: string; className?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);

  const copy = () => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    clearTimeout(timer.current ?? undefined);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? t("common.copied") : t("common.copy")}
      title={copied ? t("common.copied") : t("common.copy")}
      className={clsx(
        "shrink-0 inline-flex items-center justify-center p-1 rounded text-text-hint hover:text-text transition-colors",
        className,
      )}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

/** Одиночный промпт: line-clamp-3 + «Развернуть» на десктопе, скролл на мобиле. */
function SinglePromptSection({ prompt }: { prompt: string }) {
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
  }, [prompt]);

  return (
    <div className="flex flex-col gap-2 min-h-0">
      <div className="flex items-center justify-between gap-2">
        <PromptSectionLabel>{t("prompts.prompt")}</PromptSectionLabel>
        <CopyButton text={prompt} />
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
          {prompt}
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
  );
}

/** Мультишот (Kling): список блоков «Шот N · длительность» + промпт шота. */
function MultiShotSection({ shots }: { shots: ShotEntry[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 min-h-0">
      <PromptSectionLabel>{t("prompts.prompt")}</PromptSectionLabel>
      <div className="flex flex-col gap-2 overflow-y-auto max-h-[4.5rem] lg:max-h-[40vh] pr-1">
        {shots.map((shot, i) => (
          <div key={i} className="flex flex-col gap-1 bg-white/[0.04] rounded-[var(--radius)] p-3">
            <div className="flex items-center gap-2 text-xs text-text-hint">
              <span className="font-semibold">{t("generate.multishot.shotN", { n: i + 1 })}</span>
              <span>·</span>
              <span>{t("generate.multishot.seconds", { value: shot.duration })}</span>
              {shot.prompt && <CopyButton text={shot.prompt} className="ml-auto" />}
            </div>
            <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-text-secondary m-0">
              {shot.prompt || "—"}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Блок настроек генерации: label/value-строки. Advanced скрыты под «Показать все». */
function SettingsSection({ rows }: { rows: SettingRow[] }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasAdvanced = rows.some((r) => r.advanced);
  const visible = expanded ? rows : rows.filter((r) => !r.advanced);

  return (
    <div className="flex flex-col gap-2 shrink-0">
      <PromptSectionLabel>{t("common.settings")}</PromptSectionLabel>
      <div className="flex flex-col gap-1.5 bg-white/[0.04] rounded-[var(--radius)] p-3 max-h-40 overflow-y-auto">
        {visible.map((r) => (
          <div key={r.label} className="flex items-start justify-between gap-3 text-sm">
            <span className="text-text-secondary min-w-0 break-words">{r.label}</span>
            <span className="text-text break-words text-right">{r.value}</span>
          </div>
        ))}
      </div>
      {hasAdvanced && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="self-start inline-flex items-center gap-1 text-xs text-text-hint hover:text-text transition-colors"
        >
          <ChevronDown
            size={14}
            className={clsx("transition-transform", expanded && "rotate-180")}
          />
          {expanded ? t("common.collapse") : t("common.seeAll")}
        </button>
      )}
    </div>
  );
}

function FoldersSection({ folders }: { folders: PreviewFolders }) {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  // Default («Избранное») управляется кнопкой-сердечком на карточке — не выводим.
  const nonDefault = useMemo(() => folders.list.filter((f) => !f.isDefault), [folders.list]);
  // Секцию показываем, если есть пользовательские папки ЛИБО доступно создание.
  if (nonDefault.length === 0 && !folders.onCreate) return null;

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
        {folders.onCreate && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors bg-white/[0.06] text-text-secondary hover:text-text hover:bg-white/[0.1]"
          >
            <FolderPlus size={12} />
            {t("common.newFolder")}
          </button>
        )}
      </div>
      {createOpen && folders.onCreate && (
        <FolderNameDialog
          title={t("common.newFolder")}
          submitLabel={t("common.newFolder")}
          pending={false}
          onSubmit={(name) => {
            folders.onCreate?.(name);
            setCreateOpen(false);
          }}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}
