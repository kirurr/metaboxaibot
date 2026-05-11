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
    // Opt-in cap: `max_output_tokens` идёт в провайдер ТОЛЬКО когда юзер явно
    // включил тогл «Ограничить длину ответа» (maxTokensLimitEnabled === true).
    // На reasoning-моделях этот cap считает reasoning + visible вместе — при
    // выключенном тогле не передаём вообще, чтобы reasoning не съел бюджет
    // и не оставил юзера с пустым ответом. См. также описание поля в
    // LLMInput.maxTokensLimitEnabled.
    const userCap =
      input.maxTokensLimitEnabled === true && input.maxTokens !== undefined
        ? input.maxTokens
        : undefined;
    return {
      ...(input.previousResponseId ? { previous_response_id: input.previousResponseId } : {}),
      ...(input.systemPrompt ? { instructions: input.systemPrompt } : {}),
      // Reasoning models don't support temperature
      ...(!isReasoning && input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
      ...(userCap !== undefined ? { max_output_tokens: userCap } : {}),
      // `reasoning.summary: "auto"` просим только когда юзер включил
      // showReasoning — это бесплатный summary-вывод (не увеличивает
      // reasoning_tokens billing'а), но добавляет SSE event-типы
      // `response.reasoning_summary_text.delta` в стрим. Без этого OpenAI
      // молчит про CoT и юзер не увидит ничего даже при включенном тогле.
      ...(input.reasoningEffort || (isReasoning && input.showReasoning)
        ? {
            reasoning: {
              ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
              ...(isReasoning && input.showReasoning ? { summary: "auto" } : {}),
            },
          }
        : {}),
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
    let newResponseId: string | undefined;
    let inputTokensUsed: number | undefined;
    let cachedInputTokensUsed: number | undefined;
    let outputTokensUsed: number | undefined;
    let reasoningTokensUsed: number | undefined;
    let incompleteReason: string | undefined;
    let sawTerminalEvent = false;
    let deltaCount = 0;
    // Состояние `<think>...</think>` обёртки. OpenAI шлёт reasoning_summary
    // дельты ДО visible-чанков. На первой reasoning-дельте открываем `<think>`,
    // при первом visible-чанке (или конце стрима) — закрываем `</think>`.
    // Если showReasoning=false — reasoning-дельты вообще не приходят (мы не
    // запрашивали summary в buildParams), так что обёртка остаётся неактивна.
    let inThinkBlock = false;
    const closeThink = function* (): Generator<string> {
      if (inThinkBlock) {
        yield "</think>";
        inThinkBlock = false;
      }
    };

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

    try {
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

      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          deltaCount++;
          // Visible-чанк → закрываем reasoning-обёртку если она открыта.
          yield* closeThink();
          yield event.delta;
        } else if (
          input.showReasoning &&
          (event.type === "response.reasoning_summary_text.delta" ||
            event.type === "response.reasoning.delta")
        ) {
          // На первой reasoning-дельте открываем `<think>`. Дальнейшие
          // дельты (включая событие `reasoning_summary_part.added` между
          // несколькими summary-частями) идут как сырой текст внутри.
          const evDelta = (event as { delta?: string }).delta ?? "";
          if (!evDelta) continue;
          if (!inThinkBlock) {
            inThinkBlock = true;
            yield "<think>";
          }
          yield evDelta;
        } else if (event.type === "response.reasoning_summary_part.added" && inThinkBlock) {
          // Граница между двумя summary-частями: вставляем перенос строки,
          // чтобы части не слипались в одну строку при рендеринге у юзера.
          yield "\n\n";
        } else if (event.type === "response.completed") {
          sawTerminalEvent = true;
          captureUsage(event.response);
        } else if (event.type === "response.incomplete") {
          sawTerminalEvent = true;
          captureUsage(event.response);
          const reason = event.response.incomplete_details?.reason;
          incompleteReason = reason ?? undefined;
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
    } catch (err) {
      // Stream.iterator throws a plain Error (no .status) when the API responds
      // with an overload message during streaming — attach status=503 so that
      // isFiveXxError in chat.service triggers the retry/fallback flow.
      if (err instanceof Error && !("status" in err) && /overloaded/i.test(err.message)) {
        (err as Error & { status: number }).status = 503;
      }
      throw err;
    }

    // Стрим завершился внутри <think> блока (visible так и не пришёл) —
    // закрываем тег, иначе stripThinkingBlocks на bot/web стороне выкинет
    // весь хвост сообщения.
    yield* closeThink();

    if (!sawTerminalEvent) {
      logger.warn(
        {
          modelId: this.model,
          visibleDeltas: deltaCount,
        },
        "openai.chatStream: stream ended without terminal event",
      );
    }

    return {
      newResponseId,
      inputTokensUsed,
      cachedInputTokensUsed,
      outputTokensUsed,
      incompleteReason,
    };
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
