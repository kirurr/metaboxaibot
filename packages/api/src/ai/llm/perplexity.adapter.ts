import OpenAI, { type ClientOptions as OpenAIClientOptions } from "openai";
import {
  BaseLLMAdapter,
  type LLMInput,
  type LLMOutput,
  type MessageRecord,
  type StreamResult,
} from "./base.adapter.js";
import { config } from "@metabox/shared";
import { logCall } from "../../utils/fetch.js";

const MODEL_MAP: Record<string, string> = {
  "perplexity-sonar-pro": "sonar-pro",
  "perplexity-sonar-research": "sonar-deep-research",
  "perplexity-sonar": "sonar",
};

/**
 * Perplexity adapter (db_history strategy).
 * Uses OpenAI-compatible API. All models have built-in web search.
 */
export class PerplexityAdapter extends BaseLLMAdapter {
  readonly contextStrategy = "db_history" as const;
  readonly contextMaxMessages: number;
  protected readonly modelId: string;

  private client: OpenAI;
  private apiModel: string;

  constructor(
    modelId: string,
    contextMaxMessages = 20,
    apiKey = config.ai.perplexity,
    fetchFn?: typeof globalThis.fetch,
  ) {
    super();
    this.modelId = modelId;
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.perplexity.ai",
      ...(fetchFn ? { fetch: fetchFn as unknown as OpenAIClientOptions["fetch"] } : {}),
    });
    this.apiModel = MODEL_MAP[modelId] ?? modelId;
    this.contextMaxMessages = contextMaxMessages;
  }

  async chat(input: LLMInput): Promise<LLMOutput> {
    const chunks: string[] = [];
    for await (const chunk of this.chatStream(input)) {
      chunks.push(chunk);
    }
    return { text: chunks.join(""), tokensUsed: 0 };
  }

  async *chatStream(input: LLMInput): AsyncGenerator<string, StreamResult, unknown> {
    input = this.truncateInput(input);
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      ...(input.systemPrompt ? [{ role: "system" as const, content: input.systemPrompt }] : []),
      ...(input.history ?? []).map((m: MessageRecord) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user", content: input.prompt },
    ];

    const extraParams: Record<string, unknown> = {};
    if (input.temperature !== undefined) extraParams.temperature = input.temperature;
    if (input.maxTokensLimitEnabled === true && input.maxTokens !== undefined) {
      extraParams.max_tokens = input.maxTokens;
    }
    if (input.searchRecencyFilter) extraParams.search_recency_filter = input.searchRecencyFilter;
    if (input.searchContextSize)
      extraParams.web_search_options = { search_context_size: input.searchContextSize };
    if (input.searchDomainFilter) {
      const domains = input.searchDomainFilter
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);
      if (domains.length) extraParams.search_domain_filter = domains;
    }
    logCall(this.apiModel, "chatStream", { messages_count: messages.length, ...extraParams });
    const stream = await (
      this.client.chat.completions.create as (p: unknown) => Promise<
        AsyncIterable<
          OpenAI.Chat.Completions.ChatCompletionChunk & {
            usage?: { prompt_tokens: number; completion_tokens: number };
          }
        >
      >
    )({
      model: this.apiModel,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...extraParams,
    });

    let inputTokensUsed = 0;
    let outputTokensUsed = 0;
    let citationTokens = 0;
    let numSearchQueries = 0;
    let reasoningTokens = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
      if (chunk.usage) {
        const u = chunk.usage as typeof chunk.usage & {
          citation_tokens?: number;
          num_search_queries?: number;
          reasoning_tokens?: number;
        };
        inputTokensUsed = u.prompt_tokens;
        outputTokensUsed = u.completion_tokens;
        citationTokens = u.citation_tokens ?? 0;
        numSearchQueries = u.num_search_queries ?? 0;
        reasoningTokens = u.reasoning_tokens ?? 0;
      }
    }

    // For sonar-deep-research, compute exact USD cost from all billing components
    if (this.modelId === "perplexity-sonar-research") {
      const providerUsdCost =
        (inputTokensUsed / 1_000_000) * 2 +
        (outputTokensUsed / 1_000_000) * 8 +
        (citationTokens / 1_000_000) * 2 +
        (numSearchQueries / 1_000) * 5 +
        (reasoningTokens / 1_000_000) * 3;
      return { inputTokensUsed, outputTokensUsed, providerUsdCost };
    }

    return { inputTokensUsed, outputTokensUsed };
  }
}
