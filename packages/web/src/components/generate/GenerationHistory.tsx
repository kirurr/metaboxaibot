import {
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRight,
  Calendar,
  ChevronDown,
  Coins,
  Loader2,
  Music2,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/common/Button";
import { useNotificationsStore } from "@/stores/notificationsStore";
import { useUIStore } from "@/stores/uiStore";
import { galleryKeys } from "@/api/gallery";
import { listGenerations, type GenerationJobDto, type GenerationOutputDto } from "@/api/generation";
import type { WebModelDto } from "@/api/models";
import { useIsMobile } from "@/hooks/useIsMobile";
import { navigateToGenerate, normalizeSection } from "@/utils/navigateToGenerate";
import { formatTokens } from "@/utils/format";

/**
 * Лента всех генераций текущей секции (image/design/video/audio), независимо
 * от выбранной модели. Masonry-сетка плиток разного размера по реальному
 * aspect_ratio (определяется из <img>.naturalWidth/Height и <video> metadata).
 *
 * Источники:
 *  - `GET /web/generations?section=...` — done/failed снапшот, без фильтра по модели.
 *  - `useNotificationsStore.list` — WS-события для перехода pending → success/error
 *    и refetch'а истории на success.
 */

/** Output, восстановленный из WS-уведомления (`data.outputs[]`). */
export interface TrackedJobOutput {
  id: string;
  url: string | null;
  thumbnailUrl: string | null;
}

export interface PendingJob {
  /** dbJobId, возвращённый submit-эндпоинтом. */
  id: string;
  modelId: string;
  /** "image" | "video" | "audio" — фильтр по текущей секции и выбор рендера. */
  section: string;
  prompt: string;
  startedAt: number;
  /** WS-driven статус. По умолчанию `pending`, переключается на success/error через колбэки. */
  status?: "pending" | "success" | "error";
  /** Заполняется на success — рисуем outputs из WS-уведомления, не дожидаясь refetch'а. */
  outputs?: TrackedJobOutput[];
  /** Если приходит error-нотификация — переключаем сюда. */
  errorMessage?: string;
}

interface Props {
  /** Активная модель — используется только для derive секции. */
  selectedModel: WebModelDto | undefined;
  /** Локально-трекаемые job'ы между submit'ом и финальным WS-event'ом. */
  pendingJobs: PendingJob[];
  /** Колбэк дисмисса (error-плитка по кнопке закрытия). */
  onJobResolved: (jobId: string) => void;
  /** Колбэк когда pending получил error из WS. */
  onJobFailed: (jobId: string, errorMessage: string) => void;
  /** Колбэк когда pending получил success из WS — родитель апдейтит карточку. */
  onJobSucceeded: (jobId: string, outputs: TrackedJobOutput[]) => void;
  /**
   * Сообщает родителю, есть ли вообще контент в пэйне. Используется, чтобы
   * скрыть ambient-фон при появлении первой генерации.
   */
  onHasContentChange?: (hasContent: boolean) => void;
}

/** Плоский тайл — единица рендера в masonry-сетке. */
type Tile =
  | { kind: "pending"; key: string; job: PendingJob }
  | { kind: "pending-success"; key: string; job: PendingJob; output: TrackedJobOutput }
  | {
      kind: "history-output";
      key: string;
      job: GenerationJobDto;
      output: GenerationOutputDto;
    }
  | { kind: "history-failed"; key: string; job: GenerationJobDto };

/** Что показываем в lightbox'е. `job` опционален: для pending-success outputs
 *  модель/настройки/имя ещё не пришли с бэка — кнопка «Повторить» скрывается.
 *  `backdropUrl` — картинка для замыленного фона (image: сам url или thumb;
 *  video: thumb; audio: null — фон без картинки). */
type PreviewItem = {
  url: string;
  section: string;
  backdropUrl?: string | null;
  job?: GenerationJobDto;
};

function GenerationHistoryImpl({
  selectedModel,
  pendingJobs,
  onJobResolved,
  onJobFailed,
  onJobSucceeded,
  onHasContentChange,
}: Props) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<GenerationJobDto[]>([]);
  const [loading, setLoading] = useState(false);
  const notifications = useNotificationsStore((s) => s.list);
  const qc = useQueryClient();

  const section = selectedModel?.section;
  // Pending'ы трекаются нормализованной секцией ("design" → "image"), а
  // selectedModel.section отдаёт сырое значение из каталога. Сравниваем по
  // нормализованной, иначе свежие pending'ы на /image отсеиваются.
  const trackedSection = section === "design" ? "image" : section;

  // Idempotent fetch. Без modelIds — фильтр только по секции. Бэк сам мапит
  // "design" → "image" в where-клозе.
  async function refetch() {
    if (!section) return;
    setLoading(true);
    try {
      const { items } = await listGenerations({ section, limit: 20 });
      setHistory(items);
    } catch {
      // тихо: ошибка истории не должна ломать flow генерации
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refetch();
  }, [section]);

  // Реакция на WS-нотификации: матчим по jobId с трекаемыми pending'ами.
  useEffect(() => {
    if (pendingJobs.length === 0) return;
    for (const pending of pendingJobs) {
      if (pending.status === "success") continue;
      const notif = notifications.find((n) => n.jobId === pending.id);
      if (!notif) continue;
      if (notif.type.endsWith("_success")) {
        const data = (notif.data ?? {}) as {
          outputs?: Array<{ id: string; s3Key?: string; outputUrl?: string | null }>;
        };
        const outputs: TrackedJobOutput[] = (data.outputs ?? []).map((o) => ({
          id: o.id,
          url: o.outputUrl ?? null,
          thumbnailUrl: null,
        }));
        onJobSucceeded(pending.id, outputs);
        void refetch();
        void qc.invalidateQueries({ queryKey: galleryKeys.all });
      } else if (notif.type.endsWith("_error")) {
        if (pending.errorMessage !== notif.message) {
          onJobFailed(pending.id, notif.message);
        }
      }
    }
  }, [notifications, pendingJobs, onJobSucceeded, onJobFailed]);

  // Pending'и фильтруем по секции — страховка от чужих pending'ов при перекрёстной
  // навигации между /image и /video.
  const historyIds = useMemo(() => new Set(history.map((h) => h.id)), [history]);
  const visiblePending = useMemo(
    () => pendingJobs.filter((p) => p.section === trackedSection && !historyIds.has(p.id)),
    [pendingJobs, trackedSection, historyIds],
  );

  // Разворачиваем job'ы в плоский массив плиток. Pending — первыми, затем
  // история (уже отсортирована по createdAt desc на бэке).
  const tiles = useMemo<Tile[]>(() => {
    const out: Tile[] = [];
    for (const p of visiblePending) {
      const isSuccess = (p.status ?? (p.errorMessage ? "error" : "pending")) === "success";
      if (isSuccess && p.outputs && p.outputs.length > 0) {
        for (const o of p.outputs) {
          out.push({ kind: "pending-success", key: `p:${p.id}:${o.id}`, job: p, output: o });
        }
      } else {
        out.push({ kind: "pending", key: `p:${p.id}`, job: p });
      }
    }
    for (const j of history) {
      if (j.status === "failed") {
        out.push({ kind: "history-failed", key: `h:${j.id}`, job: j });
      } else {
        for (const o of j.outputs) {
          out.push({ kind: "history-output", key: `h:${j.id}:${o.id}`, job: j, output: o });
        }
      }
    }
    return out;
  }, [visiblePending, history]);

  const [preview, setPreview] = useState<PreviewItem | null>(null);

  const hasContent = tiles.length > 0;
  useEffect(() => {
    onHasContentChange?.(hasContent);
  }, [hasContent, onHasContentChange]);

  if (!hasContent && !loading) {
    return null;
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-text-hint text-xs uppercase tracking-wider">
        <h3 className="m-0 text-xs font-semibold">{t("generate.historyTitle")}</h3>
        {loading && <Loader2 size={14} className="animate-spin" />}
      </div>
      <ul className="grid grid-flow-dense grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 auto-rows-[100px] sm:auto-rows-[80px] gap-3 list-none p-0 m-0">
        {tiles.map((tile) => (
          <TileRenderer
            key={tile.key}
            tile={tile}
            onPreview={(item) => setPreview(item)}
            onDismiss={onJobResolved}
          />
        ))}
      </ul>
      {preview && <MediaPreviewModal item={preview} onClose={() => setPreview(null)} />}
    </section>
  );
}

