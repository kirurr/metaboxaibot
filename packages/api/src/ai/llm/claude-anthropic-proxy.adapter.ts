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
 * Внутренний modelId → API-имя модели у провайдера.
 *
 * COMMON_MODEL_MAP — alias-имена Anthropic (без snapshot-даты). Подходят
 * провайдерам, которые принимают canonical Anthropic-aliases (KIE и сам
 * Anthropic).
 *
 * EVOLINK_MODEL_OVERRIDES — Evolink в model registry держит часть моделей
 * только под полным snapshot-именем (с датой). На короткий alias возвращает
 * `invalid_request: No available service for model 'X'`. Подтверждённый список
 * (по состоянию на 2026-05-11):
 *   - claude-haiku-4-5-20251001  (alias `claude-haiku-4-5` НЕ работает)
 *   - claude-sonnet-4-5-20250929
 *   - claude-opus-4-1-20250805
 *   - claude-sonnet-4-20250514
 *   - claude-opus-4-5-20251101
 *   - claude-opus-4-6      (alias OK)
 *   - claude-opus-4-7      (alias OK)
 *   - claude-sonnet-4-6    (alias OK)
 *
 * Поэтому в override пробрасываем только haiku, opus/sonnet остаются по alias'у.
 */
const COMMON_MODEL_MAP: Record<string, string> = {
  "claude-opus": "claude-opus-4-6",
  "claude-sonnet": "claude-sonnet-4-6",
  "claude-haiku": "claude-haiku-4-5",
};

const EVOLINK_MODEL_OVERRIDES: Record<string, string> = {
  "claude-haiku": "claude-haiku-4-5-20251001",
};

