import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Copy, File as FileIcon, MoreHorizontal, Sparkles } from "lucide-react";
import type { MessageAttachmentDto } from "@/api/dialogs";
import { markdownComponents } from "./MarkdownElements";
import { formatBytes } from "./chatHelpers";
import type { Msg } from "./chatTypes";

export const ChatThread = memo(function ChatThread({
  messages,
  messagesLoading,
}: {
  messages: Msg[];
  messagesLoading: boolean;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll к низу при росте треда.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  return (
    <div className="chat-scroll" ref={scrollRef}>
      <div className="chat-thread">
        {messages.map((m, i) => {
          if (m.role === "ai")
            return <AiChatMessage key={`${i}.${m.localId}.ai`} message={m} />;
          return <UserChatMessage key={`${i}.${m.localId}.user`} message={m} />;
        })}

        {messagesLoading && (
          <div className="msg ai">
            <div className="ai-mark">
              <Sparkles size={16} />
            </div>
            <div className="bubble">
              <span className="msg-typing">{t("common.loading")}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

function AiChatMessage({ message }: { message: Msg }) {
  return (
    <div className="msg ai rise">
      <div className="msg-block">
        {message.attachments && message.attachments.length > 0 && (
          <div className="msg-attachments">
            {message.attachments.map((a, ai) => (
              <AttachmentChip key={a.s3Key + ai} attachment={a} />
            ))}
          </div>
        )}

        {message.text.length === 0 && <div className="msg-typing">...</div>}

        <Markdown
          components={markdownComponents}
          rehypePlugins={[rehypeSanitize]}
          remarkPlugins={[remarkGfm]}
        >
          {message.text}
        </Markdown>

        {message.meta && (
          <div className="msg-meta">
            <span>{message.meta}</span>
            <div className="msg-actions">
              <button title="Copy" onClick={() => navigator.clipboard?.writeText(message.text)}>
                <Copy size={14} />
              </button>
              <button title="More">
                <MoreHorizontal size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function UserChatMessage({ message }: { message: Msg }) {
  return (
    <div className="msg user rise">
      <div className="msg-block">
        {message.attachments && message.attachments.length > 0 && (
          <div className="msg-attachments">
            {message.attachments.map((a, ai) => (
              <AttachmentChip key={a.s3Key + ai} attachment={a} />
            ))}
          </div>
        )}
        <div className="bubble">
          {message.text.split("\n\n").map((p, k) => (
            <p key={k} style={{ margin: k === 0 ? 0 : "10px 0 0" }}>
              {p}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Chip уже-сохранённого вложения внутри bubble треда. */
function AttachmentChip({ attachment }: { attachment: MessageAttachmentDto }) {
  const { t } = useTranslation();
  const isImage = attachment.kind === "image" && !!attachment.url;
  if (isImage) {
    // Картинку показываем превью с возможностью открыть полноразмер.
    return (
      <a
        href={attachment.url ?? "#"}
        target="_blank"
        rel="noreferrer"
        className="att-chip att-chip-image"
        title={attachment.name}
      >
        <img src={attachment.url ?? undefined} alt={attachment.name} />
      </a>
    );
  }
  const inner = (
    <>
      <div className="att-chip-icon">
        <FileIcon size={14} />
      </div>
      <div className="att-chip-body">
        <div className="att-chip-name" title={attachment.name}>
          {attachment.name}
        </div>
        <div className="att-chip-meta">{formatBytes(attachment.size, t)}</div>
      </div>
    </>
  );
  return attachment.url ? (
    <a
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      className="att-chip att-chip-link"
      title={attachment.name}
    >
      {inner}
    </a>
  ) : (
    <div className="att-chip">{inner}</div>
  );
}

