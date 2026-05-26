import OpenAI, { type ClientOptions as OpenAIClientOptions } from "openai";
import { AI_MODELS } from "@metabox/shared";
import { calculateCost, calculateProviderCostUsd, deductTokens } from "./token.service.js";
import { logger } from "../logger.js";
import { isPoolExhaustedError } from "../utils/pool-exhausted-error.js";
import { buildProxyFetch } from "../ai/transport/proxy-fetch.js";
import { withKeyRetry } from "../utils/with-key-retry.js";

const TRANSLATE_MODEL_ID = "gpt-5-nano";
const SYSTEM_PROMPT =
  "You are a translator. Translate the user message into natural, concise English. " +
  "Preserve meaning, tone, named entities, numbers, and any technical terms. " +
  "Respond with ONLY the translated text — no commentary, no quotes.";

/**
 * Returns true when the prompt already looks like English (or is purely
 * numeric / punctuation / emoji). We check that every "letter" codepoint
 * falls within the Basic Latin range (A-Z, a-z). Non-letter characters
 * (digits, punctuation, whitespace, emoji) are ignored — they are
 * language-neutral and shouldn't force a translation call.
 */
export function looksEnglish(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // Skip ASCII non-letters, whitespace, and characters outside BMP letter
    // ranges (emoji, symbols, etc.) — only test actual letter codepoints.
    if (cp < 0x41) continue; // before 'A'
    if (cp <= 0x5a) continue; // A-Z
    if (cp < 0x61) continue; // between 'Z' and 'a' (punctuation)
    if (cp <= 0x7a) continue; // a-z
    if (cp < 0x80) continue; // remaining ASCII (DEL, etc.)
    // Any non-ASCII letter (Cyrillic, CJK, Arabic, etc.) → not English
    return false;
  }
  return true;
}

/**
 * If `modelSettings.auto_translate_prompt === true`, translates `prompt` to English
 * via `gpt-5-nano` and deducts the actual token-based cost from `userId`.
 * Returns the translated text on success, or the original prompt on any failure
 * (translation errors are swallowed so the primary generation still runs).
 *
 * Safe to call from both API services and worker processors.
 *
 * Ключ берётся из пула (provider="openai") через `withKeyRetry` — на 429 /
 * billing-error помечаем ключ throttled и пробуем следующий. Без ретрая
 * первый «неудачник», попавший на ключ-только-что-сдох, ронял авто-перевод,
 * а вслед за ним — всю генерацию картинки/видео.
 *
 * Если все ключи в пуле сдохли (`PoolExhaustedError`) — silent fallback на
 * оригинальный prompt. То же на любой не-rate-limit ошибке.
 *
 * `options.silent === true` — translation runs as usual, но `deductTokens` НЕ
 * вызывается: цена перевода ложится на бизнес и не светится в истории
 * транзакций юзера. Используется в готовых сценариях (object-removal и т.п.),
 * где перевод — внутренняя кухня сцены, и юзер не должен платить за него
 * отдельной строкой.
 */
export async function translatePromptIfNeeded(
  prompt: string,
  modelSettings: Record<string, unknown> | undefined,
  userId: bigint,
  forModel: string,
  options?: { silent?: boolean },
): Promise<string> {
  if (!modelSettings || modelSettings.auto_translate_prompt !== true) return prompt;
  if (looksEnglish(prompt)) return prompt;

  const model = AI_MODELS[TRANSLATE_MODEL_ID];
  if (!model) {
    logger.error({ TRANSLATE_MODEL_ID }, "Translator model missing from AI_MODELS");
    return prompt;
  }

  try {
    return await withKeyRetry("openai", async (acquired) => {
      const fetchFn = buildProxyFetch(acquired.proxy) ?? undefined;
      const client = new OpenAI({
        apiKey: acquired.apiKey,
        ...(fetchFn ? { fetch: fetchFn as unknown as OpenAIClientOptions["fetch"] } : {}),
      });
      const response = await (
        client.responses.create as (p: unknown) => Promise<OpenAI.Responses.Response>
      )({
        model: TRANSLATE_MODEL_ID,
        instructions: SYSTEM_PROMPT,
        input: prompt,
      });

      const translated = response.output_text?.trim();
      if (!translated) throw new Error("empty translation");

      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      const cost = calculateCost(model, inputTokens, outputTokens);
      if (cost > 0) {
        if (options?.silent) {
          // Silent mode (scenario-internal translation): билинг пропускаем —
          // юзер не должен видеть отдельную строку «autotranslate» в истории.
          // Логируем поглощённую стоимость для аудита/ops, чтобы видеть сколько
          // мы абсорбируем в сценариях.
          logger.info(
            {
              userId: userId.toString(),
              forModel,
              absorbedCost: cost,
              absorbedUsd: calculateProviderCostUsd(model, inputTokens, outputTokens),
              inputTokens,
              outputTokens,
            },
            "Auto-translate silent: cost absorbed by scenario",
          );
        } else {
          // Audit: автоперевод идёт через фиксированный TRANSLATE_MODEL_ID без
          // fallback'а — actualProvider = model.provider, raw USD по нему.
          const actualCostUsd = calculateProviderCostUsd(model, inputTokens, outputTokens);
          await deductTokens(userId, cost, forModel, undefined, "autotranslate", {
            actualProvider: model.provider,
            actualCostUsd,
          }).catch((err) => {
            logger.warn({ err, userId: userId.toString() }, "Failed to deduct translation cost");
          });
        }
      }

      return translated;
    });
  } catch (err) {
    if (isPoolExhaustedError(err)) {
      logger.warn({ err }, "Auto-translate skipped: OpenAI pool exhausted");
    } else {
      logger.warn({ err }, "Auto-translate failed, falling back to original prompt");
    }
    return prompt;
  }
}