function resolveApiModel(modelId: string, providerKey: string): string {
  if (providerKey === "evolink-claude") {
    return EVOLINK_MODEL_OVERRIDES[modelId] ?? COMMON_MODEL_MAP[modelId] ?? modelId;
  }
  return COMMON_MODEL_MAP[modelId] ?? modelId;
}

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
    this.apiModel = resolveApiModel(modelId, providerKey);
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
      // Подавление tool-use инжекции от KIE: они проксируют через Claude.ai
      // endpoint, у которого по умолчанию доступны Agent Skills (`view`,
      // `frontend-design` и т.п.). Модель видит их в контексте и на запросах
      // тематически близких (визуальная концепция, архитектура и т.п.)
      // вызывает `view` на skill-файл вместо ответа текстом — стрим выглядит
      // пустым, юзер получает «не в духе».
      //
      // Два независимых барьера в одном теле запроса:
      //  1. `tools: []` — explicit signal что у нас НЕТ доступных инструментов.
      //     Если KIE форвардит наше поле к Anthropic — модель физически не
      //     имеет tools. Если KIE стрипает / мерджит — возможно стэкнется с их
      //     инжекцией, но как минимум посылает им сигнал что мы не хотим tools.
      //  2. `tool_choice: { type: "none" }` — документированное Anthropic поле,
      //     запрещающее модели вызывать любые tools в этом turn'е (даже если
      //     они есть в контексте от KIE-инжекции). Идёт ВМЕСТЕ с `tools: []` —
      //     это легитимный Anthropic-сценарий «есть массив (пустой), запрещаю
      //     использовать», без риска 400 «tool_choice without tools».
      //
      // function-calling у нас в принципе не используется — это no-op для
      // легитимных сценариев. Если эта связка не помогла — следующий шаг это
      // полная обработка tool_use блоков (буферизация → follow-up с
      // tool_result → продолжение стрима).
      tools: [],
      tool_choice: { type: "none" },
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

    // Snapshot response headers сразу после fetch'а — нужны для
    // диагностических warn'ов ниже. Прокси-поддержка (KIE/Evolink) не находит
    // запросы по `message.id` из SSE payload (это, видимо, ID их upstream
    // типа z.ai, не их собственный tracking-key). Их internal lookup-ключ
    // обычно в HTTP-headers (x-request-id / cf-ray / x-kie-* / anthropic-*) —
    // снепшот ниже даёт нам этот ID для последующего пробирования в support.
    // На успешных запросах эти headers нигде не логируются, шума нет.
    //
    // Sensitive denylist: пропускаем `set-cookie`/`authorization`/`cookie`/
    // `proxy-authorization` — теоретически прокси может эхать в response
    // session-token или другую creds, не хотим тащить такое в ops-логи.
    const SENSITIVE_HEADERS = new Set([
      "set-cookie",
      "cookie",
      "authorization",
      "proxy-authorization",
    ]);
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (!SENSITIVE_HEADERS.has(k.toLowerCase())) {
        responseHeaders[k] = v;
      }
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
    // KIE injects built-in tool `view` (skill-reader) into /claude/v1/messages
    // requests without opt-in, and silently strips our `tool_choice: none`
    // защитное поле — оно не описано в их OpenAPI spec. Observed pattern:
    //   1. content_block index=0, type=text, delta=" "          ← один пробел
    //   2. content_block index=1, type=thinking                 ← план чтения skill
    //   3. content_block index=2, type=tool_use, name=view      ← KIE-инжект
    //   4. message_delta stop_reason=tool_use
    // Если yield'нуть пробел сразу — `chunks.length=1` в chat.service блокирует
    // fallback на evolink-claude через `chunks.length===0` guard. Поэтому
    // буферизуем первый whitespace-only visible content до момента когда
    // станет ясно: появилось ли meaningful содержимое (→ flush + streaming-режим)
    // или это был skill-tool dead-end (→ дропаем буфер + throw 503 для fallback).
    let pendingVisibleBuffer = "";
    let visibleStreamingStarted = false;
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

    // Diagnostic capture: последние N сырых SSE-событий + сэмпл yielded visible
    // текста. Нужно чтобы при ambiguous-финале (KIE-прокси шлёт фейковый usage
    // без content-блоков и без stop_reason; модель шлёт visible с whitespace
    // или literal `<think>` тегом) можно было по логам понять что реально
    // прислал провайдер, не воспроизводя руками. Включается ТОЛЬКО в
    // warn-логе ниже — на горячий путь yield'ов не влияет.
    const rawEventSamples: Array<{ event?: string; data: unknown }> = [];
    const MAX_EVENT_SAMPLES = 50;
    const captureRawEvent = (evt: { event?: string; data?: SseData }): void => {
      if (rawEventSamples.length >= MAX_EVENT_SAMPLES) return;
      const d = evt.data;
      if (!d || typeof d !== "object") {
        rawEventSamples.push({ event: evt.event, data: d });
        return;
      }
      const out: Record<string, unknown> = { ...(d as unknown as Record<string, unknown>) };
      if (d.delta && typeof d.delta === "object") {
        const delta: Record<string, unknown> = { ...d.delta };
        if (typeof delta.text === "string" && (delta.text as string).length > 200) {
          delta.text = `${(delta.text as string).slice(0, 200)}…[+${(delta.text as string).length - 200}]`;
        }
        if (typeof delta.thinking === "string" && (delta.thinking as string).length > 200) {
          delta.thinking = `${(delta.thinking as string).slice(0, 200)}…[+${(delta.thinking as string).length - 200}]`;
        }
        out.delta = delta;
      }
      rawEventSamples.push({ event: evt.event, data: out });
    };
    let visibleTextSample = "";
    let visibleTextTotalLen = 0;
    const MAX_VISIBLE_SAMPLE = 500;

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
          captureRawEvent(evt);

          // text_delta → visible. Если в буфере накоплен reasoning И юзер
          //   хочет его видеть — yield `<think>...</think>` ПЕРЕД visible.
          //   При showReasoning=false просто очищаем буфер без yield.
          // thinking_delta → reasoning. ВСЕГДА копим в буфер (см. комментарий
          //   выше). Гейт на showReasoning стоит только на yield'е.
          const visibleText = handleVisibleDelta(evt.data);
          if (visibleText) {
            if (!visibleStreamingStarted) {
              // Pre-streaming: накапливаем visible content в буфере. Yield'им
              // только когда появится non-whitespace — иначе chat-сервис посчитает
              // " " как полноценный chunk и заблокирует fallback на evolink
              // при KIE-инжекте skill-tool'а (см. комментарий у объявления
              // pendingVisibleBuffer).
              pendingVisibleBuffer += visibleText;
              if (pendingVisibleBuffer.trim().length > 0) {
                const flushText = pendingVisibleBuffer;
                pendingVisibleBuffer = "";
                visibleStreamingStarted = true;
                if (thinkingBuffer.length > 0) {
                  if (input.showReasoning) {
                    yield "<think>";
                    yield thinkingBuffer;
                    yield "</think>";
                  }
                  thinkingBuffer = "";
                }
                visibleChunks++;
                visibleTextTotalLen += flushText.length;
                if (visibleTextSample.length < MAX_VISIBLE_SAMPLE) {
                  visibleTextSample += flushText.slice(
                    0,
                    MAX_VISIBLE_SAMPLE - visibleTextSample.length,
                  );
                }
                yield flushText;
              }
              // else: только whitespace в буфере — продолжаем без yield,
              // но event-processing ниже (eventTypeCounts, message_delta usage)
              // не пропускаем.
            } else {
              if (thinkingBuffer.length > 0) {
                if (input.showReasoning) {
                  yield "<think>";
                  yield thinkingBuffer;
                  yield "</think>";
                }
                thinkingBuffer = "";
              }
              visibleChunks++;
              visibleTextTotalLen += visibleText.length;
              if (visibleTextSample.length < MAX_VISIBLE_SAMPLE) {
                visibleTextSample += visibleText.slice(
                  0,
                  MAX_VISIBLE_SAMPLE - visibleTextSample.length,
                );
              }
              yield visibleText;
            }
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

    // KIE инжектит built-in инструмент `view` (skill-reader) в наши запросы
    // в обход client-side `tool_choice: { type: "none" }`. Stop_reason=tool_use
    // без meaningful visible content = модель потратила токены на «прочитать
    // skill» из инжектированного prompt'а и не ответила юзеру. См. описание
    // паттерна в pendingVisibleBuffer комментарии выше + kie-support-claim.md
    // в корне репо.
    //
    // Условие: stop_reason=tool_use И streaming так и не начался (буфер либо
    // пустой, либо только whitespace). Если streaming уже шёл — у юзера есть
    // полезный content, retry/fallback ломал бы continuity, оставляем как есть.
    //
    // Throw 503 → isFiveXxError в chat.service → trySwitchToFallbackProvider
    // → evolink-claude (другой прокси, не инжектит skills).
    //
    // Thinking-буфер НЕ флашим: юзеру бесполезен план «сейчас прочитаю
    // frontend-design skill» (см. лог-сэмплы) — это про KIE-инжект, не про
    // его запрос. Дропаем тихо.
    if (
      lastStopReason === "tool_use" &&
      !visibleStreamingStarted &&
      pendingVisibleBuffer.trim().length === 0
    ) {
      logger.warn(
        {
          modelId: this.modelId,
          apiModel: this.apiModel,
          provider: this.proxyConfig.providerLabel,
          streamDurationMs: Date.now() - streamStartedAt,
          inputTokens,
          outputTokens,
          pendingVisibleBufferLen: pendingVisibleBuffer.length,
          thinkingBufferLen: thinkingBuffer.length,
          eventTypeCounts,
          responseHeaders,
        },
        "claude-anthropic-proxy: stop_reason=tool_use with no visible content (KIE injected built-in tool) — escalating as 503 for fallback",
      );
      const err = new Error(
        `${this.proxyConfig.providerLabel} Claude proxy injected built-in tool (stop_reason=tool_use, no visible content)`,
      ) as Error & { status?: number };
      err.status = 503;
      throw err;
    }

    // Whitespace-only буфер на легитимном stop_reason (end_turn / max_tokens
    // и т.п.): дропаем чтобы visibleChunks остался 0 и isOnlyThinkingFinal
    // ниже сработал штатно (юзер увидит «модель только подумала» вместо
    // generic «временно недоступна» когда thinking есть).
    if (pendingVisibleBuffer.length > 0) {
      pendingVisibleBuffer = "";
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
          responseHeaders,
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

    // Диагностический warn на «неоднозначный финал стрима». Расширен по
    // сравнению с прежней проверкой `visibleChunks === 0`, чтобы также
    // ловить кейс когда visible-чанки эмитились, но их содержимое
    // chat.service выкинет как пустоту (whitespace-only ИЛИ literal
    // `<think>...</think>` тег, который `stripThinkingBlocks` срежет). И
    // отдельно — финал без `stop_reason` и без `incompleteReason`: это
    // прокси-аномалия (KIE/Evolink), важно её ловить ДО того как
    // chat.service выкатит юзеру generic «модель временно недоступна».
    //
    // Лог несёт `rawEventSamples` (до 50 последних событий с обрезанными
    // text/thinking-полями) и `visibleTextSample` (первые ~500 символов
    // всех yielded visible-чанков). Этого достаточно чтобы по логам понять
    // что реально присылает прокси, не воспроизводя руками.
    const trimmedVisibleSample = visibleTextSample.trim();
    const finishLooksAmbiguous = !lastStopReason && !incompleteReason;
    const visibleLooksEmpty =
      visibleChunks === 0 || (visibleTextTotalLen > 0 && trimmedVisibleSample.length === 0);
    const visibleLooksLikeThinkLiteral =
      visibleChunks > 0 && trimmedVisibleSample.startsWith("<think>");
    if (finishLooksAmbiguous || visibleLooksEmpty || visibleLooksLikeThinkLiteral) {
      logger.warn(
        {
          modelId: this.modelId,
          apiModel: this.apiModel,
          provider: this.proxyConfig.providerLabel,
          streamDurationMs: Date.now() - streamStartedAt,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          visibleChunks,
          visibleTextTotalLen,
          visibleTextSample,
          thinkingBufferLen: thinkingBuffer.length,
          eventTypeCounts,
          lastStopReason,
          messageDeltaWithUsage,
          incompleteReason,
          finishLooksAmbiguous,
          visibleLooksEmpty,
          visibleLooksLikeThinkLiteral,
          rawEventSamples,
          responseHeaders,
        },
        "claude-anthropic-proxy: stream-state diagnostic (raw events captured)",
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