// memo: пропсы (selectedModel/pendingJobs + стабильные колбэки из useCallback в
// GenerateScene) не зависят от промпта, поэтому при наборе текста родитель
// ререндерится, а история со всеми плитками — нет.
export const GenerationHistory = memo(GenerationHistoryImpl);

// ── Tile renderer ────────────────────────────────────────────────────────────

function TileRenderer({
  tile,
  onPreview,
  onDismiss,
}: {
  tile: Tile;
  onPreview: (item: PreviewItem) => void;
  onDismiss: (jobId: string) => void;
}) {
  if (tile.kind === "pending") {
    return <PendingTile job={tile.job} onDismiss={() => onDismiss(tile.job.id)} />;
  }
  if (tile.kind === "history-failed") {
    return <FailedTile job={tile.job} />;
  }
  if (tile.kind === "pending-success") {
    return (
      <OutputTile
        url={tile.output.url}
        thumb={tile.output.thumbnailUrl}
        section={tile.job.section}
        prompt={tile.job.prompt}
        createdAt={new Date(tile.job.startedAt).toISOString()}
        tokensSpent={null}
        onPreview={(url, section, backdropUrl) => onPreview({ url, section, backdropUrl })}
      />
    );
  }
  return (
    <OutputTile
      url={tile.output.url}
      thumb={tile.output.thumbnailUrl}
      section={tile.job.section}
      prompt={tile.job.prompt}
      createdAt={tile.job.createdAt}
      tokensSpent={tile.job.tokensSpent}
      onPreview={(url, section, backdropUrl) =>
        onPreview({ url, section, backdropUrl, job: tile.job })
      }
    />
  );
}

