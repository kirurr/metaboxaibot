import { Fragment, useDeferredValue, useMemo, useState, useTransition } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Download, Plus, RefreshCw, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { listDialogs, type DialogDto } from "@/api/dialogs";
import { formatTokensK } from "@/components/chat/chatHelpers";

type DayKey = "today" | "yesterday" | "thisWeek" | "earlier";

const SECTION_FILTERS = ["all", "gpt", "design", "video", "audio"] as const;
type SectionFilter = (typeof SECTION_FILTERS)[number];

const MIN_SEARCH_LEN = 2;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Группирует диалоги по дням относительно текущего времени. Сортировка
 * сохраняется (бэк отдаёт по `updatedAt desc`), внутри группы порядок не
 * меняем.
 */
function groupByDay(dialogs: DialogDto[]): Record<DayKey, DialogDto[]> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(todayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - 6);

  const out: Record<DayKey, DialogDto[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  };
  for (const d of dialogs) {
    const dt = new Date(d.updatedAt);
    if (dt >= todayStart) out.today.push(d);
    else if (dt >= yesterdayStart) out.yesterday.push(d);
    else if (dt >= weekStart) out.thisWeek.push(d);
    else out.earlier.push(d);
  }
  return out;
}

const DAY_ORDER: DayKey[] = ["today", "yesterday", "thisWeek", "earlier"];

/**
 * Куда вести при клике на строку истории.
 * - gpt → текстовый чат с поддержкой /chat/:id.
 * - image/video/audio → последняя завершённая генерация в /gallery/:jobId.
 * - Если у media-диалога нет done-job'а (`latestJobId === null`), переходить
 *   некуда — возвращаем `null`, строка визуально приглушается и клик
 *   игнорируется.
 */
function openHref(d: DialogDto): string | null {
  if (d.section === "gpt") return `/chat/${d.id}`;
  if (d.latestJobId) return `/gallery/${d.latestJobId}`;
  return null;
}

