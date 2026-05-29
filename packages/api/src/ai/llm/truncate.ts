import { logger } from "../../logger.js";
import { estimateMessageTokens, estimateTokens } from "../../services/token-estimator.js";
import type { LLMInput, MessageRecord } from "./base.adapter.js";

/** Fraction of the physical context window we allow ourselves to fill. */
const SAFETY_MARGIN = 0.85;

/**
 * Thrown when even the minimum required payload (system prompt + current
 * user turn + reserved output budget) does not fit into the model's
 * context window. The chat service catches this and shows a localised
 * message — the user is advised to shorten attachments or pick a model
 * with a larger window.
 */
export class ContextOverflowError extends Error {
  constructor(
    public readonly contextWindow: number,
    public readonly required: number,
  ) {
    super(`Required ${required} tokens exceeds context window ${contextWindow}`);
    this.name = "ContextOverflowError";
  }
}

function reservedOutput(input: LLMInput, contextWindow: number): number {
  // Adapter-level reservation hint (Anthropic — поле max_tokens обязательное,
  // адаптер знает что отправит N токенов). Имеет приоритет: если адаптер
  // явно сказал «зарезервируй N», truncate отдаёт ровно N — это синхронизирует
  // history-trimming с тем что реально пойдёт в API и предотвращает
  // `input_tokens + max_tokens > context_window`.
  if (input.adapterOutputReservation && input.adapterOutputReservation > 0) {
    return input.adapterOutputReservation;
  }
  // Резерв под output применяется только когда юзер ЯВНО включил тогл
  // «Ограничить длину ответа». Иначе резервируем дефолтные 10% окна (не
  // больше 4096) — иначе на default=max выходные у длинных диалогов
  // история отрезалась бы агрессивно ещё до отправки.
  if (input.maxTokensLimitEnabled === true && input.maxTokens && input.maxTokens > 0) {
    return input.maxTokens;
  }
  return Math.min(4096, Math.floor(contextWindow * 0.1));
}

function attachmentTokens(m: MessageRecord): number {
  // History attachments (PDFs/images) are re-sent every turn. We don't have
  // their tokenised cost without re-fetching, so reserve a coarse estimate:
  // 2K tokens per attachment. This keeps the estimator pessimistic and the
  // truncation safe.
  return (m.attachments?.length ?? 0) * 2000;
}

function messageCost(m: MessageRecord): number {
  return estimateMessageTokens(m.content) + attachmentTokens(m);
}

/**
 * Default token-aware history truncation used by every db_history adapter.
 *
 * Algorithm:
 * 1. Compute floor = system + current user + reserved output. If this exceeds
 *    `contextWindow * SAFETY_MARGIN`, throw ContextOverflowError — even the
 *    bare minimum doesn't fit.
 * 2. Walk history newest → oldest in (user, assistant) pairs, prepending each
 *    pair while it still fits the remaining budget.
 * 3. Guarantee the first kept message is `user` (Anthropic constraint) by
 *    shifting any leading assistant.
 *
 * The system prompt is always kept; the current user turn is always kept.
 * Only the historical conversation can be trimmed.
 */
export function truncateInputDefault(input: LLMInput, contextWindow: number): LLMInput {
  const reserved = reservedOutput(input, contextWindow);
  const budget = Math.max(0, Math.floor(contextWindow * SAFETY_MARGIN) - reserved);

  const systemTokens = input.systemPrompt ? estimateTokens(input.systemPrompt) : 0;
  const currentTokens = estimateTokens(input.prompt);
  const currentDocTokens = (input.documentAttachments?.length ?? 0) * 2000;
  const floor = systemTokens + currentTokens + currentDocTokens + 4;

  if (floor > budget) {
    throw new ContextOverflowError(contextWindow, floor + reserved);
  }

  if (!input.history?.length) return input;

  let remaining = budget - floor;
  const h = input.history;
  const kept: MessageRecord[] = [];
  let i = h.length - 1;

  while (i >= 0) {
    const isPair = i >= 1 && h[i].role === "assistant" && h[i - 1].role === "user";
    const items = isPair ? [h[i - 1], h[i]] : [h[i]];
    const cost = items.reduce((s, m) => s + messageCost(m), 0);
    if (cost > remaining) break;
    remaining -= cost;
    kept.unshift(...items);
    i -= items.length;
  }

  while (kept.length > 0 && kept[0].role !== "user") kept.shift();

  if (kept.length === h.length) return input;

  logger.debug(
    { dropped: h.length - kept.length, kept: kept.length, contextWindow },
    "truncateInputDefault: history truncated",
  );
  return { ...input, history: kept };
}

/**
 * Heuristic detection of provider-side context-overflow errors. Returns true
 * for our own ContextOverflowError as well as the canonical strings each
 * provider uses (`context_length_exceeded`, `prompt is too long`, etc).
 */
export function isContextOverflowError(err: unknown): boolean {
  if (err instanceof ContextOverflowError) return true;
  if (!err) return false;
  const msg =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : ((err as { message?: string })?.message ?? "");
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return (
    lower.includes("context_length_exceeded") ||
    lower.includes("context length") ||
    lower.includes("prompt is too long") ||
    lower.includes("maximum context length") ||
    lower.includes("too many tokens") ||
    lower.includes("request payload size exceeds") ||
    // OpenAI Responses API: "Your input exceeds the context window of this model."
    lower.includes("exceeds the context window")
  );
}
