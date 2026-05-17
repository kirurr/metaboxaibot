import { CheckCircle2, Crown, Download, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useIsMobile } from "@/hooks/useIsMobile";

const invoices = [
  { date: "May 1, 2026", desc: "Pro plan — monthly", amount: "$19.00", status: "paid" },
  { date: "Apr 12, 2026", desc: "Token top-up · 10M", amount: "$79.00", status: "paid" },
  { date: "Apr 1, 2026", desc: "Pro plan — monthly", amount: "$19.00", status: "paid" },
  { date: "Mar 22, 2026", desc: "Token top-up · 2M", amount: "$18.00", status: "paid" },
  { date: "Mar 1, 2026", desc: "Pro plan — monthly", amount: "$19.00", status: "paid" },
];

export default function Billing() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();

  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1 className="h1">{t("billing.title")}</h1>
          <p className="sub">{t("billing.subtitle")}</p>
        </div>
        <div className="actions">
          <button className="btn btn-secondary">
            <Download size={16} /> {t("billing.exportInvoices")}
          </button>
        </div>
      </div>

      <div className="stat-grid rise d1">
        <div className="stat">
          <div className="lbl">{t("billing.stat.currentPlan")}</div>
          <div className="val">Pro</div>
          <div className="delta">{t("billing.stat.renewsOn", { date: "Jun 1" })}</div>
        </div>
        <div className="stat">
          <div className="lbl">{t("billing.stat.monthlySpend")}</div>
          <div className="val mono">$19.00</div>
          <div className="delta">{t("billing.stat.sameAsLast")}</div>
        </div>
        <div className="stat">
          <div className="lbl">{t("billing.stat.tokenSpend")} · May</div>
          <div className="val mono">$79.00</div>
          <div className="delta neg">{t("billing.stat.vsLastMonth", { percent: 18 })}</div>
        </div>
        <div className="stat">
          <div className="lbl">{t("billing.stat.nextCharge")}</div>
          <div className="val mono">$19.00</div>
          <div className="delta">Jun 1, 2026</div>
        </div>
      </div>

      <div className="two-col rise d2">
        <div className="card" style={{ padding: 22 }}>
          <div className="row between" style={{ marginBottom: 14 }}>
            <h3 className="section-title" style={{ margin: 0 }}>
              {t("billing.subscription")}
            </h3>
            <button className="btn btn-ghost btn-sm">{t("billing.changePlan")}</button>
          </div>
          <div className="row" style={{ gap: 18, padding: "14px 0" }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                background: "var(--accent-gradient)",
                display: "grid",
                placeItems: "center",
                boxShadow: "var(--shadow-accent)",
              }}
            >
              <Crown size={22} color="#fff" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{t("billing.planInfo", { plan: "Pro" })}</div>
              <div className="muted" style={{ fontSize: 13.5 }}>
                {t("billing.planFeatures", { tokens: "2M" })}
              </div>
            </div>
            <span className="chip success">
              <CheckCircle2 size={12} /> {t("billing.active")}
            </span>
          </div>
          <div className="divider" />
          <div className="field-row">
            <span className="lbl">{t("billing.started")}</span>
            <span className="val">Jan 14, 2026</span>
            <span />
          </div>
          <div className="field-row">
            <span className="lbl">{t("billing.nextRenewal")}</span>
            <span className="val">Jun 1, 2026 · $19.00</span>
            <button className="btn btn-ghost btn-sm">{t("billing.cancel")}</button>
          </div>
        </div>

        <div className="card" style={{ padding: 22 }}>
          <div className="row between" style={{ marginBottom: 14 }}>
            <h3 className="section-title" style={{ margin: 0 }}>
              {t("billing.paymentMethods")}
            </h3>
            <button className="btn btn-ghost btn-sm">
              <Plus size={14} /> {t("billing.addPm")}
            </button>
          </div>
          <div className="row" style={{ padding: "12px 0", gap: 14 }}>
            <div
              style={{
                width: 40,
                height: 28,
                borderRadius: 6,
                background: "linear-gradient(135deg, #1a2540, #4a8df5)",
                display: "grid",
                placeItems: "center",
                fontSize: 9,
                fontWeight: 700,
                color: "#fff",
                letterSpacing: 1,
              }}
            >
              VISA
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>•••• •••• •••• 4242</div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {t("billing.expires", { date: "09/28" })}
              </div>
            </div>
            <span className="chip">{t("billing.defaultCard")}</span>
          </div>
          <div className="divider" />
          <div className="row" style={{ padding: "12px 0", gap: 14 }}>
            <div
              style={{
                width: 40,
                height: 28,
                borderRadius: 6,
                background: "#1d1d23",
                border: "1px solid var(--border-strong)",
                display: "grid",
                placeItems: "center",
                fontSize: 9,
                fontWeight: 700,
                color: "var(--text-secondary)",
              }}
            >
              MC
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>•••• •••• •••• 5588</div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {t("billing.expires", { date: "03/27" })}
              </div>
            </div>
            <button className="btn btn-ghost btn-sm">{t("billing.setDefault")}</button>
          </div>
        </div>
      </div>

      <h3 className="section-title rise d3" style={{ marginTop: 12 }}>
        {t("billing.invoices")}
      </h3>
      <div className="col rise d3" style={{ gap: 10 }}>
        {invoices.map((inv, i) => (
          <div key={i} className="invoice-row">
            {!isMobile && <span className="date mono">{inv.date}</span>}
            <div>
              <div className="desc">{inv.desc}</div>
              {isMobile && (
                <div className="muted mono" style={{ fontSize: 12, marginTop: 2 }}>
                  {inv.date}
                </div>
              )}
            </div>
            {!isMobile && (
              <span className="chip success" style={{ justifySelf: "start" }}>
                <CheckCircle2 size={12} /> {t("billing.paid")}
              </span>
            )}
            <span className="amount mono">{inv.amount}</span>
            {!isMobile && (
              <button className="btn btn-ghost btn-icon">
                <Download size={16} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
