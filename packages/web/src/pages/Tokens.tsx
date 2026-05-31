import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Loader2, Plus, RefreshCw, Sparkles, Star } from "lucide-react";
import clsx from "clsx";
import { Trans, useTranslation } from "react-i18next";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useAuthStore } from "@/stores/authStore";
import { useUIStore } from "@/stores/uiStore";
import { useTransactions } from "@/hooks/useTransactions";
import { useDailyUsage } from "@/hooks/useDailyUsage";
import { useCatalog } from "@/hooks/useCatalog";
import { useBuyTokens } from "@/hooks/useBuyTokens";
import {
  formatTokenDelta,
  formatTokens,
  formatTokensSpent,
  formatTxnTime,
  parseTokens,
} from "@/utils/format";
import { type TokenPackDto } from "@/api/billing";
import { ApiError } from "@/api/client";
import type { TransactionDto } from "@/api/auth";

type UiKind = "use" | "topup" | "bonus" | "refund";

/** Список фильтров — `label` резолвится в рендере через `t(labelKey)`. */
const FILTERS: { id: "all" | UiKind; labelKey: string }[] = [
  { id: "all", labelKey: "tokens.filters.all" },
  { id: "use", labelKey: "tokens.filters.use" },
  { id: "topup", labelKey: "tokens.filters.topup" },
  { id: "bonus", labelKey: "tokens.filters.bonus" },
  { id: "refund", labelKey: "tokens.filters.refund" },
];

type FilterId = (typeof FILTERS)[number]["id"];

/**
 * Маппит транзакцию из API в UI-категорию (по шаблону из дизайн-заглушки).
 * Refund'ы у нас сейчас приходят с `reason` вида `ai_image_undelivered` /
 * `ai_video_undelivered` / `ai_audio_undelivered` (см. worker processors,
 * refundTokens). Отдельного reason="refund" нет.
 */
function categorize(t: TransactionDto): UiKind {
  if (t.reason === "purchase" || t.reason === "metabox_purchase") return "topup";
  if (t.reason.endsWith("_undelivered") || t.reason.startsWith("refund")) return "refund";
  if (t.type === "debit") return "use";
  return "bonus";
}

function txIcon(kind: UiKind) {
  if (kind === "use") return <Sparkles size={18} />;
  if (kind === "topup") return <Plus size={18} />;
  if (kind === "bonus") return <Star size={18} />;
  if (kind === "refund") return <RefreshCw size={18} />;
  return <Sparkles size={18} />;
}

/** Человекочитаемый текст транзакции: `description` или fallback по reason. */
function txTitle(tx: TransactionDto, t: (k: string) => string): string {
  if (tx.description?.trim()) return tx.description;
  switch (tx.reason) {
    case "ai_usage":
      return t("tokens.tx.aiUsage");
    case "purchase":
    case "metabox_purchase":
      return t("tokens.tx.purchase");
    case "welcome_bonus":
      return t("tokens.tx.welcomeBonus");
    case "referral_bonus":
      return t("tokens.tx.referralBonus");
    case "admin":
      return t("tokens.tx.admin");
    default:
      if (tx.reason.endsWith("_undelivered")) return t("tokens.tx.refundFailed");
      return tx.reason;
  }
}

/** Минимальная высота полоски графика (% от высоты области), чтобы дни с
 *  нулевым/малым расходом всё равно были видны. */
const BAR_MIN_PCT = 14;

/** "2026-05-24" → "24 мая" (локальная дата без сдвига часового пояса). */
function formatDayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

