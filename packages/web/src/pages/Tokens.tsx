import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, Plus, RefreshCw, Sparkles, Star } from "lucide-react";
import clsx from "clsx";
import { Trans, useTranslation } from "react-i18next";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useAuthStore } from "@/stores/authStore";
import { useUIStore } from "@/stores/uiStore";
import { useTransactions } from "@/hooks/useTransactions";
import { formatTokenDelta, formatTokens, formatTxnTime, parseTokens } from "@/utils/format";
import { getCatalog, createTokensOrder, type TokenPackDto } from "@/api/billing";
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

export default function Tokens() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const user = useAuthStore((s) => s.user);
  const pushToast = useUIStore((s) => s.pushToast);
  const { transactions, loading, error } = useTransactions();

  const [filter, setFilter] = useState<FilterId>("all");

  // Реальные пакеты токенов из БД (через /web/billing/catalog).
  const [packs, setPacks] = useState<TokenPackDto[] | null>(null);
  const [packsError, setPacksError] = useState<string | null>(null);
  const [buyingId, setBuyingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCatalog()
      .then((c) => {
        if (!cancelled) setPacks(c.tokenPackages);
      })
      .catch((err: ApiError) => {
        if (!cancelled) setPacksError(err.message || t("tokens.packsError"));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function buyTokens(pkg: TokenPackDto) {
    if (buyingId) return;
    setBuyingId(pkg.id);
    try {
      const { paymentUrl } = await createTokensOrder(pkg.id);
      window.location.href = paymentUrl;
    } catch (err) {
      setBuyingId(null);
      pushToast({
        type: "error",
        message: err instanceof ApiError ? err.message : t("common.error"),
      });
    }
  }

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
            const busy = buyingId === p.id;
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
                  onClick={() => buyTokens(p)}
                  disabled={buyingId !== null}
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
