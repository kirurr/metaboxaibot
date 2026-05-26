import { memo, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowRight, Loader2, Music2, X } from "lucide-react";
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
 *  модель/настройки/имя ещё не пришли с бэка — кнопка «Повторить» скрывается. */
type PreviewItem = {
  url: string;
  section: string;
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
        onPreview={(url, section) => onPreview({ url, section })}
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
      onPreview={(url, section) => onPreview({ url, section, job: tile.job })}
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
  onPreview: (url: string, section: string) => void;
}) {
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
        onClick={() => onPreview(url, section)}
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

// ── Lightbox с /prompts-style info-панелью и кнопкой «Повторить» ────────────

/**
 * Модалка просмотра output'а с боковой панелью «модель / промпт / повторить».
 * Layout повторяет `PromptExamplesGallery > DialogCard`: на десктопе слева
 * медиа, справа узкая карточка с моделью/промптом/CTA; на мобилке всё
 * вертикально (медиа сверху, карточка снизу). Закрытие: backdrop / X / Esc.
 *
 * Кнопка «Повторить» работает только для history-job'ов (т.е. там, где
 * `item.job` пришёл с бэка с modelSettings). Для pending-success outputs
 * кнопку скрываем — настройки берутся из формы, юзеру их повторять не нужно.
 */
function MediaPreviewModal({ item, onClose }: { item: PreviewItem; onClose: () => void }) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);
  const job = item.job;

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
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4 md:p-8 bg-black/85 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute top-4 right-4 md:top-6 md:right-6 z-50 btn btn-ghost btn-icon"
      >
        <X size={20} />
      </button>

      <div
        className="w-full h-full flex flex-col md:flex-row gap-4 overflow-hidden relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Media — слева, занимает основное пространство. */}
        <div className="flex flex-col flex-1 min-h-0 md:flex-none w-full md:w-1/2 lg:w-2/3 items-center justify-center">
          <div className="w-full h-full md:size-4/5 lg:size-2/3 shadow-lg rounded-[var(--radius)] overflow-hidden flex items-center justify-center bg-black/40">
            {item.section === "video" ? (
              <video
                src={item.url}
                controls
                autoPlay
                playsInline
                className="max-w-full max-h-full object-contain"
              />
            ) : item.section === "audio" ? (
              <div className="flex flex-col items-center gap-4 p-8">
                <Music2 size={64} className="text-text-secondary" />
                <audio src={item.url} controls className="w-full" />
              </div>
            ) : (
              <img src={item.url} alt="" className="max-w-full max-h-full object-contain" />
            )}
          </div>
        </div>

        {/* Info-карточка — справа, повторяет стиль /prompts DialogCard. */}
        {job && (
          <div className="shrink-0 md:shrink w-full md:w-1/2 lg:w-1/3 card flex flex-col gap-4 text-white p-4 md:p-8 min-h-0 overflow-hidden">
            <h2 className="h2 text-center shrink-0">{job.modelName}</h2>
            <div className="flex flex-col gap-4 flex-1 min-h-0">
              <h3 className="hidden md:block h3 text-center shrink-0">{t("prompts.promptUsed")}</h3>
              <div className="text-text-secondary text-lg bg-bg-elevated p-4 rounded-[var(--radius)] overflow-y-auto whitespace-pre-wrap break-words">
                {job.prompt || "—"}
              </div>
            </div>
            <div className="mt-auto">
              <Button
                className="mt-4 w-full"
                size={isMobile ? "md" : "lg"}
                rightIcon={<ArrowRight />}
                onClick={handleRepeat}
              >
                {t("common.retry")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
