import { GoogleGenAI, type Content, type GenerateContentResponse, type Part } from "@google/genai";
import {
  BaseLLMAdapter,
  type LLMInput,
  type LLMOutput,
  type MessageRecord,
  type StreamResult,
} from "./base.adapter.js";
import { config } from "@metabox/shared";
import { fetchWithLog, logCall } from "../../utils/fetch.js";

const MODEL_MAP: Record<string, string> = {
  "gemini-2-flash": "gemini-2.5-flash",
  "gemini-2-flash-lite": "gemini-2.5-flash-lite",
  "gemini-2-pro": "gemini-2.5-pro",
  "gemini-3-pro": "gemini-3-pro-preview",
  "gemini-3.1-pro": "gemini-3.1-pro-preview",
};

/**
 * Google Gemini adapter (db_history strategy).
 * Sends last N messages from DB as chat history.
 */
export class GeminiAdapter extends BaseLLMAdapter {
  readonly contextStrategy = "db_history" as const;
  readonly contextMaxMessages: number;
  protected readonly modelId: string;

  private ai: GoogleGenAI;
  private apiModel: string;

  constructor(modelId: string, contextMaxMessages = 50, apiKey = config.ai.google) {
    super();
    this.modelId = modelId;
    this.ai = new GoogleGenAI({ apiKey: apiKey! });
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
    // History: re-attach images (если в attachments[] есть image/* с
    // presigned url'ом) как inlineData parts. Documents в Gemini не
    // прокидываем на history — текстовый контент уже инлайнится в content
    // через documentTextExtractFallback на стороне chat.service.
    const history: Content[] = await Promise.all(
      (input.history ?? []).map(async (m: MessageRecord) => {
        const histImages = (m.attachments ?? []).filter(
          (a) => a.mimeType.startsWith("image/") && !!a.url,
        );
        const imageParts: Part[] = await Promise.all(
          histImages.map(async (img) => ({
            inlineData: {
              mimeType: img.mimeType,
              data: await fetchImageAsBase64(img.url!),
            },
          })),
        );
        const parts: Part[] = [...imageParts, ...(m.content ? [{ text: m.content }] : [])];
        return {
          role: m.role === "assistant" ? "model" : "user",
          parts: parts.length > 0 ? parts : [{ text: m.content }],
        };
      }),
    );

    // Gemini 3 Pro семейство требует thinking mode (budget > 0). Если юзер
    // сохранил `thinking_budget: 0` (legacy default из старого слайдера) или
    // явно поставил 0 — Google API вернёт 400 "This model only works in thinking
    // mode". Coerce'им 0 в -1 (dynamic — модель сама выбирает бюджет).
    const requiresThinking = this.apiModel.startsWith("gemini-3");
    const effectiveThinkingBudget =
      requiresThinking && input.thinkingBudget === 0 ? -1 : input.thinkingBudget;

    // includeThoughts:true просим только когда юзер включил showReasoning И
    // у модели есть thinking-бюджет (>0 или -1). Без includeThoughts Gemini
    // не возвращает part'ы с thought:true, и user-side toggle становится
    // молчаливым no-op.
    const wantThoughts =
      input.showReasoning === true &&
      effectiveThinkingBudget !== undefined &&
      effectiveThinkingBudget !== 0;

    const chat = this.ai.chats.create({
      model: this.apiModel,
      history,
      config: {
        ...(input.systemPrompt ? { systemInstruction: input.systemPrompt } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxTokens !== undefined ? { maxOutputTokens: input.maxTokens } : {}),
        ...(effectiveThinkingBudget !== undefined
          ? {
              thinkingConfig: {
                thinkingBudget: effectiveThinkingBudget,
                ...(wantThoughts ? { includeThoughts: true } : {}),
              },
            }
          : {}),
      },
    });

    const urls = input.imageUrls?.length ? input.imageUrls : input.imageUrl ? [input.imageUrl] : [];

    const userParts: Part[] = urls.length
      ? [
          ...(input.prompt ? [{ text: input.prompt }] : []),
          ...(await Promise.all(
            urls.map(async (url) => ({
              inlineData: {
                mimeType: "image/jpeg",
                data: await fetchImageAsBase64(url),
              },
            })),
          )),
        ]
      : [{ text: input.prompt }];

    logCall(this.apiModel, "chatStream", {
      systemPrompt: input.systemPrompt,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      thinkingBudget: input.thinkingBudget,
      historyLength: history.length,
      imageCount: urls.length,
    });

    const stream = await chat.sendMessageStream({ message: userParts });

    let lastChunk: GenerateContentResponse | undefined;
    // <think>...</think> обёртка вокруг thought-парт'ов. chunk.text accessor
    // конкатенит ТОЛЬКО visible части (thought-part'ы исключаются), поэтому
    // когда мы хотим видеть размышления — переключаемся на ручной обход parts[].
    let inThinkBlock = false;

    for await (const chunk of stream) {
      lastChunk = chunk;
      if (!wantThoughts) {
        const text = chunk.text;
        if (text) yield text;
        continue;
      }
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        const text = (part as { text?: string }).text;
        if (!text) continue;
        const isThought = (part as { thought?: boolean }).thought === true;
        if (isThought) {
          if (!inThinkBlock) {
            inThinkBlock = true;
            yield "<think>";
          }
          yield text;
        } else {
          if (inThinkBlock) {
            inThinkBlock = false;
            yield "</think>";
          }
          yield text;
        }
      }
    }
    if (inThinkBlock) yield "</think>";

    const usage = lastChunk?.usageMetadata;
    return {
      inputTokensUsed: usage?.promptTokenCount ?? 0,
      outputTokensUsed: usage?.candidatesTokenCount ?? 0,
    };
  }
}

async function fetchImageAsBase64(url: string): Promise<string> {
  const res = await fetchWithLog(url);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}
