import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNotificationsStore } from "@/stores/notificationsStore";
import { listGenerations, type GenerationJobDto } from "@/api/generation";
import type { WebModelDto } from "@/api/models";

/**
 * История генераций для текущего семейства моделей.
 *
 * Источники:
 *  - `GET /web/generations?modelIds=...` — фиксированный снапшот done/failed
 *    задач (загружается при смене семейства).
 *  - `useNotificationsStore.list` — пуш-уведомления `notification:new` через
 *    WS. Используются для:
 *      1. Перехода pending → completed/error в `pendingJobs`,
 *      2. Триггера refetch'а истории на success (чтобы свежий job со всеми
 *         outputs появился сразу, без ожидания следующего рендера страницы).
 *
 * Pending'и приходят извне (`pendingJobs` prop) — родительский `GenerateScene`
 * добавляет туда задачу сразу после `submitXxxGeneration()`.
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
  /** "image" | "video" | "audio" — нужно знать как рендерить outputs success-карточки. */
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
  /** Активная модель — используется для derive семейства и секции. */
  selectedModel: WebModelDto | undefined;
  /** Все модели секции (для resolve'а siblings семейства). */
  allModels: readonly WebModelDto[];
  /** Локально-трекаемые job'ы между submit'ом и финальным WS-event'ом. */
  pendingJobs: PendingJob[];
  /** Колбэк дисмисса (error-карточка по кнопке закрытия). */
  onJobResolved: (jobId: string) => void;
  /** Колбэк когда pending получил error из WS. */
  onJobFailed: (jobId: string, errorMessage: string) => void;
  /** Колбэк когда pending получил success из WS — родитель апдейтит карточку. */
  onJobSucceeded: (jobId: string, outputs: TrackedJobOutput[]) => void;
}

