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
  "grok-4": "grok-4.20",
  "grok-4-fast": "grok-4-1-fast",
};

/**
 * xAI Grok adapter (db_history strategy).
 * Uses OpenAI-compatible API via xAI.
 */
export class GrokAdapter extends BaseLLMAdapter {
  readonly contextStrategy = "db_history" as const;
  readonly contextMaxMessages: number;
  protected readonly modelId: string;

  private client: OpenAI;
  private apiModel: string;

  constructor(
    modelId: string,
    contextMaxMessages = 40,
    apiKey = config.ai.grok,
    fetchFn?: typeof globalThis.fetch,
  ) {
    super();
    this.modelId = modelId;
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.x.ai/v1",
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

    logCall(this.apiModel, "chatStream", {
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      messages_count: messages.length,
      reasoning_effort: input.reasoningEffort,
    });
    const stream = await (
      this.client.chat.completions.create as (
        p: unknown,
      ) => Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>>
    )({
      model: this.apiModel,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
      ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
    });

    let inputTokensUsed = 0;
    let outputTokensUsed = 0;
    // <think>...</think> обёртка вокруг reasoning_content.
    // xAI шлёт reasoning в delta.reasoning_content параллельно delta.content.
    let inThinkBlock = false;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as
        | { content?: string; reasoning_content?: string }
        | undefined;
      const reasoning = input.showReasoning ? (delta?.reasoning_content ?? "") : "";
      const visible = delta?.content ?? "";
      if (reasoning) {
        if (!inThinkBlock) {
          inThinkBlock = true;
          yield "<think>";
        }
        yield reasoning;
      }
      if (visible) {
        if (inThinkBlock) {
          inThinkBlock = false;
          yield "</think>";
        }
        yield visible;
      }
      if (chunk.usage) {
        inputTokensUsed = chunk.usage.prompt_tokens;
        outputTokensUsed = chunk.usage.completion_tokens;
      }
    }
    if (inThinkBlock) yield "</think>";

    return { inputTokensUsed, outputTokensUsed };
  }
}
