import { memo, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, Loader2, Music2 } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { useUIStore } from "@/stores/uiStore";
import {
  usePendingJobsStore,
  type PendingJob,
  type TrackedJobOutput,
} from "@/stores/pendingJobsStore";
import { listGenerations, type GenerationJobDto, type GenerationOutputDto } from "@/api/generation";
import type { WebModelDto } from "@/api/models";
import {
  GenerationPreviewModal,
  type PreviewInfo,
  type PreviewOutput,
} from "@/components/common/GenerationPreviewModal";
import { navigateToGenerate, normalizeSection } from "@/utils/navigateToGenerate";
import { getModelDisplay } from "@/stores/modelsStore";
import { formatTokensSpent } from "@/utils/format";
import { parseShots } from "@/utils/multishot";

/**
 * Лента всех генераций текущей секции (image/design/video/audio), независимо
 * от выбранной модели. Masonry-сетка плиток разного размера по реальному
 * aspect_ratio (определяется из <img>.naturalWidth/Height и <video> metadata).
 *
 * Источники:
 *  - `GET /web/generations?section=...` — done/failed снапшот, без фильтра по модели.
 *  - `usePendingJobsStore` — pending'и, переключаемые в success/error глобальным
 *    хуком `usePendingJobsSync`. На success — refetch снапшота.
 */

interface Props {
  /** Активная модель — используется только для derive секции. */
  selectedModel: WebModelDto | undefined;
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
 *  `thumbnailUrl` нужен модалке, чтобы собрать backdrop blur (для image — own
 *  thumb или сам url; video — thumb; audio — null). */
type PreviewItem = {
  url: string;
  section: string;
  thumbnailUrl?: string | null;
  job?: GenerationJobDto;
};

function GenerationHistoryImpl({ selectedModel, onHasContentChange }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pushToast = useUIStore((s) => s.pushToast);
  const [history, setHistory] = useState<GenerationJobDto[]>([]);
  const [loading, setLoading] = useState(false);
  const pendingJobs = usePendingJobsStore((s) => s.pendingJobs);
  const removePending = usePendingJobsStore((s) => s.remove);

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

  // Pending'и фильтруем по секции — страховка от чужих pending'ов при перекрёстной
  // навигации между /image и /video.
  const historyIds = useMemo(() => new Set(history.map((h) => h.id)), [history]);
  const visiblePending = useMemo(
    () => pendingJobs.filter((p) => p.section === trackedSection && !historyIds.has(p.id)),
    [pendingJobs, trackedSection, historyIds],
  );

  // Когда pending переходит в success (через глобальный sync) — рефетчим
  // снапшот: pending тайл уйдёт автоматически, как только в history появится
  // его id (см. historyIds выше). Зависим от самого массива, не от boolean —
  // иначе второй success подряд не триггерит refetch (boolean уже true).
  useEffect(() => {
    if (visiblePending.some((p) => p.status === "success")) void refetch();
  }, [visiblePending]);

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

  // PreviewItem → props общей модалки. Один output (лента генерации показывает
  // тайл-на-output, мульти-нав не нужен).
  const previewOutputs = useMemo<PreviewOutput[]>(
    () =>
      preview
        ? [{ id: "single", url: preview.url, thumbnailUrl: preview.thumbnailUrl ?? null }]
        : [],
    [preview],
  );

  const previewInfo = useMemo<PreviewInfo | undefined>(() => {
    const job = preview?.job;
    if (!job) return undefined;
    const md = getModelDisplay(job.modelId, job.modelName);
    return {
      title: md.name,
      iconPath: md.icon,
      dateIso: job.completedAt ?? job.createdAt,
      tokensValue:
        job.tokensSpent && job.tokensSpent !== "0" ? formatTokensSpent(job.tokensSpent) : null,
      prompt: job.prompt,
      shots: parseShots(job.modelSettings?.shots),
      onRepeat: () => {
        const route = normalizeSection(job.section);
        if (!route) {
          // Невалидную секцию показываем тостом, модалку оставляем — юзеру
          // полезно видеть инфо о job'е.
          pushToast({ type: "error", message: "Неизвестная секция" });
          return;
        }
        setPreview(null);
        navigateToGenerate(navigate, {
          section: route,
          modelId: job.modelId,
          prompt: job.prompt,
          settings: job.modelSettings,
        });
      },
    };
  }, [preview, navigate, pushToast]);

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
            onDismiss={removePending}
          />
        ))}
      </ul>
      {preview && (
        <GenerationPreviewModal
          outputs={previewOutputs}
          activeIdx={0}
          onActiveIdxChange={() => undefined}
          section={preview.section}
          onClose={() => setPreview(null)}
          info={previewInfo}
        />
      )}
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
        onPreview={(url, section, thumbnailUrl) => onPreview({ url, section, thumbnailUrl })}
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
      onPreview={(url, section, thumbnailUrl) =>
        onPreview({ url, section, thumbnailUrl, job: tile.job })
      }
    />
  );
}

// ── Tiles ────────────────────────────────────────────────────────────────────

export function PendingTile({
  job,
  onDismiss,
  compact = false,
}: {
  job: PendingJob;
  onDismiss: () => void;
  /** В compact-режиме тайл квадратный (без masonry-span), для Gallery 3-col layout. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const status = job.errorMessage ? "error" : (job.status ?? "pending");
  const isError = status === "error";

  return (
    <li
      style={compact ? undefined : { gridRow: "span 4" }}
      className={clsx(
        "relative rounded-[var(--radius)] overflow-hidden flex flex-col items-center justify-center p-4 text-center",
        compact && "aspect-square",
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

export function FailedTile({
  job,
  onDismiss,
  compact = false,
}: {
  job: GenerationJobDto;
  /** Если задан — рендерится кнопка скрытия. В GenerationHistory не используется. */
  onDismiss?: () => void;
  /** В compact-режиме тайл квадратный (без masonry-span), для Gallery 3-col layout. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li
      style={compact ? undefined : { gridRow: "span 4" }}
      className={clsx(
        "relative rounded-[var(--radius)] overflow-hidden flex flex-col items-center justify-center p-4 text-center bg-[rgba(220,50,50,0.08)] border border-[var(--danger,#d44)]",
        compact && "aspect-square",
      )}
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
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="mt-2 px-2.5 py-1 text-xs border border-border rounded-md text-text-hint hover:text-text"
        >
          {t("common.close")}
        </button>
      )}
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
  /** `thumbnailUrl` нужен только модалке (backdrop blur + thumbnail strip). */
  onPreview: (url: string, section: string, thumbnailUrl: string | null) => void;
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
      {tokensSpent && <span>{formatTokensSpent(tokensSpent)} ✦</span>}
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
        onClick={() => onPreview(url, section, thumb)}
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