/** Компактная подпись времени: HH:mm / weekday / DD MMM — выбор по дню. */
function formatTimeForDay(iso: string, day: DayKey, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  if (day === "today" || day === "yesterday") {
    return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  if (day === "thisWeek") {
    return d.toLocaleDateString(locale, { weekday: "short" });
  }
  return d.toLocaleDateString(locale, { day: "numeric", month: "short" });
}

export default function History() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [q, setQ] = useState("");
  const [section, setSection] = useState<SectionFilter>("all");
  const [, startTransition] = useTransition();

  const debouncedQ = useDebouncedValue(q.trim(), SEARCH_DEBOUNCE_MS);
  // q короче порога считаем «нет поиска» — UI отзывчив, сервер не дёргается.
  const effectiveQ = debouncedQ.length >= MIN_SEARCH_LEN ? debouncedQ : "";

  const query = useQuery({
    queryKey: ["history-dialogs", effectiveQ],
    queryFn: ({ signal }) =>
      listDialogs({
        // Секцию фильтруем client-side: данных мало, переключение секций
        // не должно слать новые запросы.
        q: effectiveQ || undefined,
        withStats: true,
        signal,
      }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  // Section-фильтр клиент-сайд. useDeferredValue даёт планировщику снизить
  // приоритет фильтрации/группировки, чтобы клики по чипсам ощущались мгновенно.
  const deferredSection = useDeferredValue(section);
  const filteredBySection = useMemo(() => {
    const list = query.data ?? [];
    if (deferredSection === "all") return list;
    return list.filter((d) => d.section === deferredSection);
  }, [query.data, deferredSection]);

  const grouped = useMemo(() => groupByDay(filteredBySection), [filteredBySection]);
  const isEmpty = filteredBySection.length === 0;
  const isInitialLoading = query.isLoading && !query.data;
  // Фоновое обновление поверх previousData: показываем мягкий индикатор без
  // подмены контента (контейнер не меняет высоту, список не прыгает).
  const isBackgroundFetching = query.isFetching && !!query.data;

  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1 className="h1">{t("history.title")}</h1>
          <p className="sub">{t("history.subtitle")}</p>
        </div>
        <div className="actions">
          <button className="btn btn-secondary" disabled>
            <Download size={16} /> {t("history.exportAll")}
          </button>
          <button className="btn btn-primary" onClick={() => navigate("/chat")}>
            <Plus size={16} /> {t("history.newChat")}
          </button>
        </div>
      </div>

      <div
        className="rise d1"
        style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}
      >
        <div className="input-group" style={{ maxWidth: 480, flex: "1 1 320px" }}>
          <span className="leading-icon" aria-hidden>
            {isBackgroundFetching ? (
              <RefreshCw size={16} className="anim-spin" />
            ) : (
              <Search size={16} />
            )}
          </span>
          <input
            className="input"
            placeholder={t("history.searchPlaceholder")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-busy={isBackgroundFetching}
          />
        </div>
        <div
          role="tablist"
          aria-label={t("history.filters.label")}
          style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
        >
          {SECTION_FILTERS.map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={section === s}
              className={clsx("btn", section === s ? "btn-primary" : "btn-secondary", "btn-sm")}
              onClick={() => startTransition(() => setSection(s))}
            >
              {t(`history.filters.${s}`)}
            </button>
          ))}
        </div>
      </div>

      <div
        className="history-list rise d2"
        aria-busy={isBackgroundFetching}
        style={{
          opacity: isBackgroundFetching ? 0.55 : 1,
          transition: "opacity 150ms ease",
        }}
      >
        {query.isError && (
          <div className="empty-illu">
            {(query.error as { message?: string } | null)?.message ?? t("history.errorLoad")}
          </div>
        )}
        {isInitialLoading && !query.isError && (
          <div className="empty-illu">{t("history.loading")}</div>
        )}
        {!isInitialLoading && !query.isError && isEmpty && (
          <div className="empty-illu">
            {effectiveQ ? t("history.emptyMatch", { q: effectiveQ }) : t("history.emptyAll")}
          </div>
        )}
        {!isInitialLoading &&
          !query.isError &&
          DAY_ORDER.map((day) => {
            const items = grouped[day];
            if (items.length === 0) return null;
            return (
              <Fragment key={day}>
                <div className="history-day">{t(`history.days.${day}`)}</div>
                {items.map((d) => {
                  const href = openHref(d);
                  return (
                    <HistoryRow
                      key={d.id}
                      dialog={d}
                      day={day}
                      locale={i18n.language}
                      isMobile={isMobile}
                      onOpen={href ? () => navigate(href) : null}
                      fallbackTitle={t("chat.newDialog")}
                    />
                  );
                })}
              </Fragment>
            );
          })}
      </div>
    </div>
  );
}

function HistoryRow({
  dialog,
  day,
  locale,
  isMobile,
  onOpen,
  fallbackTitle,
}: {
  dialog: DialogDto;
  day: DayKey;
  locale: string;
  isMobile: boolean;
  /** `null` — у строки нет цели перехода (media без done-job'а). */
  onOpen: (() => void) | null;
  fallbackTitle: string;
}) {
  const isOpenable = onOpen !== null;
  return (
    <div
      className="history-row"
      onClick={onOpen ?? undefined}
      style={isOpenable ? undefined : { cursor: "default", opacity: 0.7 }}
    >
      <div style={{ minWidth: 0 }}>
        <div className="h-title">{dialog.title ?? fallbackTitle}</div>
        {dialog.snippet ? (
          <div className="h-preview">{dialog.snippet}</div>
        ) : (
          <div className="h-preview" style={{ color: "var(--text-tertiary, #999)" }}>
            {dialog.section}
          </div>
        )}
      </div>
      <div className="meta">
        <span className="h-model">{dialog.modelId}</span>
        {!isMobile && typeof dialog.totalTokens === "number" && (
          <span className="mono">{formatTokensK(dialog.totalTokens)}</span>
        )}
        <span>{formatTimeForDay(dialog.updatedAt, day, locale)}</span>
        {isOpenable && <ChevronRight size={16} />}
      </div>
    </div>
  );
}