export default function Tokens() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const user = useAuthStore((s) => s.user);
  const pushToast = useUIStore((s) => s.pushToast);
  const { transactions, loading, error } = useTransactions();

  const [filter, setFilter] = useState<FilterId>("all");
  // Выбранный день графика. null → дефолт «сегодня» (последний день).
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  // Реальные пакеты токенов из БД (через /web/billing/catalog).
  const catalog = useCatalog();
  const packs = catalog.data?.tokenPackages ?? null;
  const packsError = catalog.error
    ? catalog.error instanceof ApiError
      ? catalog.error.message
      : t("tokens.packsError")
    : null;
  const buyTokens = useBuyTokens();

  function handleBuy(pkg: TokenPackDto) {
    if (buyTokens.isPending) return;
    buyTokens.mutate(pkg.id, {
      onError: (err) => {
        pushToast({
          type: "error",
          message: err instanceof ApiError ? err.message : t("common.error"),
        });
      },
    });
  }

  const totalBalanceRaw = user
    ? String(parseTokens(user.tokenBalance) + parseTokens(user.subscriptionTokenBalance))
    : "0";
  const totalBalance = formatTokens(totalBalanceRaw);

  // Реальный дневной расход токенов за 28 дней (zero-fill с бэкенда).
  const { days } = useDailyUsage();
  const maxSpent = useMemo(
    () => days.reduce((m, d) => Math.max(m, parseTokens(d.spent)), 0),
    [days],
  );
  // По умолчанию выбран сегодня (последний день); readout не пустой при загрузке.
  const activeIndex = selectedDay ?? days.length - 1;
  const activeDay = days[activeIndex];

  // На мобилке график — горизонтальный скролл; проматываем к сегодня (вправо),
  // поэтому история (старые дни) уходит влево — туда же смотрят фейд и подсказка.
  const scrollRef = useRef<HTMLDivElement>(null);
  const programmaticScroll = useRef(false);
  const [edges, setEdges] = useState({ atStart: true, atEnd: true });
  const [hintSeen, setHintSeen] = useState(false);

  function updateEdges() {
    const el = scrollRef.current;
    if (!el) return;
    setEdges({
      atStart: el.scrollLeft <= 1,
      atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
    });
  }

  function onChartScroll() {
    updateEdges();
    // Первый скролл — программный (промотка к сегодня), он не должен прятать хинт.
    if (programmaticScroll.current) {
      programmaticScroll.current = false;
      return;
    }
    if (!hintSeen) setHintSeen(true);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (isMobile && el) {
      programmaticScroll.current = true;
      el.scrollLeft = el.scrollWidth;
      updateEdges();
    }
  }, [isMobile, days.length]);

  /** Индекс дня по X-координате указателя (скраб мышью по всей области, десктоп). */
  function dayFromPointer(e: PointerEvent<HTMLDivElement>) {
    if (days.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const idx = Math.min(days.length - 1, Math.max(0, Math.round(ratio * (days.length - 1))));
    setSelectedDay(idx);
  }

  const categorized = useMemo(
    () => transactions.map((t) => ({ tx: t, kind: categorize(t) })),
    [transactions],
  );
  const filtered = filter === "all" ? categorized : categorized.filter((x) => x.kind === filter);
  const counts: Record<string, number> = FILTERS.reduce<Record<string, number>>((acc, f) => {
    acc[f.id] =
      f.id === "all" ? categorized.length : categorized.filter((x) => x.kind === f.id).length;
    return acc;
  }, {});

  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1 className="h1">{t("tokens.title")}</h1>
        </div>
      </div>

      <div className="token-hero rise d1">
        <div>
          <div
            className="muted"
            style={{ fontSize: 12, letterSpacing: 0.5, textTransform: "uppercase" }}
          >
            {t("tokens.currentBalance")}
          </div>
          <div
            style={{
              fontFamily: "var(--font-heading)",
              fontWeight: 700,
              fontSize: 64,
              letterSpacing: "-1.2px",
              lineHeight: 1.05,
              marginTop: 6,
            }}
          >
            {totalBalance}{" "}
            <span
              style={{
                fontSize: 18,
                color: "var(--text-secondary)",
                marginLeft: 8,
                letterSpacing: 0,
                fontWeight: 600,
              }}
            >
              {t("tokens.tokensUnit")}
            </span>
          </div>
          {user?.subscriptionTokenBalance && parseTokens(user.subscriptionTokenBalance) > 0 && (
            <div className="muted" style={{ marginTop: 6, fontSize: 14 }}>
              <Trans
                i18nKey="tokens.includingSubscription"
                values={{ tokens: formatTokens(user.subscriptionTokenBalance) }}
                components={{ mono: <span className="mono" /> }}
              />
            </div>
          )}
          <div className="usage-chart" role="group" aria-label={t("tokens.last28Days")}>
            <div className="usage-readout">
              <span className="usage-readout-value">
                {formatTokensSpent(activeDay?.spent ?? "0")}
                <span className="usage-readout-unit">{t("tokens.tokensUnit")}</span>
              </span>
              <span className="usage-readout-date">
                {activeDay ? formatDayLabel(activeDay.date) : ""}
              </span>
            </div>
            <div
              className={clsx(
                "spark-viewport",
                isMobile && !edges.atStart && "fade-left",
                isMobile && !edges.atEnd && "fade-right",
              )}
            >
              <div
                ref={scrollRef}
                className={clsx("spark", isMobile && "spark-scroll")}
                role="slider"
                tabIndex={0}
                aria-valuemin={0}
                aria-valuemax={Math.max(0, days.length - 1)}
                aria-valuenow={activeIndex >= 0 ? activeIndex : 0}
                aria-valuetext={
                  activeDay
                    ? `${formatDayLabel(activeDay.date)}: ${formatTokensSpent(activeDay.spent)}`
                    : ""
                }
                onScroll={isMobile ? onChartScroll : undefined}
                // Десктоп: скраб мышью. Мобилка: нативный горизонтальный скролл +
                // тап по бару (onClick ниже) — pointer-скраб мешал бы скроллу.
                onPointerDown={
                  isMobile
                    ? undefined
                    : (e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        dayFromPointer(e);
                      }
                }
                onPointerMove={isMobile ? undefined : dayFromPointer}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") setSelectedDay(Math.max(0, activeIndex - 1));
                  else if (e.key === "ArrowRight")
                    setSelectedDay(Math.min(days.length - 1, activeIndex + 1));
                }}
              >
                {days.map((d, i) => {
                  const v = parseTokens(d.spent);
                  const h =
                    maxSpent > 0 ? Math.max((v / maxSpent) * 100, BAR_MIN_PCT) : BAR_MIN_PCT;
                  return (
                    <span
                      key={d.date}
                      className={clsx("spark-bar", i === activeIndex && "active")}
                      style={{ height: `${h}%` }}
                      onClick={() => setSelectedDay(i)}
                    />
                  );
                })}
              </div>
              {isMobile && !hintSeen && days.length > 0 && (
                <div className="spark-hint" aria-hidden="true">
                  ← {t("tokens.scrollHint")}
                </div>
              )}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {t("tokens.last28Days")}
            </div>
          </div>
        </div>
        <div className="token-orb" aria-hidden="true" />
      </div>

      <h2 className="section-title rise d2" style={{ marginTop: 8 }}>
        {t("tokens.readyPacks")}
      </h2>

      {packs === null && !packsError && (
        <div className="muted rise d2" style={{ padding: "12px 0", display: "flex", gap: 8 }}>
          <Loader2 size={16} className="spin" /> <span>{t("app.loading")}</span>
        </div>
      )}
      {packsError && (
        <div className="empty-illu rise d2" style={{ color: "var(--danger)" }}>
          {packsError}
        </div>
      )}
      {packs !== null && !packsError && packs.length === 0 && (
        <div className="empty-illu rise d2">{t("tokens.packsEmpty")}</div>
      )}

      {packs !== null && packs.length > 0 && (
        <div className="packs rise d2">
          {packs.map((p) => {
            const badgeLabel =
              p.badge === "top"
                ? t("plans.badgeTop")
                : p.badge === "profitable" || p.badge === "best_value"
                  ? t("plans.badgeProfitable")
                  : p.badge;
            const busy = buyTokens.isPending && buyTokens.variables === p.id;
            const isProfitable = p.badge === "profitable" || p.badge === "best_value";
            return (
              <div key={p.id} className="pack" style={{ cursor: "default" }}>
                {p.badge && <span className="pack-bonus">{badgeLabel}</span>}
                <div>
                  <span className="pack-amount">{p.tokens.toLocaleString("ru-RU")}</span>
                  <span className="pack-unit">{t("tokens.tokensUnit")}</span>
                </div>
                <div className="pack-rate">{p.name}</div>
                <div className="pack-price mono">
                  {Number(p.priceRub).toLocaleString("ru-RU")} ₽
                </div>
                <button
                  className={clsx("btn btn-primary", isProfitable && "btn-heartbeat")}
                  style={{ width: "100%", marginTop: 16 }}
                  onClick={() => handleBuy(p)}
                  disabled={buyTokens.isPending}
                >
                  {busy ? (
                    <>
                      <Loader2 size={14} className="spin" /> {t("tokens.processing")}
                    </>
                  ) : (
                    t("tokens.buy")
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="rise d4" style={{ marginTop: 16 }}>
        <h2 className="section-title" style={{ marginBottom: 14 }}>
          {t("tokens.txHistory")}
        </h2>

        <div className="tx-filters">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={clsx("tx-filter", filter === f.id && "on")}
              onClick={() => setFilter(f.id)}
            >
              {t(f.labelKey)} <span className="count">{counts[f.id] ?? 0}</span>
            </button>
          ))}
        </div>

        {loading && (
          <div className="empty-illu" style={{ marginTop: 12 }}>
            {t("common.loading")}
          </div>
        )}
        {error && !loading && (
          <div className="empty-illu" style={{ marginTop: 12, color: "var(--danger)" }}>
            {error}
          </div>
        )}
        {!loading && !error && (
          <>
            <div className="tx-list" style={{ marginTop: 12 }}>
              {filtered.map(({ tx, kind }) => (
                <div key={tx.id} className="tx-row">
                  <div className={"tx-ico " + kind}>{txIcon(kind)}</div>
                  <div style={{ minWidth: 0 }}>
                    <div className="tx-title">{txTitle(tx, t)}</div>
                    <div className="tx-sub">
                      {tx.modelId && <span className="model-tag">{tx.modelId}</span>}
                      <span>{formatTxnTime(tx.createdAt)}</span>
                    </div>
                  </div>
                  {!isMobile && <span className="tx-time" />}
                  <span className={"tx-amount " + (parseTokens(tx.amount) < 0 ? "neg" : "pos")}>
                    {formatTokenDelta(tx.amount)}
                  </span>
                </div>
              ))}
            </div>
            {filtered.length === 0 && (
              <div className="empty-illu" style={{ marginTop: 12 }}>
                {transactions.length === 0 ? t("tokens.empty") : t("tokens.emptyForFilter")}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
