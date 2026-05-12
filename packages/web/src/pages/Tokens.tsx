import { useMemo, useState } from "react";
import { ArrowRight, Download, Plus, RefreshCw, Sparkles, Star } from "lucide-react";
import clsx from "clsx";
import { useIsMobile } from "@/hooks/useIsMobile";

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

type Txn = {
  kind: "use" | "topup" | "bonus" | "refund";
  model?: string;
  desc: string;
  amount: number;
  date: string;
  time: string;
  usd?: number;
};

const txns: Txn[] = [
  {
    kind: "use",
    model: "GPT-5",
    desc: "Chat · Restructure launch announcement",
    amount: -2140,
    date: "Today",
    time: "14:02",
  },
  {
    kind: "use",
    model: "Sonnet 4.5",
    desc: "Chat · Q3 OKR review",
    amount: -3812,
    date: "Today",
    time: "11:47",
  },
  {
    kind: "use",
    model: "nano-banana-pro",
    desc: "Image · 4 generations · 1024×1024",
    amount: -10800,
    date: "Today",
    time: "09:18",
  },
  {
    kind: "use",
    model: "Sonnet 4.5",
    desc: "Chat · Cohort retention SQL",
    amount: -5240,
    date: "Yesterday",
    time: "18:21",
  },
  {
    kind: "use",
    model: "heygen",
    desc: "Video · 28s avatar render",
    amount: -7200,
    date: "Yesterday",
    time: "16:04",
  },
  {
    kind: "use",
    model: "Sonnet 4.5",
    desc: "Chat · Translate contract clauses",
    amount: -1940,
    date: "Yesterday",
    time: "10:03",
  },
  {
    kind: "use",
    model: "tts-cartesia",
    desc: "Audio · 1m 12s voiceover",
    amount: -190,
    date: "Yesterday",
    time: "08:42",
  },
  {
    kind: "topup",
    desc: "Top-up · 10M pack",
    amount: 12000000,
    date: "May 1",
    time: "—",
    usd: 79,
  },
  { kind: "bonus", desc: "Welcome bonus", amount: 7500, date: "Apr 29", time: "—" },
  {
    kind: "use",
    model: "GPT-5",
    desc: "Chat · Pricing experiment brainstorm",
    amount: -4410,
    date: "Apr 28",
    time: "16:30",
  },
  {
    kind: "refund",
    model: "Sonnet 4.5",
    desc: "Refund · failed generation",
    amount: 840,
    date: "Apr 27",
    time: "12:11",
  },
];

const FILTERS = [
  { id: "all", label: "All" },
  { id: "use", label: "AI usage" },
  { id: "topup", label: "Top-ups" },
  { id: "bonus", label: "Bonuses" },
  { id: "refund", label: "Refunds" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

function txIcon(kind: Txn["kind"]) {
  if (kind === "use") return <Sparkles size={18} />;
  if (kind === "topup") return <Plus size={18} />;
  if (kind === "bonus") return <Star size={18} />;
  if (kind === "refund") return <RefreshCw size={18} />;
  return <Sparkles size={18} />;
}

function fmtTokens(n: number) {
  const sign = n < 0 ? "−" : "+";
  const abs = Math.abs(n);
  return sign + abs.toLocaleString("en-US");
}

export default function Tokens() {
  const isMobile = useIsMobile();
  const [sel, setSel] = useState(2);
  const [custom, setCustom] = useState("");
  const [filter, setFilter] = useState<FilterId>("all");

  const spark = useMemo(
    () =>
      Array.from(
        { length: 28 },
        (_, i) => 20 + Math.round(60 * Math.abs(Math.sin(i * 0.7) + Math.cos(i * 0.3))),
      ),
    [],
  );
  const max = Math.max(...spark);

  const filtered = filter === "all" ? txns : txns.filter((t) => t.kind === filter);
  const counts = FILTERS.reduce<Record<string, number>>((acc, f) => {
    acc[f.id] = f.id === "all" ? txns.length : txns.filter((t) => t.kind === f.id).length;
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
            1,247,330{" "}
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
          <div className="muted" style={{ marginTop: 6, fontSize: 14 }}>
            ~ 31 days at your current pace. Next refill recommended{" "}
            <span style={{ color: "var(--text)" }}>around June 9</span>.
          </div>
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
              {f.label} <span className="count">{counts[f.id]}</span>
            </button>
          ))}
        </div>

        <div className="tx-list" style={{ marginTop: 12 }}>
          {filtered.map((t, i) => (
            <div key={i} className="tx-row">
              <div className={"tx-ico " + t.kind}>{txIcon(t.kind)}</div>
              <div style={{ minWidth: 0 }}>
                <div className="tx-title">{t.desc}</div>
                <div className="tx-sub">
                  {t.model && <span className="model-tag">{t.model}</span>}
                  <span>
                    {t.date}
                    {t.time && t.time !== "—" ? ` · ${t.time}` : ""}
                  </span>
                  {t.usd != null && <span>· ${t.usd}.00 charged</span>}
                </div>
              </div>
              {!isMobile && <span className="tx-time" />}
              <span className={"tx-amount " + (t.amount < 0 ? "neg" : "pos")}>
                {fmtTokens(t.amount)}
              </span>
            </div>
          ))}
        </div>
        {filtered.length === 0 && (
          <div className="empty-illu" style={{ marginTop: 12 }}>
            No transactions in this filter.
          </div>
        )}
      </div>
    </div>
  );
}