// ── Tiles ────────────────────────────────────────────────────────────────────

function PendingTile({ job, onDismiss }: { job: PendingJob; onDismiss: () => void }) {
  const { t } = useTranslation();
  const status = job.errorMessage ? "error" : (job.status ?? "pending");
  const isError = status === "error";

  return (
    <li
      style={{ gridRow: "span 4" }}
      className={clsx(
        "relative rounded-[var(--radius)] overflow-hidden flex flex-col items-center justify-center p-4 text-center",
        isError
          ? "bg-[rgba(220,50,50,0.08)] border border-[var(--danger,#d44)]"
          : "bg-bg-elevated border border-dashed border-border",
      )}
    >
      {isError ? (
        <>
          <AlertCircle size={20} className="text-[var(--danger,#d44)] mb-2" />
          <div className="text-xs font-semibold text-[var(--danger,#d44)] mb-1">
            {t("generate.historyError")}
          </div>
          <div className="text-xs text-text-secondary line-clamp-3 break-words">
            {job.errorMessage}
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="mt-2 px-2.5 py-1 text-xs border border-border rounded-md text-text-hint hover:text-text"
          >
            {t("common.close")}
          </button>
        </>
      ) : (
        <>
          <Loader2 size={22} className="animate-spin text-text-hint mb-2" />
          <div className="text-xs text-text-hint">{t("generate.historyGenerating")}</div>
          {job.prompt && (
            <div className="mt-2 text-xs text-text-secondary line-clamp-2 break-words">
              {job.prompt}
            </div>
          )}
        </>
      )}
    </li>
  );
}

function FailedTile({ job }: { job: GenerationJobDto }) {
  const { t } = useTranslation();
  return (
    <li
      style={{ gridRow: "span 4" }}
      className="relative rounded-[var(--radius)] overflow-hidden flex flex-col items-center justify-center p-4 text-center bg-[rgba(220,50,50,0.08)] border border-[var(--danger,#d44)]"
    >
      <AlertCircle size={20} className="text-[var(--danger,#d44)] mb-2" />
      <div className="text-xs font-semibold text-[var(--danger,#d44)] mb-1">
        {t("generate.historyError")}
      </div>
      <div className="text-xs text-text-secondary line-clamp-3 break-words">
        {job.error || t("generate.historyError")}
      </div>
      <div className="mt-2 text-[10px] text-text-hint font-mono">
        {new Date(job.createdAt).toLocaleString()}
      </div>
    </li>
  );
}

