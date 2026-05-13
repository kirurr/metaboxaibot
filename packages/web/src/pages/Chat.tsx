import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  BookOpen,
  ChevronDown,
  Code2,
  Copy,
  Download,
  Image as ImageIcon,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Paperclip,
  Play,
  RefreshCw,
  Sparkles,
  User as UserIcon,
  AudioWaveform,
} from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";

type Msg = { role: "user" | "ai"; text: string; meta?: string };

const HOME_TOOLS = [
  {
    id: "chat",
    name: "Chat",
    desc: "Reasoning, writing, code. The everyday model.",
    tag: "Sonnet 4.5",
    icon: <MessageSquare size={22} />,
  },
  {
    id: "image",
    name: "Image",
    desc: "Photoreal, illustration, product shots.",
    tag: "nano-banana-pro",
    icon: <ImageIcon size={22} />,
  },
  {
    id: "video",
    name: "Video",
    desc: "Cinematic shots, motion, avatars.",
    tag: "heygen · runway",
    icon: <Play size={22} />,
  },
  {
    id: "voice",
    name: "Voice",
    desc: "Text-to-speech, dubbing, narration.",
    tag: "cartesia",
    icon: <AudioWaveform size={22} />,
  },
  {
    id: "avatar",
    name: "Avatar",
    desc: "Train a likeness once, generate forever.",
    tag: "flux-lora",
    icon: <UserIcon size={22} />,
  },
  {
    id: "code",
    name: "Code",
    desc: "Refactor, debug, scaffold whole files.",
    tag: "GPT-5",
    icon: <Code2 size={22} />,
  },
];

type Gen = {
  span: "gc-3" | "gc-4" | "gc-5" | "gc-6" | "gc-7" | "gc-8";
  media: "media-sq" | "media-port" | "media-land" | "media-wide";
  kind: string;
  model: string;
  prompt: string;
  credits: string;
};

const FEATURED_GENS: Gen[] = [
  {
    span: "gc-5",
    media: "media-land",
    kind: "Video",
    model: "heygen",
    prompt: "Founder explainer · 28s · clean studio lighting · soft B-roll cuts to product UI",
    credits: "5.4k tok",
  },
  {
    span: "gc-4",
    media: "media-port",
    kind: "Image",
    model: "nano-banana-pro",
    prompt: "Editorial portrait, hard light, 85mm, kodak portra grain",
    credits: "1.2k tok",
  },
  {
    span: "gc-3",
    media: "media-sq",
    kind: "Image",
    model: "flux-pro",
    prompt: "Hero shot for a minimalist espresso machine on travertine",
    credits: "0.9k tok",
  },
  {
    span: "gc-4",
    media: "media-sq",
    kind: "Audio",
    model: "cartesia",
    prompt: "British male narrator, warm, neutral pace · 1m 12s",
    credits: "0.2k tok",
  },
  {
    span: "gc-4",
    media: "media-land",
    kind: "Chat",
    model: "Sonnet 4.5",
    prompt: "Restructure my Series A pitch to lead with the wedge, not the vision",
    credits: "2.1k tok",
  },
  {
    span: "gc-4",
    media: "media-port",
    kind: "Video",
    model: "runway",
    prompt: "Cinematic dolly-in on a city skyline at golden hour, anamorphic flare",
    credits: "8.0k tok",
  },
  {
    span: "gc-6",
    media: "media-wide",
    kind: "Image",
    model: "nano-banana-pro",
    prompt: "Brutalist concrete interior, soft north light, single figure walking, 4:3 ratio",
    credits: "1.4k tok",
  },
  {
    span: "gc-6",
    media: "media-wide",
    kind: "Image",
    model: "flux-pro",
    prompt: "Product comp for matte-black headphones on raw linen with single specular highlight",
    credits: "1.1k tok",
  },
];

const RECENT_GENS = [
  {
    title: "Q3 board narrative",
    model: "Sonnet 4.5",
    time: "2h ago",
    ico: <MessageSquare size={18} />,
  },
  {
    title: "Espresso machine hero shot",
    model: "nano-banana-pro",
    time: "Yesterday",
    ico: <ImageIcon size={18} />,
  },
  { title: "Founder explainer · 28s", model: "heygen", time: "Yesterday", ico: <Play size={18} /> },
  {
    title: "Onboarding voiceover",
    model: "cartesia",
    time: "Mon",
    ico: <AudioWaveform size={18} />,
  },
  { title: "Cohort retention SQL", model: "GPT-5", time: "Mon", ico: <Code2 size={18} /> },
];

const STARTER_PROMPTS = [
  { t: "Restructure my pitch", i: <BookOpen size={14} /> },
  { t: "Logo concepts for a brand", i: <ImageIcon size={14} /> },
  { t: "Cinematic product shot", i: <Sparkles size={14} /> },
  { t: "Voiceover from this text", i: <AudioWaveform size={14} /> },
  { t: "Explain this code", i: <Code2 size={14} /> },
];

