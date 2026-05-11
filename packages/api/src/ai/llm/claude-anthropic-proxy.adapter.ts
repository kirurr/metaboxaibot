import {
  BaseLLMAdapter,
  type LLMInput,
  type LLMOutput,
  type MessageRecord,
  type StreamResult,
} from "./base.adapter.js";
import { AI_MODELS, config } from "@metabox/shared";
import { logCall } from "../../utils/fetch.js";
import { logger } from "../../logger.js";

/**
 * Anthropic Messages API-совместимые прокси (KIE, Evolink, etc.) — все
 * экспонируют 1:1 Anthropic SSE-протокол на разных base URL'ах. Этот адаптер
 * принимает baseUrl параметром и обслуживает любого такого провайдера.
 *
 * Дефолтный env-key подбирается под providerLabel (для логов и env-fallback'а):
 *   - "kie"     → config.ai.kie
 *   - "evolink" → config.ai.evolink
 */
type ClaudeProxyConfig = {
  /** Полный URL endpoint'а messages — например, https://api.kie.ai/claude/v1/messages */
  url: string;
  /** Имя провайдера для логов и env-fallback'а */
  providerLabel: string;
  /** Default env-key, если не передан явный apiKey */
  envKey: string | undefined;
};

const PROVIDER_CONFIGS: Record<string, ClaudeProxyConfig> = {
  "kie-claude": {
    url: "https://api.kie.ai/claude/v1/messages",
    providerLabel: "kie",
    envKey: config.ai.kie,
  },
  "evolink-claude": {
    url: "https://api.evolink.ai/v1/messages",
    providerLabel: "evolink",
    envKey: config.ai.evolink,
  },
};

/**
 * Внутренний modelId → API-имя модели у провайдера. Anthropic-имена одинаковы
 * у обоих прокси (kie и evolink), маппинг общий.
 */
const MODEL_MAP: Record<string, string> = {
  "claude-opus": "claude-opus-4-6",
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-haiku": "claude-haiku-4-5",
};

interface ProxyContentBlock {
  type: string;
  [k: string]: unknown;
}
interface ProxyMessage {
  role: "user" | "assistant";
  content: string | ProxyContentBlock[];
}

/**
 * Claude через Anthropic-совместимые прокси (KIE, Evolink). Совместимо по
 * событиям SSE с Anthropic-API: `message_start` / `content_block_delta` /
 * `message_delta` / `message_stop`.
 *
 * Отличия от прямого Anthropic:
 *   - Аутентификация: `Authorization: Bearer <KEY>` вместо `x-api-key`.
 *   - `temperature` прокси молча игнорируют.
 *   - `type: "document"` content-блоки не поддерживаются — PDF обрабатывается
 *     server-side через `documentTextExtractFallback` (текст инлайнится
 *     в prompt в chat.service.ts).
 *   - Extended thinking — простой boolean `thinkingFlag`, без budget_tokens.
 */
export class ClaudeAnthropicProxyAdapter extends BaseLLMAdapter {
  readonly contextStrategy = "db_history" as const;
  readonly contextMaxMessages: number;
  protected readonly modelId: string;

  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly apiModel: string;
  private readonly proxyConfig: ClaudeProxyConfig;

  /**
   * @param providerKey — `"kie-claude"` | `"evolink-claude"`. Определяет
   *   base URL и default env-key. Передаётся из factory по `model.provider`.
   */
  constructor(
    modelId: string,
    providerKey: string,
    contextMaxMessages = 50,
    apiKey?: string,
    fetchFn?: typeof globalThis.fetch,
  ) {
    super();
    const cfg = PROVIDER_CONFIGS[providerKey];
    if (!cfg) {
      throw new Error(`Unknown Claude proxy provider: ${providerKey}`);
    }
    this.proxyConfig = cfg;
    this.modelId = modelId;
    this.contextMaxMessages = contextMaxMessages;
    this.apiKey = apiKey ?? cfg.envKey ?? "";
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.apiModel = MODEL_MAP[modelId] ?? modelId;
  }

  async chat(input: LLMInput): Promise<LLMOutput> {
    const chunks: string[] = [];
    for await (const chunk of this.chatStream(input)) {
      chunks.push(chunk);
    }
    return { text: chunks.join(""), tokensUsed: 0 };
  }