export function GenerationHistory({
  selectedModel,
  allModels,
  pendingJobs,
  onJobResolved,
  onJobFailed,
  onJobSucceeded,
}: Props) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<GenerationJobDto[]>([]);
  const [loading, setLoading] = useState(false);
  const notifications = useNotificationsStore((s) => s.list);

  // Members семейства — фильтр для backend'а. Без семейства — только сам modelId.
  const familyModelIds = useMemo(() => {
    if (!selectedModel) return [];
    if (selectedModel.familyId) {
      return allModels.filter((m) => m.familyId === selectedModel.familyId).map((m) => m.id);
    }
    return [selectedModel.id];
  }, [selectedModel, allModels]);

  const section = selectedModel?.section;

  // Idempotent fetch + refetch helper. Используется при смене семейства и
  // при получении success-нотификации (чтобы job со всеми outputs'ами
  // прилетел в список).
  async function refetch() {
    if (familyModelIds.length === 0 || !section) return;
    setLoading(true);
    try {
      const { items } = await listGenerations({
        modelIds: familyModelIds,
        section,
        limit: 20,
      });
      setHistory(items);
    } catch {
      // тихо: ошибка истории не должна ломать flow генерации
    } finally {
      setLoading(false);
    }
  }

  // Fetch при смене семейства/секции. `refetch` намеренно не в deps —
  // он замыкается над state'ом, всегда видит свежее значение.
  useEffect(() => {
    void refetch();
  }, [familyModelIds.join(","), section]);

  // Реакция на WS-нотификации: матчим по jobId с трекаемыми pending'ами.
  useEffect(() => {
    if (pendingJobs.length === 0) return;
    for (const pending of pendingJobs) {
      // Уже success/error — повторно не обрабатываем.
      if (pending.status === "success") continue;
      const notif = notifications.find((n) => n.jobId === pending.id);
      if (!notif) continue;
      if (notif.type.endsWith("_success")) {
        // Парсим outputs прямо из WS — рисуем результат сразу, не дожидаясь
        // refetch'а истории (он может быть медленным/сорваться). DB-снапшот
        // придёт фоном и дедупом заменит локальную карточку.
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
      } else if (notif.type.endsWith("_error")) {
        if (pending.errorMessage !== notif.message) {
          onJobFailed(pending.id, notif.message);
        }
      }
    }
  }, [notifications, pendingJobs, onJobSucceeded, onJobFailed]);

  // Скрываем pending'и, для которых job уже есть в history (race между
  // refetch'ем и pendingJobs cleanup из родителя — лучше не дублировать).
  const historyIds = useMemo(() => new Set(history.map((h) => h.id)), [history]);
  const visiblePending = pendingJobs.filter((p) => !historyIds.has(p.id));

  // In-app preview lightbox. Открывается кликом по image/video-output'у;
  // audio проигрывается inline и в модалке не нуждается.
  const [preview, setPreview] = useState<{ url: string; section: string } | null>(null);

  if (visiblePending.length === 0 && history.length === 0 && !loading) {
    return null;
  }

  return (
    <div className="gen-history">
      <div className="gen-history-head">
        <h3 className="gen-history-title">{t("generate.historyTitle")}</h3>
        {loading && <Loader2 size={14} className="spin" />}
      </div>
      <div className="gen-history-list">
        {visiblePending.map((p) => (
          <PendingCard
            key={p.id}
            job={p}
            onDismiss={() => onJobResolved(p.id)}
            onPreview={(url) => setPreview({ url, section: p.section })}
          />
        ))}
        {history.map((j) => (
          <HistoryCard
            key={j.id}
            job={j}
            onPreview={(url) => setPreview({ url, section: j.section })}
          />
        ))}
      </div>
      {preview && (
        <MediaPreviewModal
          url={preview.url}
          section={preview.section}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

/**
 * Карточка трекаемой джобы. Три состояния:
 *  - pending: лоадер «Генерация…», до прихода WS-уведомления
 *  - success: outputs из `data.outputs[]` WS-уведомления (рендерим сразу)
 *  - error: красная карточка + сообщение + кнопка закрытия
 */
function PendingCard({
  job,
  onDismiss,
  onPreview,
}: {
  job: PendingJob;
  onDismiss: () => void;
  onPreview: (url: string) => void;
}) {
  const { t } = useTranslation();
  const status = job.errorMessage ? "error" : (job.status ?? "pending");

  let className = "gen-history-card";
  if (status === "pending") className += " is-pending";
  if (status === "error") className += " is-error";

  return (
    <div className={className}>
      <div className="gen-history-card-head">
        {status === "error" ? (
          <>
            <AlertCircle size={14} />
            <span>{t("generate.historyError")}</span>
          </>
        ) : status === "pending" ? (
          <>
            <Loader2 size={14} className="spin" />
            <span>{t("generate.historyGenerating")}</span>
          </>
        ) : null}
      </div>
      <div className="gen-history-card-prompt">{job.prompt || "—"}</div>
      {status === "error" && (
        <>
          <div className="gen-history-card-error">{job.errorMessage}</div>
          <button type="button" className="gen-history-card-dismiss" onClick={onDismiss}>
            {t("common.close")}
          </button>
        </>
      )}
      {status === "success" && job.outputs && job.outputs.length > 0 && (
        <div className="gen-history-card-outputs">
          {job.outputs.map((o) => (
            <OutputThumb
              key={o.id}
              url={o.url}
              thumb={o.thumbnailUrl}
              section={job.section}
              onPreview={onPreview}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryCard({
  job,
  onPreview,
}: {
  job: GenerationJobDto;
  onPreview: (url: string) => void;
}) {
  const { t } = useTranslation();
  const isFailed = job.status === "failed";

  return (
    <div className={isFailed ? "gen-history-card is-error" : "gen-history-card"}>
      <div className="gen-history-card-head">
        {isFailed && <AlertCircle size={14} />}
        <span className="gen-history-card-meta">
          {new Date(job.createdAt).toLocaleString()}
          {job.tokensSpent && ` · ${Number(job.tokensSpent).toFixed(2)} ✦`}
        </span>
      </div>
      <div className="gen-history-card-prompt">{job.prompt || "—"}</div>
      {isFailed ? (
        <div className="gen-history-card-error">{job.error || t("generate.historyError")}</div>
      ) : (
        <div className="gen-history-card-outputs">
          {job.outputs.map((o) => (
            <OutputThumb
              key={o.id}
              url={o.url}
              thumb={o.thumbnailUrl}
              section={job.section}
              onPreview={onPreview}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OutputThumb({
  url,
  thumb,
  section,
  onPreview,
}: {
  url: string | null;
  thumb: string | null;
  section: string;
  onPreview: (url: string) => void;
}) {
  if (!url) {
    return <div className="gen-history-output gen-history-output--placeholder" />;
  }
  if (section === "video") {
    // Видео — миниатюра-постер, по клику открываем модалку с плеером.
    // Inline-controls убраны: с ними клик уезжал в video-controls.
    return (
      <button
        type="button"
        className="gen-history-output-btn"
        onClick={() => onPreview(url)}
        aria-label="Open video"
      >
        {thumb ? (
          <img className="gen-history-output" src={thumb} alt="" loading="lazy" />
        ) : (
          <video className="gen-history-output" src={url} preload="metadata" muted playsInline />
        )}
      </button>
    );
  }
  if (section === "audio") {
    // Audio — inline-плеер, без модалки (контролы и так все есть).
    return <audio className="gen-history-output gen-history-output--audio" src={url} controls />;
  }
  // image / design (default) — клик открывает lightbox с полным размером.
  return (
    <button
      type="button"
      className="gen-history-output-btn"
      onClick={() => onPreview(url)}
      aria-label="Open image"
    >
      <img className="gen-history-output" src={thumb ?? url} alt="" loading="lazy" />
    </button>
  );
}

/**
 * Lightbox для просмотра output'ов прямо в приложении (без target="_blank").
 * Закрытие: backdrop / X / Esc. Контент в портале → не клипается контейнерами.
 */
function MediaPreviewModal({
  url,
  section,
  onClose,
}: {
  url: string;
  section: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Лочим scroll body на время модалки.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div className="gen-preview-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <button type="button" className="gen-preview-close" onClick={onClose} aria-label="Close">
        <X size={20} />
      </button>
      <div className="gen-preview-content" onClick={(e) => e.stopPropagation()}>
        {section === "video" ? (
          <video className="gen-preview-media" src={url} controls autoPlay playsInline />
        ) : (
          // image / design — full-size
          <img className="gen-preview-media" src={url} alt="" />
        )}
      </div>
    </div>,
    document.body,
  );
}
