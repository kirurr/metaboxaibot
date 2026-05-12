import { CheckCircle2, Crown, Download, Plus } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";

const invoices = [
  { date: "May 1, 2026", desc: "Pro plan — monthly", amount: "$19.00", status: "Paid" },
  { date: "Apr 12, 2026", desc: "Token top-up · 10M", amount: "$79.00", status: "Paid" },
  { date: "Apr 1, 2026", desc: "Pro plan — monthly", amount: "$19.00", status: "Paid" },
  { date: "Mar 22, 2026", desc: "Token top-up · 2M", amount: "$18.00", status: "Paid" },
  { date: "Mar 1, 2026", desc: "Pro plan — monthly", amount: "$19.00", status: "Paid" },
];

export default function Billing() {
  const isMobile = useIsMobile();

  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1 className="h1">Billing</h1>
          <p className="sub">
            Subscription, payment methods, and every invoice ever issued. Download any of them as
            PDF.
          </p>
        </div>
        <div className="actions">
          <button className="btn btn-secondary">
            <Download size={16} /> Export invoices
          </button>
        </div>
      </div>

      <div className="stat-grid rise d1">
        <div className="stat">
          <div className="lbl">Current plan</div>
          <div className="val">Pro</div>
          <div className="delta">Renews Jun 1</div>
        </div>
        <div className="stat">
          <div className="lbl">Monthly spend</div>
          <div className="val mono">$19.00</div>
          <div className="delta">Same as last month</div>
        </div>
        <div className="stat">
          <div className="lbl">Token spend · May</div>
          <div className="val mono">$79.00</div>
          <div className="delta neg">▲ 18% vs Apr</div>
        </div>
        <div className="stat">
          <div className="lbl">Next charge</div>
          <div className="val mono">$19.00</div>
          <div className="delta">Jun 1, 2026</div>
        </div>
      </div>

      <div className="two-col rise d2">
        <div className="card" style={{ padding: 22 }}>
          <div className="row between" style={{ marginBottom: 14 }}>
            <h3 className="section-title" style={{ margin: 0 }}>
              Subscription
            </h3>
            <button className="btn btn-ghost btn-sm">Change plan</button>
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
              <div style={{ fontWeight: 600 }}>Pro · monthly</div>
              <div className="muted" style={{ fontSize: 13.5 }}>
                2M tokens included · priority queue · all frontier models
              </div>
            </div>
            <span className="chip success">
              <CheckCircle2 size={12} /> Active
            </span>
          </div>
          <div className="divider" />
          <div className="field-row">
            <span className="lbl">Started</span>
            <span className="val">Jan 14, 2026</span>
            <span />
          </div>
          <div className="field-row">
            <span className="lbl">Next renewal</span>
            <span className="val">Jun 1, 2026 · $19.00</span>
            <button className="btn btn-ghost btn-sm">Cancel</button>
          </div>
        </div>

        <div className="card" style={{ padding: 22 }}>
          <div className="row between" style={{ marginBottom: 14 }}>
            <h3 className="section-title" style={{ margin: 0 }}>
              Payment methods
            </h3>
            <button className="btn btn-ghost btn-sm">
              <Plus size={14} /> Add
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
                Expires 09/28
              </div>
            </div>
            <span className="chip">Default</span>
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
                Expires 03/27
              </div>
            </div>
            <button className="btn btn-ghost btn-sm">Set default</button>
          </div>
        </div>
      </div>

      <h3 className="section-title rise d3" style={{ marginTop: 12 }}>
        Invoices
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
                <CheckCircle2 size={12} /> {inv.status}
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
