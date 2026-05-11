import Anthropic, { type ClientOptions as AnthropicClientOptions } from "@anthropic-ai/sdk";
import {
  BaseLLMAdapter,
  type LLMInput,
  type LLMOutput,
  type MessageRecord,
  type StreamResult,
} from "./base.adapter.js";
import { AI_MODELS, config } from "@metabox/shared";
import { logCall } from "../../utils/fetch.js";

const MODEL_MAP: Record<string, string> = {
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-haiku": "claude-haiku-4-5-20251001",
  "claude-opus": "claude-opus-4-6",
  "claude-opus-4-5": "claude-opus-4-5",
  "claude-sonnet-4-5": "claude-sonnet-4-5-20251001",
};

/**
 * Anthropic Claude adapter (db_history strategy).
 * Sends the last N messages from DB with each request.
 */
export class AnthropicAdapter extends BaseLLMAdapter {
  readonly contextStrategy = "db_history" as const;
  readonly contextMaxMessages: number;
  protected readonly modelId: string;

  private client: Anthropic;
  private apiModel: string;

  constructor(
    modelId: string,
    contextMaxMessages = 50,
    apiKey = config.ai.anthropic,
    fetchFn?: typeof globalThis.fetch,
  ) {
    super();
    this.modelId = modelId;
    this.client = new Anthropic({
      apiKey,
      ...(fetchFn ? { fetch: fetchFn as unknown as AnthropicClientOptions["fetch"] } : {}),
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
    const messages = this.buildMessages(input);
    logCall(this.apiModel, "chatStream", {
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      messages_count: messages.length,
      extended_thinking: input.extendedThinking,
    });
    // Anthropic Messages API требует `max_tokens` всегда. Если юзер не включил
    // тогл «Ограничить длину ответа» — подставляем безопасный потолок
    // `min(16K, contextWindow * 0.2)`. См. claude-anthropic-proxy.adapter для
    // полного обоснования. При включённом тогле — ровно его значение.
    const userContextWindow =
      input.contextWindowOverride && input.contextWindowOverride > 0
        ? input.contextWindowOverride
        : (AI_MODELS[this.modelId]?.contextWindow ?? 200_000);
    const ANTHROPIC_OFF_DEFAULT = Math.min(16_384, Math.floor(userContextWindow * 0.2));
    const modelCap = AI_MODELS[this.modelId]?.maxOutputTokens ?? 64_000;
    const maxTokens =
      input.maxTokensLimitEnabled === true && input.maxTokens !== undefined
        ? input.maxTokens
        : Math.min(modelCap, ANTHROPIC_OFF_DEFAULT);
    const stream = (
      this.client.messages.stream as (p: unknown) => ReturnType<typeof this.client.messages.stream>
    )({
      model: this.apiModel,
      max_tokens: maxTokens,
      ...(input.temperature !== undefined && !input.extendedThinking
        ? { temperature: Math.min(input.temperature, 1) }
        : {}),
      ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
      ...(input.extendedThinking ? { thinking: { type: "enabled", budget_tokens: 10000 } } : {}),
      messages,
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let incompleteReason: string | undefined;
    let lastStopReason: string | undefined;
    let visibleChunks = 0;
    // Reasoning буферизуется и yield'ится только перед первым text_delta
    // (если showReasoning=true) ИЛИ перед return при non-refusal stop_reason
    // с visibleChunks=0 (всегда, чтобы юзер понял что произошло). Симметрично
    // claude-anthropic-proxy.adapter — гарантирует что mid-stream обрыв на
    // reasoning ОСТАВЛЯЕТ `chunks.length === 0` в chat.service и retry/fallback
    // реально срабатывает.
    let thinkingBuffer = "";

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if (thinkingBuffer.length > 0) {
          if (input.showReasoning) {
            yield "<think>";
            yield thinkingBuffer;
            yield "</think>";
          }
          thinkingBuffer = "";
        }
        visibleChunks++;
        yield event.delta.text;
      } else if (
        event.type === "content_block_delta" &&
        (event.delta as { type?: string; thinking?: string }).type === "thinking_delta"
      ) {
        const text = (event.delta as { thinking?: string }).thinking ?? "";
        if (text) thinkingBuffer += text;
      } else if (event.type === "message_start") {
        inputTokens = event.message.usage.input_tokens;
      } else if (event.type === "message_delta") {
        outputTokens = event.usage.output_tokens;
        const stopReason = event.delta.stop_reason;
        if (typeof stopReason === "string") lastStopReason = stopReason;
        // stop_reason → incompleteReason: позволяет chat.service отличить
        // legit empty-response (max_tokens) от generic provider error.
        if (stopReason === "max_tokens") {
          incompleteReason = "max_output_tokens";
        }
      }
    }

    // Финальный flush буфера: при любом non-refusal завершении с visible=0 —
    // показываем thinking, иначе chat.service увидит пустой ответ.
    if (
      visibleChunks === 0 &&
      thinkingBuffer.length > 0 &&
      lastStopReason !== undefined &&
      lastStopReason !== "refusal"
    ) {
      yield "<think>";
      yield thinkingBuffer;
      yield "</think>";
    }

    return {
      inputTokensUsed: inputTokens,
      outputTokensUsed: outputTokens,
      ...(incompleteReason ? { incompleteReason } : {}),
      ...(lastStopReason ? { lastStopReason } : {}),
    };
  }

  private buildMessages(input: LLMInput): Anthropic.MessageParam[] {
    // Historical messages may carry attachments (PDFs / images) that need to
    // be re-sent on every request. Изображения шлём как image-блоки, PDF —
    // как document-блоки. User explicitly chose "resend every time" over
    // "only current message" for quality.
    const history: Anthropic.MessageParam[] = (input.history ?? []).map((m: MessageRecord) => {
      const atts = (m.attachments ?? []).filter((a) => !!a.url);
      const images = atts.filter((a) => a.mimeType.startsWith("image/"));
      const docs = atts.filter((a) => !a.mimeType.startsWith("image/"));
      if (images.length === 0 && docs.length === 0) {
        return { role: m.role, content: m.content };
      }

      const blocks: Anthropic.ContentBlockParam[] = [
        ...images.map(
          (img) =>
            ({
              type: "image" as const,
              source: { type: "url" as const, url: img.url! },
            }) as Anthropic.ContentBlockParam,
        ),
        ...docs.map(
          (d) =>
            ({
              type: "document" as const,
              source: { type: "url" as const, url: d.url! },
            }) as Anthropic.ContentBlockParam,
        ),
        ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
      ];
      return { role: m.role, content: blocks };
    });

    const urls = input.imageUrls?.length ? input.imageUrls : input.imageUrl ? [input.imageUrl] : [];
    const docs = (input.documentAttachments ?? []).filter((d) => !!d.url);

    const userContent: Anthropic.MessageParam["content"] =
      urls.length || docs.length
        ? [
            ...urls.map((url) => ({
              type: "image" as const,
              source: { type: "url" as const, url },
            })),
            ...docs.map(
              (d) =>
                ({
                  type: "document" as const,
                  source: { type: "url" as const, url: d.url! },
                }) as Anthropic.ContentBlockParam,
            ),
            ...(input.prompt ? [{ type: "text" as const, text: input.prompt }] : []),
          ]
        : input.prompt;

    return [...history, { role: "user", content: userContent }];
  }
}
