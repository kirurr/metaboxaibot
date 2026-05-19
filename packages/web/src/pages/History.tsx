import { Fragment, useState, useTransition } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Download, Plus, RefreshCw, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { listHistory, type HistoryItemDto } from "@/api/history";
import { formatTokensK } from "@/components/chat/chatHelpers";

type DayKey = "today" | "yesterday" | "thisWeek" | "earlier";

const SECTION_FILTERS = ["all", "gpt", "design", "video", "audio"] as const;
type SectionFilter = (typeof SECTION_FILTERS)[number];

const MIN_SEARCH_LEN = 2;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Группирует элементы истории по дням (отсчёт от текущего момента).
 * Внутри группы порядок сохраняется (бэк отдаёт по `updatedAt desc`).
 */
function groupByDay(items: HistoryItemDto[]): Record<DayKey, HistoryItemDto[]> {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(todayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - 6);

  const out: Record<DayKey, HistoryItemDto[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    earlier: [],
  };
  for (const it of items) {
    const dt = new Date(it.updatedAt);
    if (dt >= todayStart) out.today.push(it);
    else if (dt >= yesterdayStart) out.yesterday.push(it);
    else if (dt >= weekStart) out.thisWeek.push(it);
    else out.earlier.push(it);
  }
  return out;
}

const DAY_ORDER: DayKey[] = ["today", "yesterday", "thisWeek", "earlier"];

/**
 * Куда вести при клике:
 *  - dialog (gpt) → `/chat/${id}` (поддержка id-параметра в роуте).
 *  - job (media)  → `/gallery/${jobId}` (GalleryPage умеет открывать конкретную job).
 */
function openHref(item: HistoryItemDto): string {
  return item.kind === "job" ? `/gallery/${item.id}` : `/chat/${item.id}`;
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

  const serverSection = section === "all" ? undefined : section;

  const query = useQuery({
    queryKey: ["history", serverSection ?? "all", effectiveQ],
    queryFn: ({ signal }) =>
      listHistory({
        section: serverSection,
        q: effectiveQ || undefined,
        signal,
      }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const items = query.data ?? [];
  const grouped = groupByDay(items);
  const isEmpty = items.length === 0;
  const isInitialLoading = query.isLoading && !query.data;
  // Фоновое обновление поверх previousData: мягкий индикатор, без подмены.
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
            const dayItems = grouped[day];
            if (dayItems.length === 0) return null;
            return (
              <Fragment key={day}>
                <div className="history-day">{t(`history.days.${day}`)}</div>
                {dayItems.map((it) => (
                  <HistoryRow
                    key={`${it.kind}:${it.id}`}
                    item={it}
                    day={day}
                    locale={i18n.language}
                    isMobile={isMobile}
                    onOpen={() => navigate(openHref(it))}
                    fallbackTitle={t("chat.newDialog")}
                  />
                ))}
              </Fragment>
            );
          })}
      </div>
    </div>
  );
}

function HistoryRow({
  item,
  day,
  locale,
  isMobile,
  onOpen,
  fallbackTitle,
}: {
  item: HistoryItemDto;
  day: DayKey;
  locale: string;
  isMobile: boolean;
  onOpen: () => void;
  fallbackTitle: string;
}) {
  // failed-джобы помечаем приглушением, чтобы UX отделял их от done.
  const dim = item.kind === "job" && item.status === "failed";
  return (
    <div
      className="history-row"
      onClick={onOpen}
      style={dim ? { opacity: 0.65 } : undefined}
    >
      <div style={{ minWidth: 0 }}>
        <div className="h-title">{item.title ?? fallbackTitle}</div>
        {item.snippet ? (
          <div className="h-preview">{item.snippet}</div>
        ) : (
          <div className="h-preview" style={{ color: "var(--text-tertiary, #999)" }}>
            {item.section}
          </div>
        )}
      </div>
      <div className="meta">
        <span className="h-model">{item.modelId}</span>
        {!isMobile && (
          <span className="mono">{formatTokensK(item.totalTokens)}</span>
        )}
        <span>{formatTimeForDay(item.updatedAt, day, locale)}</span>
        <ChevronRight size={16} />
      </div>
    </div>
  );
}
