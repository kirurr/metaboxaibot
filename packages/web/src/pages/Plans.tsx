import { useState } from "react";
import { ArrowRight, ArrowUpRight, Check, Shield } from "lucide-react";
import clsx from "clsx";

type Plan = {
  name: string;
  price: number;
  per: string;
  blurb: string;
  features: { t: string; bold?: boolean }[];
  cta: string;
  featured?: boolean;
};

const plans: Plan[] = [
  {
    name: "Starter",
    price: 0,
    per: "forever",
    blurb: "For casual use.",
    features: [
      { t: "50,000 tokens / month", bold: true },
      { t: "All open-weight models" },
      { t: "30-day history" },
      { t: "Standard speed queue" },
    ],
    cta: "Current plan",
  },
  {
    name: "Pro",
    price: 19,
    per: "month",
    blurb: "For people who use it daily.",
    features: [
      { t: "2,000,000 tokens / month", bold: true },
      { t: "Claude Sonnet, GPT-5, Gemini Pro" },
      { t: "Priority queue · 3× faster" },
      { t: "Unlimited history & projects" },
      { t: "Image generation included" },
      { t: "Voice input & file uploads" },
    ],
    cta: "Upgrade to Pro",
    featured: true,
  },
  {
    name: "Team",
    price: 49,
    per: "seat / month",
    blurb: "For small teams shipping together.",
    features: [
      { t: "Everything in Pro", bold: true },
      { t: "Shared workspaces & libraries" },
      { t: "Centralised billing & SSO" },
      { t: "Admin console & seat controls" },
      { t: "Soc2 · audit logs · DPA" },
      { t: "Priority human support" },
    ],
    cta: "Talk to sales",
  },
];

export default function Plans() {
  const [yearly, setYearly] = useState(true);

  return (
    <div className="page">
      <div className="page-head rise">
        <div>
          <h1 className="h1">Choose how much intelligence you need.</h1>
          <p className="sub">
            Cancel any time. Token rollover up to 2 months. No surprises on the invoice — what you
            see is what you pay.
          </p>
        </div>
        <div className="actions">
          <div
            className="card"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "8px 14px",
              borderRadius: 999,
            }}
          >
            <span style={{ fontSize: 13, color: yearly ? "var(--text-secondary)" : "var(--text)" }}>
              Monthly
            </span>
            <button className={clsx("toggle", yearly && "on")} onClick={() => setYearly(!yearly)} />
            <span style={{ fontSize: 13, color: yearly ? "var(--text)" : "var(--text-secondary)" }}>
              Yearly
            </span>
            <span className="chip success" style={{ height: 22, fontSize: 11 }}>
              Save 20%
            </span>
          </div>
        </div>
      </div>

      <div className="plans rise d1">
        {plans.map((p, i) => {
          const price = p.price === 0 ? 0 : yearly ? Math.round(p.price * 0.8) : p.price;
          return (
            <div
              key={p.name}
              className={clsx("plan", p.featured && "featured")}
              style={{ animationDelay: `${100 + i * 80}ms` }}
            >
              {p.featured && <span className="ribbon">Most popular</span>}
              <div className="plan-name">{p.name}</div>
              <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>
                {p.blurb}
              </div>
              <div className="price">
                {price === 0 ? (
                  <span className="amount">Free</span>
                ) : (
                  <>
                    <span className="currency">$</span>
                    <span className="amount">{price}</span>
                    <span className="per">/ {p.per}</span>
                  </>
                )}
              </div>
              <ul className="feat-list">
                {p.features.map((f, k) => (
                  <li key={k} className={f.bold ? "bold" : ""}>
                    <span className="ck">
                      <Check size={16} />
                    </span>
                    <span>{f.t}</span>
                  </li>
                ))}
              </ul>
              <button
                className={p.featured ? "btn btn-primary" : "btn btn-secondary"}
                style={{ width: "100%" }}
              >
                {p.cta} {p.featured && <ArrowRight size={16} />}
              </button>
            </div>
          );
        })}
      </div>

      <div
        className="card"
        style={{
          padding: 22,
          marginTop: 12,
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "var(--accent-lighter)",
              color: "var(--accent-light)",
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            <Shield size={18} />
          </div>
          <div>
            <div style={{ fontWeight: 600 }}>Need more, custom, or on-prem?</div>
            <div className="muted" style={{ fontSize: 14, maxWidth: "60ch" }}>
              Enterprise plans include private deployments, custom token pools, dedicated
              infrastructure and a named account manager.
            </div>
          </div>
        </div>
        <button className="btn btn-secondary" style={{ marginLeft: "auto" }}>
          Contact sales <ArrowUpRight size={14} />
        </button>
      </div>
    </div>
  );
}