function OutputTile({
  url,
  thumb,
  section,
  prompt,
  createdAt,
  tokensSpent,
  onPreview,
}: {
  url: string | null;
  thumb: string | null;
  section: string;
  prompt: string;
  createdAt: string;
  tokensSpent: string | null;
  onPreview: (url: string, section: string, backdropUrl: string | null) => void;
}) {
  // Картинка для размытого фона в лайтбоксе: для audio — нет, для video —
  // только thumb (видео ставит сам плеер), для image — thumb или сам url.
  const backdropUrl =
    section === "audio" ? null : section === "video" ? thumb : (thumb ?? url);
  // Aspect-ratio картинки/видео определяется после загрузки → пересчитывается
  // span. До загрузки рендерим квадратный плейсхолдер (span 3).
  // Аудио всегда квадрат — нет визуального aspect'а.
  const [aspect, setAspect] = useState<number | null>(section === "audio" ? 1 : null);
  const rowSpan = spanFromAspect(aspect);

  if (!url) {
    return (
      <li
        style={{ gridRow: `span ${rowSpan}` }}
        className="relative rounded-[var(--radius)] overflow-hidden bg-bg-elevated border border-dashed border-border"
      />
    );
  }

  const meta = (
    <div className="flex justify-between items-start gap-2 text-[10px] font-mono text-white/70 mb-auto">
      <span>{new Date(createdAt).toLocaleString()}</span>
      {tokensSpent && <span>{Number(tokensSpent).toFixed(2)} ✦</span>}
    </div>
  );

  if (section === "audio") {
    return (
      <li
        style={{ gridRow: `span ${rowSpan}` }}
        className="relative rounded-[var(--radius)] overflow-hidden bg-bg-elevated flex flex-col p-3"
      >
        <div className="flex-1 flex items-center justify-center text-text-hint">
          <Music2 size={36} />
        </div>
        {prompt && (
          <div className="text-xs text-text-secondary line-clamp-2 break-words mb-2">{prompt}</div>
        )}
        <audio src={url} controls className="w-full" />
      </li>
    );
  }

  return (
    <li
      style={{ gridRow: `span ${rowSpan}` }}
      className="group relative rounded-[var(--radius)] overflow-hidden bg-bg-elevated"
    >
      <button
        type="button"
        onClick={() => onPreview(url, section, backdropUrl)}
        className="absolute inset-0 p-0 m-0 border-0 bg-transparent cursor-zoom-in size-full"
        aria-label={section === "video" ? "Open video" : "Open image"}
      >
        {section === "video" ? (
          thumb ? (
            <img
              src={thumb}
              alt=""
              loading="lazy"
              className="absolute inset-0 size-full object-cover"
              onLoad={(e) => {
                const { naturalWidth, naturalHeight } = e.currentTarget;
                if (naturalWidth && naturalHeight) setAspect(naturalWidth / naturalHeight);
              }}
            />
          ) : (
            <video
              src={url}
              muted
              playsInline
              preload="metadata"
              className="absolute inset-0 size-full object-cover"
              onLoadedMetadata={(e) => {
                const { videoWidth, videoHeight } = e.currentTarget;
                if (videoWidth && videoHeight) setAspect(videoWidth / videoHeight);
              }}
            />
          )
        ) : (
          <img
            src={thumb ?? url}
            alt=""
            loading="lazy"
            className="absolute inset-0 size-full object-cover"
            onLoad={(e) => {
              const { naturalWidth, naturalHeight } = e.currentTarget;
              if (naturalWidth && naturalHeight) setAspect(naturalWidth / naturalHeight);
            }}
          />
        )}
      </button>

      {/* Overlay: prompt + meta. Появляется на hover/focus. Pointer-events
          none, чтобы клик уходил в нижестоящую кнопку (open-preview). */}
      <div className="absolute inset-0 flex flex-col p-3 pointer-events-none bg-gradient-to-b from-black/40 via-transparent to-black/70 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-200">
        {meta}
        {prompt && (
          <div className="text-xs text-white line-clamp-2 break-words mt-auto">{prompt}</div>
        )}
      </div>
    </li>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Masonry-span по aspect'у картинки. Базовый ряд auto-rows-[80px] (на mobile
 * 100px, см. <ul>), gap 12px → span определяет высоту плитки:
 *   span 3 → ~264 px (sm+) / ~324 px (mobile) — для wide картинок (16:9 и шире)
 *   span 4 → ~356 px (sm+) / ~436 px (mobile) — квадрат-дефолт
 *   span 5 → ~436 px (sm+) / ~548 px (mobile) — для tall картинок (9:16 и уже)
 * grid-flow-dense на ul'е плотно укладывает плитки в дырки → пустот не будет.
 */
function spanFromAspect(aspect: number | null): number {
  if (aspect == null) return 4;
  if (aspect > 1.3) return 3;
  if (aspect < 0.85) return 5;
  return 4;
}

// ── Lightbox с боковой info-панелью и кнопкой «Повторить» ───────────────────

/**
 * Модалка просмотра output'а: на весь экран замыленный фон из самой картинки
 * (для image / video-thumbnail), большой просмотрщик по центру, узкая
 * инфо-карточка справа (дата + токены чипами, сворачиваемый промпт,
 * большая retry-кнопка). На мобилке — медиа сверху, инфо снизу.
 *
 * Кнопка «Повторить» работает только для history-job'ов (`item.job` с
 * `modelSettings`). Для pending-success outputs инфо-карточка не рендерится —
 * модалка превращается в чистый просмотрщик с тем же backdrop'ом.
 *
 * Закрытие: backdrop / X / Esc.
 */
function MediaPreviewModal({ item, onClose }: { item: PreviewItem; onClose: () => void }) {
  const { t } = useTranslation();
  // Переключаемся на десктоп-layout только с lg (1024px). Планшеты в портрете
  // получают мобильную верстку — медиа сверху, инфо-карточка снизу.
  const isMobile = useIsMobile(1024);
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);
  const job = item.job;
  const backdropUrl = item.backdropUrl ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const handleRepeat = () => {
    if (!job) return;
    const route = normalizeSection(job.section);
    if (!route) {
      pushToast({ type: "error", message: "Неизвестная секция" });
      return;
    }
    onClose();
    navigateToGenerate(navigate, {
      section: route,
      modelId: job.modelId,
      prompt: job.prompt,
      settings: job.modelSettings,
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4 lg:p-8 overflow-hidden"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop: замыленная и затемнённая копия медиа во весь экран.
          Поверх — полупрозрачная заливка для дополнительного контраста. */}
      {backdropUrl ? (
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none bg-center bg-cover"
          style={{
            backgroundImage: `url("${backdropUrl}")`,
            filter: "blur(40px) brightness(0.4)",
            transform: "scale(1.1)",
          }}
        />
      ) : null}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none bg-black/70 backdrop-blur-sm"
      />

      <button
        type="button"
        onClick={onClose}
        aria-label={t("common.close")}
        className="absolute top-4 right-4 lg:top-6 lg:right-6 z-50 btn btn-ghost btn-icon"
      >
        <X size={20} />
      </button>

      <div
        className="relative w-full h-full flex flex-col lg:flex-row gap-4 lg:gap-8 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Media — занимает всё свободное место. */}
        <div className="flex-1 min-h-0 flex items-center justify-center">
          {item.section === "video" ? (
            <video
              src={item.url}
              controls
              autoPlay
              playsInline
              className="max-w-full max-h-full object-contain rounded-[var(--radius)] shadow-2xl"
            />
          ) : item.section === "audio" ? (
            <div className="flex flex-col items-center gap-6 p-8">
              <Music2 size={96} className="text-white/70" />
              <audio src={item.url} controls className="w-full max-w-md" />
            </div>
          ) : (
            <img
              src={item.url}
              alt=""
              className="max-w-full max-h-full object-contain rounded-[var(--radius)] shadow-2xl"
            />
          )}
        </div>

        {/* Info-карточка — справа на десктопе, снизу на мобилке. */}
        {job && (
          <PreviewInfoCard
            job={job}
            isMobile={isMobile}
            onRepeat={handleRepeat}
            t={t}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Локальный аналог `MetaChip` из Gallery.tsx — стиль повторён один-в-один. */
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
  job,
  isMobile,
  onRepeat,
  t,
}: {
  job: GenerationJobDto;
  isMobile: boolean;
  onRepeat: () => void;
  t: (key: string) => string;
}) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const promptRef = useRef<HTMLParagraphElement>(null);

  // Детект «реально ли промпт обрезан line-clamp'ом». Считаем один раз после
  // mount'а (промпт за время жизни модалки не меняется). Сравниваем
  // scrollHeight (полная высота контента) с clientHeight (видимая высота при
  // line-clamp-3) — если первое больше, кнопка-тогл нужна.
  useLayoutEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    setIsTruncated(el.scrollHeight - el.clientHeight > 1);
  }, [job.prompt]);

  const dateIso = job.completedAt ?? job.createdAt;
  const tokensValue =
    job.tokensSpent && job.tokensSpent !== "0" ? formatTokens(job.tokensSpent) : null;
  const hasMeta = Boolean(dateIso || tokensValue);

  return (
    <aside
      className="relative shrink-0 w-full lg:w-[400px] card flex flex-col gap-4 text-white p-4 lg:p-6 min-h-0 overflow-hidden"
      style={{ background: "var(--bg-elevated)" }}
    >
      <h2 className="h2 shrink-0 break-words">{job.modelName}</h2>

      {hasMeta && (
        <div className="flex flex-wrap gap-1.5 shrink-0">
          {dateIso && <MetaChip icon={<Calendar size={14} />} label={formatPreviewDate(dateIso)} />}
          {tokensValue && <MetaChip icon={<Coins size={14} />} label={`${tokensValue} ✦`} />}
        </div>
      )}

      <div className="flex flex-col gap-2">
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
            {job.prompt || "—"}
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

      <Button
        className="mt-auto"
        size={isMobile ? "md" : "lg"}
        rightIcon={<ArrowRight />}
        onClick={onRepeat}
        fullWidth
      >
        {t("common.retry")}
      </Button>
    </aside>
  );
}
