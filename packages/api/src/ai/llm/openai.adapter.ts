import OpenAI, { type ClientOptions as OpenAIClientOptions } from "openai";
import {
  BaseLLMAdapter,
  type LLMInput,
  type LLMOutput,
  type StreamResult,
} from "./base.adapter.js";
import { config } from "@metabox/shared";
import { logCall } from "../../utils/fetch.js";
import { logger } from "../../logger.js";

/**
 * Запас токенов под chain-of-thought для reasoning-моделей. Прибавляется к
 * пользовательскому "max output length" чтобы reasoning не съедал бюджет
 * видимого ответа. Числа консервативные — OpenAI всё равно биллит по факту,
 * `max_output_tokens` лишь верхняя граница.
 */
function reasoningReserve(effort: string | undefined): number {
  switch (effort) {
    case "none":
      return 0;
    case "minimal":
      return 1_024;
    case "low":
      return 4_096;
    case "high":
      return 32_000;
    case "xhigh":
      return 50_000;
    case "medium":
    default:
      return 16_000;
  }
}

/**
 * OpenAI Responses API adapter (provider_chain strategy).
 * Uses previous_response_id to chain responses — no history transfer needed.
 */
export class OpenAIAdapter extends BaseLLMAdapter {
  readonly contextStrategy = "provider_chain" as const;
  readonly contextMaxMessages = 0;
  protected readonly modelId: string;

  private client: OpenAI;
  private model: string;

  constructor(model: string, apiKey = config.ai.openai, fetchFn?: typeof globalThis.fetch) {
    super();
    this.model = model;
    this.modelId = model;
    this.client = new OpenAI({
      apiKey,
      ...(fetchFn ? { fetch: fetchFn as unknown as OpenAIClientOptions["fetch"] } : {}),
    });
  }

  /**
   * On the fast path (chained via `previous_response_id`) the prior context
   * lives on OpenAI's side and we have nothing to truncate locally — return
   * the input as-is. On the recovery path (no chain id, full history sent as
   * messages) fall back to the default token-aware truncation.
   */
  protected override truncateInput(input: LLMInput): LLMInput {
    if (input.previousResponseId) return input;
    return super.truncateInput(input);
  }

  private buildParams(input: LLMInput): Record<string, unknown> {
    // o-series (o1, o3, o4-mini…) and all gpt-5 variants are reasoning models
    // and do not support the temperature parameter.
    const isReasoning = /^o\d|^gpt-5/.test(this.model);

    // Responses API: `max_output_tokens` — это общий бюджет на reasoning +
    // visible output. UI-слайдер "Макс. длина ответа" семантически про
    // visible output, поэтому для reasoning-моделей добавляем резерв под
    // chain-of-thought: иначе medium-effort может съесть все 2048 токенов
    // на reasoning, response закроется как `incomplete (max_output_tokens)`,
    // юзер увидит пустой ответ. Биллинг не меняется — OpenAI считает по факту.
    const maxOutputTokens =
      isReasoning && input.maxTokens !== undefined
        ? input.maxTokens + reasoningReserve(input.reasoningEffort)
        : input.maxTokens;

    return {
      ...(input.previousResponseId ? { previous_response_id: input.previousResponseId } : {}),
      ...(input.systemPrompt ? { instructions: input.systemPrompt } : {}),
      // Reasoning models don't support temperature
      ...(!isReasoning && input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
      ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
      ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
      ...(input.verbosity ? { text: { verbosity: input.verbosity } } : {}),
    };
  }

  async chat(input: LLMInput): Promise<LLMOutput> {
    input = this.truncateInput(input);
    logCall(this.model, "chat", {
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      reasoning_effort: input.reasoningEffort,
    });
    const response = await (
      this.client.responses.create as (p: unknown) => Promise<OpenAI.Responses.Response>
    )({
      model: this.model,
      input: this.buildInput(input),
      ...this.buildParams(input),
    });
    const usage = response.usage;
    // tokensUsed here is a raw token count for the LLMOutput contract
    // (legacy non-stream path — chat.service uses chatStream end-result for
    // exact billing, including cached-token discount).
    return {
      text: response.output_text,
      tokensUsed: usage ? usage.input_tokens + usage.output_tokens : 0,
      newResponseId: response.id,
    };
  }

  async *chatStream(input: LLMInput): AsyncGenerator<string, StreamResult, unknown> {
    input = this.truncateInput(input);
    logCall(this.model, "chatStream", {
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      reasoning_effort: input.reasoningEffort,
    });
    const stream = await (
      this.client.responses.create as (
        p: unknown,
      ) => Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>
    )({
      model: this.model,
      input: this.buildInput(input),
      ...this.buildParams(input),
      stream: true,
    });

    let newResponseId: string | undefined;
    let inputTokensUsed: number | undefined;
    let cachedInputTokensUsed: number | undefined;
    let outputTokensUsed: number | undefined;
    let reasoningTokensUsed: number | undefined;
    let sawTerminalEvent = false;
    let deltaCount = 0;

    const captureUsage = (response: OpenAI.Responses.Response): void => {
      newResponseId = response.id;
      const usage = response.usage;
      if (!usage) return;
      inputTokensUsed = usage.input_tokens;
      cachedInputTokensUsed =
        (usage as { input_tokens_details?: { cached_tokens?: number } }).input_tokens_details
          ?.cached_tokens ?? 0;
      outputTokensUsed = usage.output_tokens;
      reasoningTokensUsed = (usage as { output_tokens_details?: { reasoning_tokens?: number } })
        .output_tokens_details?.reasoning_tokens;
    };

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        deltaCount++;
        yield event.delta;
      } else if (event.type === "response.completed") {
        sawTerminalEvent = true;
        captureUsage(event.response);
      } else if (event.type === "response.incomplete") {
        sawTerminalEvent = true;
        captureUsage(event.response);
        const reason = event.response.incomplete_details?.reason;
        logger.warn(
          {
            modelId: this.model,
            responseId: event.response.id,
            incompleteReason: reason,
            inputTokens: inputTokensUsed,
            outputTokens: outputTokensUsed,
            reasoningTokens: reasoningTokensUsed,
            visibleDeltas: deltaCount,
          },
          `openai.chatStream: response incomplete (reason=${reason ?? "unknown"})`,
        );
      } else if (event.type === "response.failed") {
        sawTerminalEvent = true;
        captureUsage(event.response);
        const error = event.response.error;
        logger.error(
          {
            modelId: this.model,
            responseId: event.response.id,
            errorCode: error?.code,
            errorMessage: error?.message,
            visibleDeltas: deltaCount,
          },
          `openai.chatStream: response failed (${error?.code ?? "unknown"})`,
        );
      } else if (event.type === "error") {
        const errEvent = event as {
          code?: string | null;
          message?: string;
          param?: string | null;
        };
        logger.error(
          {
            modelId: this.model,
            errorCode: errEvent.code,
            errorMessage: errEvent.message,
            errorParam: errEvent.param,
            visibleDeltas: deltaCount,
          },
          `openai.chatStream: stream error event (${errEvent.code ?? "unknown"})`,
        );
      }
    }

