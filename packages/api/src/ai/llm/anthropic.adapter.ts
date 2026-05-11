import Anthropic, { type ClientOptions as AnthropicClientOptions } from "@anthropic-ai/sdk";
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
    // Extended thinking requires a higher max_tokens budget (must exceed budget_tokens).
    const maxTokens = input.extendedThinking
      ? Math.max(input.maxTokens ?? 16000, 16000)
      : (input.maxTokens ?? 4096);
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
    // Состояние <think>...</think> обёртки. Открываем на первом thinking_delta,
    // закрываем на первом text_delta или в конце стрима. extended_thinking —
    // отдельный opt-in флаг; thinking_delta события приходят только когда он on.
    let inThinkBlock = false;
    const closeThink = function* (): Generator<string> {
      if (inThinkBlock) {
        yield "</think>";
        inThinkBlock = false;
      }
    };

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield* closeThink();
        yield event.delta.text;
      } else if (
        input.showReasoning &&
        event.type === "content_block_delta" &&
        (event.delta as { type?: string; thinking?: string }).type === "thinking_delta"
      ) {
        const text = (event.delta as { thinking?: string }).thinking ?? "";
        if (!text) continue;
        if (!inThinkBlock) {
          inThinkBlock = true;
          yield "<think>";
        }
        yield text;
      } else if (event.type === "message_start") {
        inputTokens = event.message.usage.input_tokens;
      } else if (event.type === "message_delta") {
        outputTokens = event.usage.output_tokens;
        // stop_reason → incompleteReason: позволяет chat.service отличить
        // legit empty-response (max_tokens) от generic provider error. Без
        // этого юзер при reasoning-cap получает «временно недоступен» вместо
        // адресного «снизьте Глубину рассуждений / поднимите Макс. длину».
        // SDK 0.39 знает только 4 stop_reason'а; «refusal» добавили в более
        // новых API-версиях — пока не покрываем (см. proxy-адаптер для него).
        if (event.delta.stop_reason === "max_tokens") {
          incompleteReason = "max_output_tokens";
        }
      }
    }

    yield* closeThink();

    return {
      inputTokensUsed: inputTokens,
      outputTokensUsed: outputTokens,
      ...(incompleteReason ? { incompleteReason } : {}),
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