  async *chatStream(input: LLMInput): AsyncGenerator<string, StreamResult, unknown> {
    // Anthropic Messages API требует `max_tokens` ВСЕГДА (без него 400). Когда
    // юзер не включал тогл «Ограничить длину ответа», подставляем щедрый
    // потолок `min(modelCap, ctx * 0.4)` — это эффективный «безлимит» для
    // дефолтных context window (Opus/Sonnet 200K → 64K cap = весь modelCap),
    // и достаточно для extended_thinking чтобы reasoning не задушил visible.
    //
    // Чтобы НЕ упереться в Anthropic-инвариант `input_tokens + max_tokens ≤
    // context_window`, прокидываем `adapterOutputReservation` в truncate —
    // оно зарезервирует ровно то значение, которое мы пошлём в API. Иначе
    // на длинных диалогах было бы `prompt is too long` 400.
    //
    // При включённом тогле — ровно значение юзера, без silent-override.
    const userContextWindow =
      input.contextWindowOverride && input.contextWindowOverride > 0
        ? input.contextWindowOverride
        : (AI_MODELS[this.modelId]?.contextWindow ?? 200_000);
    const modelCap = AI_MODELS[this.modelId]?.maxOutputTokens ?? 64_000;
    const maxTokens =
      input.maxTokensLimitEnabled === true && input.maxTokens !== undefined
        ? input.maxTokens
        : Math.min(modelCap, Math.floor(userContextWindow * 0.4));
    // Hint в truncate — должен идти ДО `this.truncateInput`.
    input = { ...input, adapterOutputReservation: maxTokens };
    input = this.truncateInput(input);
    const messages = this.buildMessages(input);

    const body: Record<string, unknown> = {
      model: this.apiModel,
      max_tokens: maxTokens,
      stream: true,
      messages,
      ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
      ...(input.extendedThinking ? { thinkingFlag: true } : {}),
    };

    logCall(`${this.proxyConfig.providerLabel}/${this.apiModel}`, "chatStream", {
      max_tokens: maxTokens,
      messages_count: messages.length,
      extended_thinking: input.extendedThinking,
    });

    const res = await this.fetchFn(this.proxyConfig.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      // KIE/evolink Claude-гейты иногда транслируют upstream 5xx как 4xx
      // (видели 404 на тело `api_error: Internal server error...`), теряя
      // транзиентный сигнал. Body несёт исходный Anthropic-style error type —
      // он и есть источник истины. Нормализуем status, чтобы classifier
      // в chat.service подхватил fallback flow.
      let effectiveStatus = res.status;
      // 429 не трогаем — classifyRateLimit ждёт ровно его для per-key throttle;
      // override в 5xx переключил бы провайдера вместо корректного backoff'а.
      if (res.status < 500 && res.status !== 429) {
        try {
          const parsed = JSON.parse(text) as { error?: { type?: string; message?: string } };
          const errType = parsed?.error?.type;
          const errMsg = parsed?.error?.message ?? "";
          if (errType === "api_error" || errType === "overloaded_error") {
            effectiveStatus = 503;
          } else if (errType === "rate_limit_error") {
            effectiveStatus = 429;
          } else if (/no available service/i.test(errMsg)) {
            // Evolink returns 400 invalid_request_error when its backend has no
            // capacity for the model — semantically a 503, not a client error.
            effectiveStatus = 503;
          }
        } catch {
          /* body не JSON — оставляем оригинальный status */
        }
      }
      const err = new Error(
        `${this.proxyConfig.providerLabel} Claude failed: ${res.status} ${text}`,
      ) as Error & {
        status?: number;
        headers?: Record<string, string | string[]>;
      };
      err.status = effectiveStatus;
      // Преобразуем заголовки в форму, ожидаемую classifyRateLimit (нужен retry-after).
      const hdrs: Record<string, string | string[]> = {};
      res.headers.forEach((v, k) => {
        hdrs[k.toLowerCase()] = v;
      });
      err.headers = hdrs;
      throw err;
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let incompleteReason: string | undefined;
    // Reasoning буферизуем ВСЕГДА (независимо от `showReasoning`), НЕ yield'им
    // сразу при каждом thinking_delta. Зачем:
    //   1) gateway-503 escalation ниже проверяет `visibleChunks === 0`, но
    //      chat.service отдельно смотрит `chunks.length > 0` (включая reasoning
    //      chunks) и при mid-stream обрыве БЛОКИРУЕТ retry. Если yield'ить
    //      reasoning сразу — при обрыве chat.service считал бы стрим
    //      mid-stream и не пробовал бы другие ключи.
    //   2) Если визибл не пришёл и причина = max_tokens — нам нужно показать
    //      юзеру что произошло (куда ушли его токены), даже когда у него
    //      `showReasoning=false`. Иначе он видит пустоту с непонятным сообщением.
    //
    // Yield'аем в двух случаях:
    //  (a) первый text_delta пришёл и `showReasoning=true` → yield `<think>` +
    //      buffer + `</think>` + visible. При `showReasoning=false` тогда
    //      yield'аем только visible — буфер выкидываем без yield (юзер не
    //      хочет видеть размышления при нормальном ответе).
    //  (b) стрим завершился с `stop_reason ∈ {max_tokens, end_turn}` И visible
    //      ни одного → yield буфер `<think>...</think>` ВСЕГДА (даже при
    //      `showReasoning=false`). Юзер увидит, что модель только подумала.
    let thinkingBuffer = "";
    // Диагностика пустых стримов (KIE-прокси иногда висит и закрывает
    // соединение без терминального message_delta — юзер видит generic
    // "модель отдыхает", в логах нет ни stop_reason, ни тайминга. Считаем
    // event-типы и фиксируем стоп-причину/usage-флаг, чтобы при пустом
    // ответе понять: стрим оборвался / Claude вернул end_turn без контента
    // / message_delta пришёл без usage. См. warn-блок ниже.
    const streamStartedAt = Date.now();
    let visibleChunks = 0;
    let lastStopReason: string | undefined;
    let messageDeltaWithUsage = false;
    const eventTypeCounts: Record<string, number> = {};

    // Stream parser: SSE events delimited by "\n\n"; each event has
    // `event: <name>\ndata: <json>` lines (Anthropic-compatible).
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const evt = parseSseEvent(raw);
          if (!evt?.data) continue;

          // text_delta → visible. Если в буфере накоплен reasoning И юзер
          //   хочет его видеть — yield `<think>...</think>` ПЕРЕД visible.
          //   При showReasoning=false просто очищаем буфер без yield.
          // thinking_delta → reasoning. ВСЕГДА копим в буфер (см. комментарий
          //   выше). Гейт на showReasoning стоит только на yield'е.
          const visibleText = handleVisibleDelta(evt.data);
          if (visibleText) {
            if (thinkingBuffer.length > 0) {
              if (input.showReasoning) {
                yield "<think>";
                yield thinkingBuffer;
                yield "</think>";
              }
              thinkingBuffer = "";
            }
            visibleChunks++;
            yield visibleText;
          } else {
            const reasoningText = handleThinkingDelta(evt.data);
            if (reasoningText) thinkingBuffer += reasoningText;
          }

          // Извлекаем токены из служебных событий.
          const t = evt.data.type;
          if (typeof t === "string") eventTypeCounts[t] = (eventTypeCounts[t] ?? 0) + 1;
          if (t === "message_start") {
            const u = evt.data.message?.usage;
            if (u) {
              inputTokens = u.input_tokens ?? inputTokens;
              cachedInputTokens = u.cache_read_input_tokens ?? cachedInputTokens;
            }
          } else if (t === "message_delta") {
            const u = evt.data.usage;
            if (u) {
              outputTokens = u.output_tokens ?? outputTokens;
              messageDeltaWithUsage = true;
            }
            // stop_reason → incompleteReason: позволяет chat.service показать
            // адресный мессадж юзеру (modelReasoningCapExhaustedAnthropic vs
            // generic modelTemporarilyUnavailable) когда стрим завершился без
            // visible text. Anthropic шлёт `max_tokens` когда reasoning + text
            // не уложились в max_output_tokens; `refusal` — content moderation
            // зарубила ответ ещё до первого text-блока. См. также openai.adapter.
            const stopReason = evt.data.delta?.stop_reason;
            if (typeof stopReason === "string") lastStopReason = stopReason;
            if (stopReason === "max_tokens") incompleteReason = "max_output_tokens";
            else if (stopReason === "refusal") incompleteReason = "content_filter";
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Gateway-пустота KIE/Evolink: HTTP 200 открыл стрим, но прокси закрыл
    // соединение БЕЗ терминального события (нет ни stop_reason, ни usage).
    // Это инфра-сбой прокси, а не легитимный «модель ответила пустотой» —
    // у легитимного был бы хотя бы `stop_reason` в message_delta.
    //
    // Бросаем 503 — `isFiveXxError` в chat.service триггерит штатный retry.
    // Поскольку reasoning буферизуется и НЕ yield'ится до первого text_delta,
    // на этот момент `chunks.length === 0` в chat.service гарантировано, и
    // retry/fallback flow реально сработает (а не уйдёт в chatStreamInterrupted).
    //
    // `!lastStopReason` — главный сторож от ложных срабатываний: если хоть
    // какой-то stop_reason пришёл (включая end_turn без usage), это легит.
    if (
      visibleChunks === 0 &&
      outputTokens === 0 &&
      !messageDeltaWithUsage &&
      !lastStopReason &&
      !incompleteReason
    ) {
      logger.warn(
        {
          modelId: this.modelId,
          apiModel: this.apiModel,
          provider: this.proxyConfig.providerLabel,
          streamDurationMs: Date.now() - streamStartedAt,
          inputTokens,
          eventTypeCounts,
          lastStopReason,
        },
        "claude-anthropic-proxy: gateway empty stream — escalating as 503 for retry",
      );
      const err = new Error(
        `${this.proxyConfig.providerLabel} Claude proxy returned empty stream (no message_delta)`,
      ) as Error & { status?: number };
      err.status = 503;
      throw err;
    }

    // Аномальный финал: модель завершила стрим с reasoning, но без visible.
    // Flush буфера на ЛЮБОЙ легитимный stop_reason кроме `refusal` (там
    // содержимое thinking — потенциально refusal-rationale, не показываем).
    // Покрытие: `max_tokens` (reasoning сожрал бюджет), `end_turn` (модель
    // решила не отвечать), `stop_sequence`/`tool_use`/`pause_turn` — редкие
    // но возможные кейсы. Flush ВСЕГДА (независимо от showReasoning): юзер
    // должен видеть свои размышления, иначе сообщение «модель не ответила»
    // необъяснимо. chat.service по `<think>` блокам узнает спец-кейс и
    // покажет `outputLimitOnlyThinking` / `modelOnlyThinking`.
    const isOnlyThinkingFinal =
      visibleChunks === 0 &&
      thinkingBuffer.length > 0 &&
      lastStopReason !== undefined &&
      lastStopReason !== "refusal";
    if (isOnlyThinkingFinal) {
      yield "<think>";
      yield thinkingBuffer;
      yield "</think>";
      thinkingBuffer = "";
    }

    // Триггер ровно совпадает с empty-guard'ом в chat.service.ts:
    // там тоже "0 visible chunks → пустой ответ юзеру". Если ужесточить
    // условие (например AND outputTokens===0), потеряем кейс когда Claude
    // потратил токены на thinking-блоки, но не выдал ни одного visible
    // дельта-чанка — а это как раз самый интересный случай для диагностики.
    if (visibleChunks === 0) {
      logger.warn(
        {
          modelId: this.modelId,
          apiModel: this.apiModel,
          provider: this.proxyConfig.providerLabel,
          streamDurationMs: Date.now() - streamStartedAt,
          inputTokens,
          outputTokens,
          eventTypeCounts,
          lastStopReason,
          messageDeltaWithUsage,
          incompleteReason,
        },
        "claude-anthropic-proxy: stream ended with no visible text",
      );
    }

    return {
      inputTokensUsed: inputTokens,
      outputTokensUsed: outputTokens,
      ...(cachedInputTokens > 0 ? { cachedInputTokensUsed: cachedInputTokens } : {}),
      ...(incompleteReason ? { incompleteReason } : {}),
      ...(lastStopReason ? { lastStopReason } : {}),
    };
  }

  private buildMessages(input: LLMInput): ProxyMessage[] {
    // Документы (PDF) сюда не приходят — chat.service инлайнит их текст
    // в input.prompt через documentTextExtractFallback. Образуем только
    // image-блоки. Изображения из истории (image/* attachments с presigned
    // url'ами) тоже re-attach'им как image-блоки на каждый turn.
    const history: ProxyMessage[] = (input.history ?? []).map((m: MessageRecord) => {
      const histImages = (m.attachments ?? []).filter(
        (a) => a.mimeType.startsWith("image/") && !!a.url,
      );
      if (histImages.length === 0) return { role: m.role, content: m.content };
      return {
        role: m.role,
        content: [
          ...histImages.map(
            (img): ProxyContentBlock => ({
              type: "image",
              source: { type: "url", url: img.url! },
            }),
          ),
          ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
        ],
      };
    });

    const urls = input.imageUrls?.length ? input.imageUrls : input.imageUrl ? [input.imageUrl] : [];

    const userContent: ProxyMessage["content"] =
      urls.length > 0
        ? [
            ...urls.map(
              (url): ProxyContentBlock => ({
                type: "image",
                source: { type: "url", url },
              }),
            ),
            ...(input.prompt ? [{ type: "text", text: input.prompt }] : []),
          ]
        : input.prompt;

    return [...history, { role: "user", content: userContent }];
  }
}

// ── SSE helpers ────────────────────────────────────────────────────────────

interface SseUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}
interface SseData {
  type: string;
  // delta может быть text_delta (visible) или thinking_delta (reasoning).
  // Оба идут внутри content_block_delta, отличает их поле type.
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
  message?: { usage?: SseUsage };
  usage?: SseUsage;
}

function parseSseEvent(raw: string): { event?: string; data?: SseData } | null {
  let data: SseData | undefined;
  let event: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return null;
      try {
        data = JSON.parse(payload) as SseData;
      } catch {
        return null;
      }
    }
  }
  return { event, data };
}

function handleVisibleDelta(d: SseData): string | null {
  if (d.type === "content_block_delta" && d.delta?.type === "text_delta" && d.delta.text) {
    return d.delta.text;
  }
  return null;
}

function handleThinkingDelta(d: SseData): string | null {
  if (d.type === "content_block_delta" && d.delta?.type === "thinking_delta" && d.delta.thinking) {
    return d.delta.thinking;
  }
  return null;
}