    if (!sawTerminalEvent) {
      logger.warn(
        {
          modelId: this.model,
          visibleDeltas: deltaCount,
        },
        "openai.chatStream: stream ended without terminal event",
      );
    }

    return { newResponseId, inputTokensUsed, cachedInputTokensUsed, outputTokensUsed };
  }

  private buildInput(input: LLMInput): string | OpenAI.Responses.ResponseInput {
    const urls = input.imageUrls?.length ? input.imageUrls : input.imageUrl ? [input.imageUrl] : [];
    // Принимаем attachment'ы у которых есть либо openaiFileId (uploaded в Files API)
    // либо url (presigned S3 fallback). Раньше фильтр требовал url → docs с file_id
    // и без url'а молча выкидывались, OpenAI не получал документ → "не вижу файл".
    const docs = (input.documentAttachments ?? []).filter((d) => !!d.openaiFileId || !!d.url);
    const hasHistory = !input.previousResponseId && (input.history?.length ?? 0) > 0;

    const buildUserContent = (): OpenAI.Responses.ResponseInputContent[] => [
      ...(input.prompt ? [{ type: "input_text" as const, text: input.prompt }] : []),
      ...urls.map((url) => ({
        type: "input_image" as const,
        image_url: url,
        detail: "auto" as const,
      })),
      ...docs.map(
        (d) =>
          ({
            type: "input_file" as const,
            // OpenAI Files API file_id предпочтительнее file_url — file_id не
            // имеет TTL, не зависит от presigned-URL'ов (которые истекают за 1ч).
            // Если openaiFileId не выставлен (legacy/skipped upload) — fallback
            // на presigned file_url (работает в рамках одного turn'а).
            ...(d.openaiFileId ? { file_id: d.openaiFileId } : { file_url: d.url! }),
          }) as unknown as OpenAI.Responses.ResponseInputContent,
      ),
    ];

    if (hasHistory) {
      const items: OpenAI.Responses.ResponseInput = [];
      for (const m of input.history!) {
        const histAtts = m.attachments ?? [];
        // Изображения шлём через input_image (image_url из presigned S3),
        // прочие документы — через input_file.
        const histImages = histAtts.filter((a) => a.mimeType?.startsWith("image/") && !!a.url);
        const histDocs = histAtts.filter(
          (a) => !a.mimeType?.startsWith("image/") && (!!a.openaiFileId || !!a.url),
        );
        if (m.role === "user") {
          const content: OpenAI.Responses.ResponseInputContent[] = [
            ...(m.content ? [{ type: "input_text" as const, text: m.content }] : []),
            ...histImages.map(
              (img) =>
                ({
                  type: "input_image" as const,
                  image_url: img.url!,
                  detail: "auto" as const,
                }) as OpenAI.Responses.ResponseInputContent,
            ),
            ...histDocs.map(
              (d) =>
                ({
                  type: "input_file" as const,
                  ...(d.openaiFileId ? { file_id: d.openaiFileId } : { file_url: d.url! }),
                }) as unknown as OpenAI.Responses.ResponseInputContent,
            ),
          ];
          items.push({ role: "user", content });
        } else {
          items.push({
            role: "assistant",
            content: [{ type: "output_text" as const, text: m.content }],
          } as unknown as OpenAI.Responses.ResponseInput[number]);
        }
      }
      items.push({ role: "user", content: buildUserContent() });
      return items;
    }

    if (urls.length > 0 || docs.length > 0) {
      return [{ role: "user", content: buildUserContent() }];
    }
    return input.prompt;
  }
}
