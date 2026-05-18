import { useMemo, useState } from "react";
import { ArrowRight, Download, Plus, RefreshCw, Sparkles, Star } from "lucide-react";
import clsx from "clsx";
import { Trans, useTranslation } from "react-i18next";
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

export default function Tokens() {
  const { t } = useTranslation();
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
          <h1 className="h1">{t("tokens.title")}</h1>
          <p className="sub">{t("tokens.subtitle")}</p>
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
            {t("tokens.last28Days")}
          </div>
        </div>
        <div className="token-orb" aria-hidden="true" />
      </div>

      <h2 className="section-title rise d2" style={{ marginTop: 8 }}>
        {t("tokens.choosePack")}
      </h2>
      <div className="packs rise d2">
        {packs.map((p, i) => (
          <div key={i} className={clsx("pack", sel === i && "selected")} onClick={() => setSel(i)}>
            {p.bonus && (
              <span className="pack-bonus">{t("tokens.bonusOf", { percent: p.bonus })}</span>
            )}
            <div>
              <span className="pack-amount">{p.amount}</span>
              <span className="pack-unit">{t("tokens.tokensUnit")}</span>
            </div>
            <div className="pack-rate">{p.rate}</div>
            <div className="pack-price mono">${p.price}</div>
          </div>
        ))}
      </div>

      <h2 className="section-title rise d3" style={{ marginTop: 8 }}>
        {t("tokens.customAmount")}
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
          {t("tokens.continueToPayment")} <ArrowRight size={16} />
        </button>
      </div>
      <p className="hint" style={{ marginTop: -6, fontSize: 12 }}>
        {t("tokens.minPaymentHint")}
      </p>

      <div className="rise d4" style={{ marginTop: 16 }}>
        <div className="row between" style={{ marginBottom: 14, flexWrap: "wrap", gap: 12 }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            {t("tokens.txHistory")}
          </h2>
          <button className="btn btn-ghost btn-sm">
            <Download size={14} /> {t("tokens.exportCsv")}
          </button>
        </div>

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
