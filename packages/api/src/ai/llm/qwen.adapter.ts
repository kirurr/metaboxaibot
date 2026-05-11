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
  "qwen-max": "qwen-max",
  "qwen-3-max-thinking": "qwen3-235b-a22b",
  "qwen-3-thinking": "qwen3-30b-a3b",
  "qwen-3": "qwen3-8b",
};

/**
 * Alibaba Qwen adapter (db_history strategy).
 * Uses OpenAI-compatible API via DashScope.
 */
export class QwenAdapter extends BaseLLMAdapter {
  readonly contextStrategy = "db_history" as const;
  readonly contextMaxMessages: number;
  protected readonly modelId: string;

  private client: OpenAI;
  private apiModel: string;

  constructor(
    model: string,
    contextMaxMessages = 40,
    apiKey = config.ai.qwen,
    fetchFn?: typeof globalThis.fetch,
  ) {
    super();
    if (!apiKey) throw new Error("[QwenAdapter] QWEN_API_KEY is not set");
    this.modelId = model;
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      ...(fetchFn ? { fetch: fetchFn as unknown as OpenAIClientOptions["fetch"] } : {}),
    });
    this.apiModel = MODEL_MAP[model] ?? model;
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
      enable_thinking: input.enableThinking,
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
      ...(input.temperature !== undefined
        ? { temperature: parseFloat(String(input.temperature)) }
        : {}),
      ...(input.maxTokensLimitEnabled === true && input.maxTokens !== undefined
        ? { max_tokens: input.maxTokens }
        : {}),
      ...(input.enableThinking !== undefined ? { enable_thinking: input.enableThinking } : {}),
    });

    let inputTokensUsed = 0;
    let outputTokensUsed = 0;
    // <think>...</think> обёртка вокруг reasoning_content.
    // Qwen thinking режимы шлют reasoning в delta.reasoning_content параллельно
    // delta.content. enable_thinking — отдельный opt-in флаг (см. body выше);
    // если он false — reasoning_content просто не приходит.
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
