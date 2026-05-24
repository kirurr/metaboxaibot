import { useEffect, useState } from "react";
import clsx from "clsx";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { markdownComponents } from "./MarkdownElements";

/**
 * Сворачиваемый блок с размышлениями модели (chain-of-thought).
 *
 * Раскрыт, пока видимого ответа ещё нет (`hasAnswer === false`) — видно ход
 * мыслей; как только пошёл ответ (`hasAnswer` переключается в `true`) —
 * авто-сворачивается. После этого `hasAnswer` больше не меняется, поэтому
 * ручное раскрытие/сворачивание пользователем сохраняется.
 */
export function ReasoningBlock({
  reasoning,
  hasAnswer,
}: {
  reasoning: string;
  hasAnswer: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!hasAnswer);

  useEffect(() => setOpen(!hasAnswer), [hasAnswer]);

  return (
    <div className="msg-reasoning">
      <button
        type="button"
        className={clsx("msg-reasoning-toggle", open && "open")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={14} className="msg-reasoning-arrow" />
        <span>🧠 {hasAnswer ? t("chat.reasoning") : t("chat.reasoningThinking")}</span>
      </button>
      {open && (
        <div className="msg-reasoning-body">
          <Markdown
            components={markdownComponents}
            rehypePlugins={[rehypeSanitize]}
            remarkPlugins={[remarkGfm]}
          >
            {reasoning}
          </Markdown>
        </div>
      )}
    </div>
  );
}