export default function Chat() {
  const isMobile = useIsMobile();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  function autosize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  function send() {
    const t = draft.trim();
    if (!t) return;
    setMessages((m) => [...m, { role: "user", text: t }]);
    setDraft("");
    setTimeout(autosize, 0);
    setTimeout(() => {
      setMessages((m) => [
        ...m,
        {
          role: "ai",
          text: "Thinking through this — here are the three angles I'd consider. Each has a different cost in tokens but a meaningfully different output. Tap the one that fits.",
          meta: "Claude Sonnet · 184 tokens · 1.4s",
        },
      ]);
    }, 720);
  }

  return (
    <div className="page chat-wrap" style={{ paddingTop: isMobile ? 16 : 24, paddingBottom: 0 }}>
      {!isMobile && (
        <div className="topbar">
          <div className="model-picker">
            <span className="dot" /> Claude Sonnet 4.5 <ChevronDown size={14} />
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            Conversation started 14:02 · 8 messages
          </div>
          <div className="row" style={{ marginLeft: "auto", gap: 6 }}>
            <button className="btn btn-ghost btn-sm">
              <RefreshCw size={15} /> New chat
            </button>
            <button className="btn btn-ghost btn-sm">
              <Download size={15} /> Export
            </button>
          </div>
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="home">
            <section className="home-hero rise">
              <span className="eyebrow">
                <span className="live-dot" /> Good evening, Alex
              </span>
              <h1 className="home-h1">
                Create <em>anything.</em>
              </h1>
              <p className="sub">
                Chat, image, video, voice — every model in one place. Pick a tool below, or just
                start typing.
              </p>
              <div className="home-prompt">
                <input
                  placeholder="Describe what you want to make…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && draft.trim()) send();
                  }}
                />
                <button className="pill-model" title="Switch model">
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 99,
                      background: "var(--accent)",
                      display: "inline-block",
                    }}
                  />{" "}
                  Sonnet 4.5 <ChevronDown size={12} />
                </button>
                <button className="send-btn" disabled={!draft.trim()} onClick={send} title="Send">
                  <ArrowUp size={18} />
                </button>
              </div>
              <div className="starter-chips">
                {STARTER_PROMPTS.map((s, i) => (
                  <button key={i} className="starter-chip" onClick={() => setDraft(s.t)}>
                    {s.i} {s.t}
                  </button>
                ))}
              </div>
            </section>

            <section className="rise d1">
              <div className="home-sec-head">
                <div>
                  <h2>Jump into a tool.</h2>
                  <p>Each one is one click away. We&apos;ll pre-load the best model for the job.</p>
                </div>
              </div>
              <div className="tools-grid">
                {HOME_TOOLS.map((t) => (
                  <button key={t.id} className="tool-tile" onClick={() => setDraft("")}>
                    <span className="ti-glow" />
                    <div className="ti-ico">{t.icon}</div>
                    <div className="ti-name">{t.name}</div>
                    <div className="ti-desc">{t.desc}</div>
                    <div className="ti-foot">
                      <span className="mono" style={{ fontSize: 11 }}>
                        {t.tag}
                      </span>
                      <span className="arr">
                        Open <ArrowRight size={13} />
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </section>

            <section className="rise d2">
              <div className="home-sec-head">
                <div>
                  <h2>Featured today.</h2>
                  <p>Curated generations from the community. Tap any card to reuse the prompt.</p>
                </div>
                <button className="see-all">
                  Open gallery <ArrowRight size={14} />
                </button>
              </div>
              <div className="gallery-grid">
                {FEATURED_GENS.map((g, i) => (
                  <div key={i} className={"gen-card " + g.span}>
                    <div className={"media " + g.media}>
                      <span className="label">
                        {g.kind.toUpperCase()} · {g.model}
                      </span>
                      <span className="badge-model">{g.model}</span>
                      <span className="badge-kind">{g.kind}</span>
                    </div>
                    <div className="body">
                      <div className="prompt-line">{g.prompt}</div>
                      <div className="meta-row">
                        <span className="mono">{g.credits}</span>
                        <span className="use-cta">
                          Use prompt <ArrowRight size={12} />
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rise d3">
              <div className="home-sec-head">
                <div>
                  <h2>Pick up where you left off.</h2>
                  <p>Your last five sessions, ready to continue.</p>
                </div>
                <button className="see-all">
                  All history <ArrowRight size={14} />
                </button>
              </div>
              <div className="recent-row">
                {RECENT_GENS.map((r, i) => (
                  <button key={i} className="recent-card">
                    <div className="thumb">{r.ico}</div>
                    <div className="rc-body">
                      <div className="rc-title">{r.title}</div>
                      <div className="rc-meta">
                        <span className="rc-model">{r.model}</span>
                        <span className="dot" />
                        <span>{r.time}</span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={"msg " + m.role + " rise"}>
              {m.role === "ai" && (
                <div className="ai-mark">
                  <Sparkles size={16} />
                </div>
              )}
              <div style={{ minWidth: 0, flex: m.role === "user" ? "0 1 auto" : "1 1 auto" }}>
                <div className="bubble">
                  {m.text.split("\n\n").map((p, k) => (
                    <p key={k} style={{ margin: k === 0 ? 0 : "10px 0 0" }}>
                      {p}
                    </p>
                  ))}
                </div>
                {m.role === "ai" && (
                  <div className="msg-meta">
                    <span>{m.meta}</span>
                    <div className="msg-actions">
                      <button title="Copy">
                        <Copy size={14} />
                      </button>
                      <button title="Regenerate">
                        <RefreshCw size={14} />
                      </button>
                      <button title="More">
                        <MoreHorizontal size={14} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {messages.length > 0 && (
        <div className="composer">
          <div className="composer-inner">
            <div className="composer-row">
              <button className="tool" title="Attach">
                <Paperclip size={18} />
              </button>
              <textarea
                ref={taRef}
                placeholder="Ask AI Box anything…"
                value={draft}
                rows={1}
                onInput={autosize}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button className="tool" title="Voice">
                <Mic size={18} />
              </button>
              <button className="send" disabled={!draft.trim()} onClick={send} title="Send">
                <ArrowUp size={18} />
              </button>
            </div>
          </div>
          <div className="composer-meta">
            <span className="hint">Enter to send · Shift + Enter for newline</span>
            <span className="hint">
              ~ <span className="mono">{Math.max(1, Math.round(draft.length / 4))}</span> tokens
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
