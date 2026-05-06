import {
  BaseLLMAdapter,
  type LLMInput,
  type LLMOutput,
  type MessageRecord,
  type StreamResult,
} from "./base.adapter.js";
import { config } from "@metabox/shared";
import { logCall } from "../../utils/fetch.js";

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
    input = this.truncateInput(input);
    const messages = this.buildMessages(input);

    // Extended thinking требует max_tokens >= ~16k (как у нативного Anthropic).
    const maxTokens = input.extendedThinking
      ? Math.max(input.maxTokens ?? 16000, 16000)
      : (input.maxTokens ?? 4096);

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
          const parsed = JSON.parse(text) as { error?: { type?: string } };
          const errType = parsed?.error?.type;
          if (errType === "api_error" || errType === "overloaded_error") {
            effectiveStatus = 503;
          } else if (errType === "rate_limit_error") {
            effectiveStatus = 429;
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

          const text = handleEvent(evt.data, (delta) => delta);
          if (text) yield text;

          // Извлекаем токены из служебных событий.
          const t = evt.data.type;
          if (t === "message_start") {
            const u = evt.data.message?.usage;
            if (u) {
              inputTokens = u.input_tokens ?? inputTokens;
              cachedInputTokens = u.cache_read_input_tokens ?? cachedInputTokens;
            }
          } else if (t === "message_delta") {
            const u = evt.data.usage;
            if (u) outputTokens = u.output_tokens ?? outputTokens;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      inputTokensUsed: inputTokens,
      outputTokensUsed: outputTokens,
      ...(cachedInputTokens > 0 ? { cachedInputTokensUsed: cachedInputTokens } : {}),
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
  delta?: { type?: string; text?: string };
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

function handleEvent(d: SseData, pickText: (s: string) => string): string | null {
  if (d.type === "content_block_delta" && d.delta?.type === "text_delta" && d.delta.text) {
    return pickText(d.delta.text);
  }
  return null;
}
