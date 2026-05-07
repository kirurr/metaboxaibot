import { AI_MODELS, type ContextStrategy } from "@metabox/shared";
import { truncateInputDefault } from "./truncate.js";

export interface MessageAttachment {
  /** S3 key of the stored file (persisted in DB). */
  s3Key: string;
  mimeType: string;
  name: string;
  size?: number;
  /** Presigned GET URL — populated by the chat service just before the adapter call. */
  url?: string;
  /**
   * OpenAI Files API file_id (`purpose: "user_data"`). Если задан, OpenAI-
   * адаптер передаёт `file_id` вместо `file_url` в input_file блоке —
   * не зависит от TTL presigned URL'ов S3.
   */
  openaiFileId?: string;
  /** OpenAI keyId которым выполнен upload — для sticky-binding (см. StoredAttachment). */
  openaiKeyId?: string | null;
}

export interface MessageRecord {
  /** Optional DB message id — needed so adapters can look up historyAttachments. */
  id?: string;
  role: "user" | "assistant";
  content: string;
  /** Documents attached to this historical message (reattached at every send). */
  attachments?: MessageAttachment[];
}

export interface LLMInput {
  prompt: string;
  imageUrl?: string;
  /** db_history: last N messages from DB */
  history?: MessageRecord[];
  /** One or more image URLs to include in the user turn. */
  imageUrls?: string[];
  /**
   * Documents attached to the current user turn. Each entry holds the s3Key
   * plus mime/name metadata — adapters presign GET URLs just before sending.
   */
  documentAttachments?: MessageAttachment[];
  /** provider_chain: OpenAI Responses API — chains via previous_response_id */
  previousResponseId?: string;
  /** System prompt override */
  systemPrompt?: string;
  /** Sampling temperature (0–2). Provider default when omitted. */
  temperature?: number;
  /** Max output tokens. Provider default when omitted. */
  maxTokens?: number;
  /** Perplexity: restrict search results to a time window (month/week/day/hour). */
  searchRecencyFilter?: string;
  /** Perplexity: depth of web search context (low/medium/high). */
  searchContextSize?: string;
  /** Perplexity: comma-separated domain allowlist (e.g. "wikipedia.org,bbc.com"). */
  searchDomainFilter?: string;
  /** OpenAI o-series / gpt-5: reasoning effort (none/low/medium/high/xhigh). */
  reasoningEffort?: string;
  /** OpenAI gpt-5 family: output verbosity hint (low/medium/high). Passed as text.verbosity. */
  verbosity?: string;
  /** Anthropic: enable extended thinking mode. */
  extendedThinking?: boolean;
  /** Qwen3: enable chain-of-thought thinking (true by default for thinking models). */
  enableThinking?: boolean;
  /** Gemini: internal reasoning token budget (0 = disabled). */
  thinkingBudget?: number;
  /** OpenAI chat models: seed for reproducible outputs. */
  seed?: number;
  /**
   * User-configured override for the model's physical context window
   * (in tokens). Defaults to `AI_MODELS[modelId].contextWindow` when absent.
   * Used by token-aware history truncation.
   */
  contextWindowOverride?: number;
}

export interface LLMOutput {
  text: string;
  tokensUsed: number;
  /** provider_chain: save as Dialog.providerLastResponseId */
  newResponseId?: string;
}

export interface StreamResult {
  newResponseId?: string;
  /** Raw provider input token count (API tokens, not internal credits). */
  inputTokensUsed?: number;
  /**
   * Subset of `inputTokensUsed` that the provider served from its prompt
   * cache (OpenAI: `usage.input_tokens_details.cached_tokens`, Anthropic:
   * `cache_read_input_tokens`, Gemini: cached-context tokens). Billed at
   * `cachedInputCostUsdPerMToken` if the model defines it; otherwise rolled
   * into the regular input bucket.
   */
  cachedInputTokensUsed?: number;
  /** Raw provider output token count (API tokens, not internal credits). */
  outputTokensUsed?: number;
  /**
   * If set, overrides calculateCost() — adapter computed the exact USD cost
   * directly from provider-specific usage fields (e.g. citation/search tokens).
   */
  providerUsdCost?: number;
  /**
   * Set when provider закрыл response как `incomplete` — позволяет вызывающему
   * выбрать осмысленное сообщение пользователю (напр. для reason
   * `max_output_tokens` подсказать понизить effort или увеличить лимит).
   * OpenAI Responses API: `'max_output_tokens' | 'content_filter'`.
   */
  incompleteReason?: string;
}

export interface LLMAdapter {
  readonly contextStrategy: ContextStrategy;
  readonly contextMaxMessages: number;
  chat(input: LLMInput): Promise<LLMOutput>;
  chatStream(input: LLMInput): AsyncGenerator<string, StreamResult | void, unknown>;
}

/** Fallback context window when model has no explicit value. */
const DEFAULT_CONTEXT_WINDOW = 100_000;

/**
 * Abstract base class for LLM adapters with built-in token-aware history
 * truncation. Adapters call `this.truncateInput(input)` at the top of their
 * `chatStream()` to drop oldest history pairs until the request fits the
 * context window. Adapters with provider-side context (OpenAI Responses API
 * `previous_response_id`) override `truncateInput` to skip truncation on the
 * fast path.
 */
export abstract class BaseLLMAdapter implements LLMAdapter {
  abstract readonly contextStrategy: ContextStrategy;
  abstract readonly contextMaxMessages: number;
  protected abstract readonly modelId: string;

  abstract chat(input: LLMInput): Promise<LLMOutput>;
  abstract chatStream(input: LLMInput): AsyncGenerator<string, StreamResult | void, unknown>;

  protected truncateInput(input: LLMInput): LLMInput {
    return truncateInputDefault(input, this.getContextWindow(input));
  }

  protected getContextWindow(input: LLMInput): number {
    if (input.contextWindowOverride && input.contextWindowOverride > 0) {
      return input.contextWindowOverride;
    }
    const model = AI_MODELS[this.modelId];
    return model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  }
}
