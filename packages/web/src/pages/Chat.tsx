import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  ChevronDown,
  Copy,
  Download,
  Mic,
  MoreHorizontal,
  Paperclip,
  RefreshCw,
  Sparkles,
  ArrowUp,
} from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";

type Msg = { role: "user" | "ai"; text: string; meta?: string };

/**
 * Активная сессия диалога. Hub-экран живёт на `/` (Home).
 * Поддерживает `prefill` из `location.state` — например, Home передаёт сюда
 * текст из стартового чипа.
 */
export default function Chat() {
  const isMobile = useIsMobile();
  const location = useLocation();
  const prefill = (location.state as { prefill?: string } | null)?.prefill ?? "";

  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState(prefill);
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
            {messages.length === 0
              ? "Start a new conversation"
              : `Conversation started 14:02 · ${messages.length} messages`}
          </div>
          <div className="row" style={{ marginLeft: "auto", gap: 6 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setMessages([])}>
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
          <div className="chat-empty rise" style={{ padding: "48px 0", textAlign: "center" }}>
            <Sparkles size={28} style={{ marginBottom: 12, color: "var(--accent)" }} />
            <h2 className="h2" style={{ marginBottom: 8 }}>
              Ready when you are.
            </h2>
            <p className="sub">Type a message below to start the conversation.</p>
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
    </div>
  );
}
