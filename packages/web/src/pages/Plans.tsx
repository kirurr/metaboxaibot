import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import {
  getCatalog,
  createSubscriptionOrder,
  createTokensOrder,
  type CatalogDto,
  type PlanDto,
  type TokenPackDto,
} from "@/api/billing";
import { ApiError } from "@/api/client";
import { useUIStore } from "@/stores/uiStore";

/**
 * Тарифы: подписки и пакеты токенов с Metabox-стороны (через web-billing-routes).
 * Параллель `packages/webapp/src/pages/TariffsPage.tsx`, но без Telegram Stars —
 * на вебе только редирект на Metabox/Lava-checkout.
 *
 * Flow покупки: фронт POST'ит `/web/billing/{subscription|tokens}-invoice` →
 * получает `paymentUrl` → `window.location.href = paymentUrl` (Metabox hosted
 * checkout). После оплаты юзер вернётся на /payment/success, поллинг через
 * /web/billing/order/:id/status (см. PaymentPending).
 */

type Period = "M1" | "M3" | "M6" | "M12";
const ALL_PERIODS: Period[] = ["M1", "M3", "M6", "M12"];
const PERIOD_MONTHS: Record<Period, number> = { M1: 1, M3: 3, M6: 6, M12: 12 };

export default function Plans() {
  const { t } = useTranslation();
  const pushToast = useUIStore((s) => s.pushToast);

  const [catalog, setCatalog] = useState<CatalogDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subPeriods, setSubPeriods] = useState<Record<string, Period>>({});
  const [buyingId, setBuyingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCatalog()
      .then((c) => {
        if (cancelled) return;
        setCatalog(c);
      })
      .catch((err: ApiError) => {
        if (cancelled) return;
        setError(err.message || t("plans.loadError"));
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  function getPeriodsFor(sub: PlanDto): Period[] {
    return ALL_PERIODS.filter((p) => !!sub.periods[p]);
  }
  function getSelectedPeriod(sub: PlanDto): Period {
    const sel = subPeriods[sub.id];
    if (sel && sub.periods[sel]) return sel;
    return "M1";
  }

  function handleBuyError(err: unknown) {
    if (err instanceof ApiError) {
      pushToast({ type: "error", message: err.message });
      return;
    }
    pushToast({ type: "error", message: t("common.error") });
  }

  async function buySubscription(sub: PlanDto) {
    if (buyingId) return;
    const period = getSelectedPeriod(sub);
    setBuyingId(sub.id);
    try {
      const { paymentUrl } = await createSubscriptionOrder(sub.id, period);
      // Редирект на hosted checkout. После оплаты Metabox возвращает на
      // /payment/success или /payment/pending — оттуда поллинг.
      window.location.href = paymentUrl;
    } catch (err) {
      setBuyingId(null);
      handleBuyError(err);
    }
  }

  async function buyTokens(pkg: TokenPackDto) {
    if (buyingId) return;
    setBuyingId(pkg.id);
    try {
      const { paymentUrl } = await createTokensOrder(pkg.id);
      window.location.href = paymentUrl;
    } catch (err) {
      setBuyingId(null);
      handleBuyError(err);
    }
  }

  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1 className="h1">{t("plans.title")}</h1>
          <p className="sub">{t("plans.subtitle")}</p>
        </div>
      </div>

      {loading && (
        <div className="muted" style={{ padding: "24px 0", display: "flex", gap: 8 }}>
          <Loader2 size={16} className="spin" />
          <span>{t("app.loading")}</span>
        </div>
      )}

      {!loading && error && (
        <div className="card" style={{ padding: 16 }}>
          <span className="muted">{error}</span>
        </div>
      )}

      {!loading && !error && catalog && (
        <>
          {catalog.subscriptions.length > 0 && (
            <SubscriptionsSection
              subs={catalog.subscriptions}
              getPeriodsFor={getPeriodsFor}
              getSelectedPeriod={getSelectedPeriod}
              setSubPeriod={(id, p) => setSubPeriods((prev) => ({ ...prev, [id]: p }))}
              onBuy={buySubscription}
              buyingId={buyingId}
            />
          )}

          {catalog.tokenPackages.length > 0 && (
            <TokenPacksSection
              packs={catalog.tokenPackages}
              onBuy={buyTokens}
              buyingId={buyingId}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── Subscriptions ───────────────────────────────────────────────────────────

function SubscriptionsSection({
  subs,
  getPeriodsFor,
  getSelectedPeriod,
  setSubPeriod,
  onBuy,
  buyingId,
}: {
  subs: PlanDto[];
  getPeriodsFor: (sub: PlanDto) => Period[];
  getSelectedPeriod: (sub: PlanDto) => Period;
  setSubPeriod: (id: string, p: Period) => void;
  onBuy: (sub: PlanDto) => void;
  buyingId: string | null;
}) {
  const { t } = useTranslation();
  return (
    <section style={{ marginTop: 16 }}>
      <h3 className="section-title" style={{ marginBottom: 12 }}>
        {t("plans.subscriptions")}
      </h3>
      <div className="plans rise d1">
        {subs.map((sub) => (
          <SubscriptionCard
            key={sub.id}
            sub={sub}
            periods={getPeriodsFor(sub)}
            current={getSelectedPeriod(sub)}
            onChangePeriod={(p) => setSubPeriod(sub.id, p)}
            onBuy={() => onBuy(sub)}
            busy={buyingId === sub.id}
            anyBusy={buyingId !== null}
          />
        ))}
      </div>
    </section>
  );
}

function SubscriptionCard({
  sub,
  periods,
  current,
  onChangePeriod,
  onBuy,
  busy,
  anyBusy,
}: {
  sub: PlanDto;
  periods: Period[];
  current: Period;
  onChangePeriod: (p: Period) => void;
  onBuy: () => void;
  busy: boolean;
  anyBusy: boolean;
}) {
  const { t } = useTranslation();
  const periodPrice = sub.periods[current];
  const months = PERIOD_MONTHS[current];
  // Базовая (без скидки) — M1 × months. Если выбран M1, базовая = текущая.
  const m1Price = Number(sub.periods.M1?.priceRub ?? 0);
  const actualPrice = Number(periodPrice?.priceRub ?? 0);
  const basePrice = m1Price * months;
  const hasDiscount = current !== "M1" && basePrice > actualPrice;
  const savePct = hasDiscount ? Math.round(((basePrice - actualPrice) / basePrice) * 100) : 0;

  return (
    <div className="plan">
      <div className="plan-name">{sub.name}</div>
      <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>
        ⚡ {sub.tokens.toLocaleString("ru-RU")} {t("plans.tokensPerMonth")}
      </div>

      {periods.length > 1 && (
        <div className="plan-periods">
          {periods.map((p) => {
            const pdPrice = Number(sub.periods[p]?.priceRub ?? 0);
            const pdPctOff =
              m1Price > 0 && p !== "M1"
                ? Math.round((1 - pdPrice / (m1Price * PERIOD_MONTHS[p])) * 100)
                : 0;
            return (
              <button
                key={p}
                type="button"
                className={clsx("plan-period", p === current && "on")}
                onClick={() => onChangePeriod(p)}
              >
                <span>{t(`plans.period.${p}`)}</span>
                {pdPctOff > 0 && <span className="plan-period-off">−{pdPctOff}%</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className="price">
        <span className="amount">{actualPrice.toLocaleString("ru-RU")}</span>
        <span className="per">₽ / {t(`plans.period.${current}`)}</span>
      </div>
      {hasDiscount && (
        <div className="plan-old-price">
          <s>{basePrice.toLocaleString("ru-RU")} ₽</s>
          <span className="plan-save"> −{savePct}%</span>
        </div>
      )}

      <button
        className="btn btn-primary"
        style={{ width: "100%", marginTop: "auto" }}
        onClick={onBuy}
        disabled={busy || anyBusy}
      >
        {busy ? (
          <>
            <Loader2 size={14} className="spin" /> {t("plans.processing")}
          </>
        ) : (
          t("plans.buy")
        )}
      </button>
    </div>
  );
}

// ── Token packages ──────────────────────────────────────────────────────────

function TokenPacksSection({
  packs,
  onBuy,
  buyingId,
}: {
  packs: TokenPackDto[];
  onBuy: (pkg: TokenPackDto) => void;
  buyingId: string | null;
}) {
  const { t } = useTranslation();
  return (
    <section style={{ marginTop: 32 }}>
      <h3 className="section-title" style={{ marginBottom: 12 }}>
        {t("plans.tokenPackages")}
      </h3>
      <div className="plans rise d1">
        {packs.map((pkg) => (
          <TokenPackCard
            key={pkg.id}
            pack={pkg}
            onBuy={() => onBuy(pkg)}
            busy={buyingId === pkg.id}
            anyBusy={buyingId !== null}
          />
        ))}
      </div>
    </section>
  );
}

function TokenPackCard({
  pack,
  onBuy,
  busy,
  anyBusy,
}: {
  pack: TokenPackDto;
  onBuy: () => void;
  busy: boolean;
  anyBusy: boolean;
}) {
  const { t } = useTranslation();
  const badgeLabel = useMemo(() => {
    if (!pack.badge) return null;
    if (pack.badge === "top") return t("plans.badgeTop");
    if (pack.badge === "profitable" || pack.badge === "best_value")
      return t("plans.badgeProfitable");
    return pack.badge;
  }, [pack.badge, t]);

  return (
    <div className={clsx("plan", pack.badge && "featured")}>
      {badgeLabel && <span className="ribbon">{badgeLabel}</span>}
      <div className="plan-name">{pack.name}</div>
      <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>
        ⚡ {pack.tokens.toLocaleString("ru-RU")} {t("plans.tokensTotal")}
      </div>

      <div className="price">
        <span className="amount">{Number(pack.priceRub).toLocaleString("ru-RU")}</span>
        <span className="per">₽</span>
      </div>

      <button
        className={pack.badge ? "btn btn-primary" : "btn btn-secondary"}
        style={{ width: "100%", marginTop: "auto" }}
        onClick={onBuy}
        disabled={busy || anyBusy}
      >
        {busy ? (
          <>
            <Loader2 size={14} className="spin" /> {t("plans.processing")}
          </>
        ) : (
          t("plans.buy")
        )}
      </button>
    </div>
  );
}
