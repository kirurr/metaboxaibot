import type { Components } from "react-markdown";

/**
 * Tailwind-styled overrides for `react-markdown` used in chat AI bubbles.
 * Tuned to the existing `.bubble` typography (15px / line-height 1.55) — see
 * `.msg-block` styles in `index.css`.
 */
export const markdownComponents: Components = {
  h1: ({ children }) => <h1 className="text-xl font-semibold mt-3 mb-2 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-lg font-semibold mt-3 mb-2 first:mt-0">{children}</h2>,
  h3: ({ children }) => (
    <h3 className="text-base font-semibold mt-2 mb-1 first:mt-0">{children}</h3>
  ),
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 my-2 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-[color:var(--accent)] underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-white/15 pl-3 my-2 italic opacity-90">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-white/10" />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  pre: ({ children }) => (
    <pre className="my-2 p-3 rounded-lg bg-black/40 overflow-x-auto text-sm">{children}</pre>
  ),
  code: ({ className, children, ...props }) => {
    // react-markdown v10 dropped the `inline` prop. Fenced blocks render as
    // `<pre><code class="language-xxx">...</code></pre>` — detect by language
    // class or embedded newlines and emit plain `<code>` so `<pre>` owns the
    // panel styling. Otherwise apply the inline pill.
    const isBlock = /language-/.test(className ?? "") || /\n/.test(String(children));
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="px-1 py-0.5 rounded bg-white/10 text-[0.9em] font-mono" {...props}>
        {children}
      </code>
    );
  },
};
