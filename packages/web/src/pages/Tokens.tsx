import { useMemo, useState } from "react";
import { ArrowRight, Download, Plus, RefreshCw, Sparkles, Star } from "lucide-react";
import clsx from "clsx";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useAuthStore } from "@/stores/authStore";
import { useTransactions } from "@/hooks/useTransactions";
import { formatTokenDelta, formatTokens, formatTxnTime, parseTokens } from "@/utils/format";
import type { TransactionDto } from "@/api/auth";

type Pack = {
  amount: string;
  price: number;
  rate: string;
  bonus: string | null;
};

const packs: Pack[] = [
  { amount: "500K", price: 5, rate: "$0.01 / 1k", bonus: null },
  { amount: "2M", price: 18, rate: "$0.009 / 1k", bonus: "+10%" },
  { amount: "10M", price: 79, rate: "$0.008 / 1k", bonus: "+20%" },
  { amount: "25M", price: 179, rate: "$0.0072 / 1k", bonus: "+25%" },
  { amount: "50M", price: 339, rate: "$0.0068 / 1k", bonus: "+30%" },
  { amount: "100M", price: 629, rate: "$0.0063 / 1k", bonus: "+35%" },
];

type UiKind = "use" | "topup" | "bonus" | "refund";

const FILTERS: { id: "all" | UiKind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "use", label: "AI usage" },
  { id: "topup", label: "Top-ups" },
  { id: "bonus", label: "Bonuses" },
  { id: "refund", label: "Refunds" },
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
function txTitle(t: TransactionDto): string {
  if (t.description?.trim()) return t.description;
  switch (t.reason) {
    case "ai_usage":
      return "AI генерация";
    case "purchase":
    case "metabox_purchase":
      return "Покупка токенов";
    case "welcome_bonus":
      return "Приветственный бонус";
    case "referral_bonus":
      return "Реферальный бонус";
    case "admin":
      return "Начисление администратором";
    default:
      if (t.reason.endsWith("_undelivered")) return "Возврат за неуспешную генерацию";
      return t.reason;
  }
}

export default function Tokens() {
  const isMobile = useIsMobile();
  const user = useAuthStore((s) => s.user);
  const { transactions, loading, error } = useTransactions();

  const [sel, setSel] = useState(2);
  const [custom, setCustom] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");

  const totalBalanceRaw = user
    ? String(parseTokens(user.tokenBalance) + parseTokens(user.subscriptionTokenBalance))
    : "0";
  const totalBalance = formatTokens(totalBalanceRaw);

  // Декоративный sparkline — реальных дневных агрегатов нет, оставляем псевдо-данные.
  const spark = useMemo(
    () =>
      Array.from(
        { length: 28 },
        (_, i) => 20 + Math.round(60 * Math.abs(Math.sin(i * 0.7) + Math.cos(i * 0.3))),
      ),
    [],
  );
  const max = Math.max(...spark);

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
          <h1 className="h1">Top up.</h1>
          <p className="sub">
            Buy tokens once, use them whenever. They never expire, and bigger packs cost less per
            million.
          </p>
        </div>
      </div>

      <div className="token-hero rise d1">
        <div>
          <div
            className="muted"
            style={{ fontSize: 12, letterSpacing: 0.5, textTransform: "uppercase" }}
          >
            Current balance
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
              tokens
            </span>
          </div>
          {user?.subscriptionTokenBalance && parseTokens(user.subscriptionTokenBalance) > 0 && (
            <div className="muted" style={{ marginTop: 6, fontSize: 14 }}>
              включая <span className="mono">{formatTokens(user.subscriptionTokenBalance)}</span> по
              подписке
            </div>
          )}
          <div className="spark">
            {spark.map((v, i) => (
              <span
                key={i}
                className={i > spark.length - 4 ? "hi" : ""}
                style={{ height: `${(v / max) * 100}%` }}
              />
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Last 28 days · daily usage
          </div>
        </div>
        <div className="token-orb" aria-hidden="true" />
      </div>

      <h2 className="section-title rise d2" style={{ marginTop: 8 }}>
        Choose a pack
      </h2>
      <div className="packs rise d2">
        {packs.map((p, i) => (
          <div key={i} className={clsx("pack", sel === i && "selected")} onClick={() => setSel(i)}>
            {p.bonus && <span className="pack-bonus">{p.bonus} bonus</span>}
            <div>
              <span className="pack-amount">{p.amount}</span>
              <span className="pack-unit">tokens</span>
            </div>
            <div className="pack-rate">{p.rate}</div>
            <div className="pack-price mono">${p.price}</div>
          </div>
        ))}
      </div>

      <h2 className="section-title rise d3" style={{ marginTop: 8 }}>
        Or a custom amount
      </h2>
      <div className="custom-amount-row rise d3">
        <div className="amount-input">
          <input
            type="text"
            placeholder="0"
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <span className="suffix">USD</span>
        </div>
        <button
          className="btn btn-primary"
          style={{ minWidth: 200 }}
          disabled={!custom && sel === null}
        >
          Continue to payment <ArrowRight size={16} />
        </button>
      </div>
      <p className="hint" style={{ marginTop: -6, fontSize: 12 }}>
        Minimum $5 · Tokens added instantly · Receipt emailed automatically
      </p>

      <div className="rise d4" style={{ marginTop: 16 }}>
        <div className="row between" style={{ marginBottom: 14, flexWrap: "wrap", gap: 12 }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            Transaction history
          </h2>
          <button className="btn btn-ghost btn-sm">
            <Download size={14} /> Export CSV
          </button>
        </div>

        <div className="tx-filters">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={clsx("tx-filter", filter === f.id && "on")}
              onClick={() => setFilter(f.id)}
            >
              {f.label} <span className="count">{counts[f.id] ?? 0}</span>
            </button>
          ))}
        </div>

        {loading && (
          <div className="empty-illu" style={{ marginTop: 12 }}>
            Загрузка…
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
                    <div className="tx-title">{txTitle(tx)}</div>
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
                {transactions.length === 0
                  ? "Транзакций пока нет."
                  : "Нет транзакций в этом фильтре."}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
