import { Fragment, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronRight, Download, Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useIsMobile } from "@/hooks/useIsMobile";

type Item = {
  title: string;
  preview: string;
  model: string;
  time: string;
  tokens: string;
};

// Mock-данные группированы по `dayKey` (i18n-ключ заголовка), сами тексты —
// дизайн-плейсхолдеры (имитация истории чатов). Реальная история подтягивается
// в чате через /web/dialogs, эта страница — каталог-агрегатор по дням.
const historyData: { dayKey: string; items: Item[] }[] = [
  {
    dayKey: "history.days.today",
    items: [
      {
        title: "Restructure product launch announcement",
        preview: "Open with the pain, not the brand. Lead with what was annoying…",
        model: "Sonnet 4.5",
        time: "14:02",
        tokens: "2.1k",
      },
      {
        title: "Q3 OKR draft review",
        preview: "Three of the five OKRs are activity, not outcome. Specifically…",
        model: "GPT-5",
        time: "11:47",
        tokens: "3.8k",
      },
    ],
  },
  {
    dayKey: "history.days.yesterday",
    items: [
      {
        title: "SQL for cohort retention by signup channel",
        preview: "Use a self-join on a generated date spine; here's the pattern…",
        model: "Sonnet 4.5",
        time: "18:21",
        tokens: "5.2k",
      },
      {
        title: "Translate contract clauses to plain English",
        preview: "Clause 4.2 effectively means you can be charged twice if…",
        model: "Sonnet 4.5",
        time: "10:03",
        tokens: "1.9k",
      },
      {
        title: "Logo concepts for Northbound",
        preview: "Try a compass needle as the negative space inside an N…",
        model: "Image · v3",
        time: "09:14",
        tokens: "—",
      },
    ],
  },
  {
    dayKey: "history.days.thisWeek",
    items: [
      {
        title: "Brainstorm: pricing experiment for paid tier",
        preview: "Three frames to test, in order of riskiest assumption…",
        model: "GPT-5",
        time: "Mon 16:30",
        tokens: "4.4k",
      },
      {
        title: "Onboarding email sequence — 4 emails",
        preview: "Day 0: thanks + one tip. Day 2: first activation prompt…",
        model: "Sonnet 4.5",
        time: "Mon 09:12",
        tokens: "6.7k",
      },
    ],
  },
  {
    dayKey: "history.days.earlier",
    items: [
      {
        title: "Convert React component to plain HTML",
        preview: "Stripped JSX and inlined the useState; here's the equivalent…",
        model: "Sonnet 4.5",
        time: "Apr 28",
        tokens: "2.0k",
      },
    ],
  },
];

export default function History() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [q, setQ] = useState("");

  const filtered = useMemo(
    () =>
      historyData
        .map((g) => ({
          ...g,
          items: g.items.filter((i) =>
            (i.title + " " + i.preview).toLowerCase().includes(q.toLowerCase()),
          ),
        }))
        .filter((g) => g.items.length),
    [q],
  );

  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1 className="h1">{t("history.title")}</h1>
          <p className="sub">{t("history.subtitle")}</p>
        </div>
        <div className="actions">
          <button className="btn btn-secondary">
            <Download size={16} /> {t("history.exportAll")}
          </button>
          <button className="btn btn-primary" onClick={() => navigate("/chat")}>
            <Plus size={16} /> {t("history.newChat")}
          </button>
        </div>
      </div>

      <div className="input-group rise d1" style={{ maxWidth: 480 }}>
        <span className="leading-icon">
          <Search size={16} />
        </span>
        <input
          className="input"
          placeholder={t("history.searchPlaceholder")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="history-list rise d2">
        {filtered.length === 0 && (
          <div className="empty-illu">{t("history.emptyMatch", { q })}</div>
        )}
        {filtered.map((g) => (
          <Fragment key={g.dayKey}>
            <div className="history-day">{t(g.dayKey)}</div>
            {g.items.map((it, i) => (
              <div key={i} className="history-row" onClick={() => navigate("/chat")}>
                <div style={{ minWidth: 0 }}>
                  <div className="h-title">{it.title}</div>
                  <div className="h-preview">{it.preview}</div>
                </div>
                <div className="meta">
                  <span className="h-model">{it.model}</span>
                  {!isMobile && <span className="mono">{it.tokens}</span>}
                  <span>{it.time}</span>
                  <ChevronRight size={16} />
                </div>
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
