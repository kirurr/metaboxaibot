/**
 * Парсинг reasoning-блоков `<think>…</think>` из текста AI-сообщения.
 *
 * Бэкенд при включённом тогле `show_reasoning` стримит рассуждения инлайн,
 * оборачивая их в `<think>…</think>` (см. claude-anthropic-proxy.adapter).
 * Anthropic-прокси флашит весь буфер размышлений одним блоком ПЕРЕД видимым
 * текстом, но парсер устойчив и к нескольким блокам, и к незакрытому тегу
 * (стрим ещё идёт — `</think>` не пришёл).
 *
 * NB: работает только для live-стрима. В БД reasoning вырезается
 * (`stripThinkingBlocks` в chat.service), поэтому при загрузке истории
 * `<think>` отсутствует и `splitReasoning` вернёт `reasoning: null`.
 */

export interface SplitReasoning {
  /** Содержимое всех `<think>` блоков, склеенное через `\n\n`. `null`, если их нет. */
  reasoning: string | null;
  /** Видимый ответ без `<think>`-разметки. */
  answer: string;
}

// Закрытые блоки: <think>…</think> (без учёта регистра, точка матчит переносы).
const CLOSED_THINK = /<think>([\s\S]*?)<\/think>/gi;
// Незакрытый хвост: <think> без последующего </think> до конца строки.
const OPEN_THINK = /<think>([\s\S]*)$/i;

export function splitReasoning(text: string): SplitReasoning {
  if (!text.includes("<think>")) {
    return { reasoning: null, answer: text };
  }

  const parts: string[] = [];

  // Закрытые блоки вырезаем из ответа, содержимое копим.
  let answer = text.replace(CLOSED_THINK, (_m, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed) parts.push(trimmed);
    return "";
  });

  // Незакрытый `<think>` (стрим ещё идёт) — всё после тега это reasoning.
  const open = answer.match(OPEN_THINK);
  if (open) {
    const trimmed = open[1].trim();
    if (trimmed) parts.push(trimmed);
    answer = answer.slice(0, open.index);
  }

  return {
    reasoning: parts.length > 0 ? parts.join("\n\n") : null,
    answer: answer.trim(),
  };
}
