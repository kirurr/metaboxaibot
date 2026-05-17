import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
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

export interface PendingJob {
  /** dbJobId, возвращённый submit-эндпоинтом. */
  id: string;
  modelId: string;
  prompt: string;
  startedAt: number;
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
  /** Колбэк когда job завершился (success/error) — родитель чистит pendingJobs. */
  onJobResolved: (jobId: string) => void;
  /** Колбэк когда pending получил error из WS — родитель помечает errorMessage. */
  onJobFailed: (jobId: string, errorMessage: string) => void;
}

export function GenerationHistory({
  selectedModel,
  allModels,
  pendingJobs,
  onJobResolved,
  onJobFailed,
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
      const notif = notifications.find((n) => n.jobId === pending.id);
      if (!notif) continue;
      if (notif.type.endsWith("_success")) {
        // Refetch — свежий job появится в списке с outputs'ами.
        void refetch();
        onJobResolved(pending.id);
      } else if (notif.type.endsWith("_error")) {
        if (pending.errorMessage !== notif.message) {
          onJobFailed(pending.id, notif.message);
        }
      }
    }
  }, [notifications, pendingJobs, onJobResolved, onJobFailed]);

  // Скрываем pending'и, для которых job уже есть в history (race между
  // refetch'ем и pendingJobs cleanup из родителя — лучше не дублировать).
  const historyIds = useMemo(() => new Set(history.map((h) => h.id)), [history]);
  const visiblePending = pendingJobs.filter((p) => !historyIds.has(p.id));

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
          <PendingCard key={p.id} job={p} onDismiss={() => onJobResolved(p.id)} />
        ))}
        {history.map((j) => (
          <HistoryCard key={j.id} job={j} />
        ))}
      </div>
    </div>
  );
}

function PendingCard({ job, onDismiss }: { job: PendingJob; onDismiss: () => void }) {
  const { t } = useTranslation();
  const isError = !!job.errorMessage;
  return (
    <div className={isError ? "gen-history-card is-error" : "gen-history-card is-pending"}>
      <div className="gen-history-card-head">
        {isError ? (
          <>
            <AlertCircle size={14} />
            <span>{t("generate.historyError")}</span>
          </>
        ) : (
          <>
            <Loader2 size={14} className="spin" />
            <span>{t("generate.historyGenerating")}</span>
          </>
        )}
      </div>
      <div className="gen-history-card-prompt">{job.prompt || "—"}</div>
      {isError && (
        <>
          <div className="gen-history-card-error">{job.errorMessage}</div>
          <button type="button" className="gen-history-card-dismiss" onClick={onDismiss}>
            {t("common.close")}
          </button>
        </>
      )}
    </div>
  );
}

function HistoryCard({ job }: { job: GenerationJobDto }) {
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
            <OutputThumb key={o.id} url={o.url} thumb={o.thumbnailUrl} section={job.section} />
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
}: {
  url: string | null;
  thumb: string | null;
  section: string;
}) {
  if (!url) {
    return <div className="gen-history-output gen-history-output--placeholder" />;
  }
  if (section === "video") {
    return (
      <video
        className="gen-history-output"
        src={url}
        poster={thumb ?? undefined}
        controls
        playsInline
        preload="metadata"
      />
    );
  }
  if (section === "audio") {
    return <audio className="gen-history-output gen-history-output--audio" src={url} controls />;
  }
  // image / design (default)
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="gen-history-output-link">
      <img className="gen-history-output" src={thumb ?? url} alt="" loading="lazy" />
    </a>
  );
}
