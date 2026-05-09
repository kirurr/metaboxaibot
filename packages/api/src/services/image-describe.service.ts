import { AI_MODELS } from "@metabox/shared";
import { GeminiAdapter } from "../ai/llm/gemini.adapter.js";
import { calculateCost, calculateProviderCostUsd, deductTokens } from "./token.service.js";
import { logger } from "../logger.js";

const DESCRIBE_MODEL_ID = "gemini-2-flash";
const SYSTEM_PROMPT =
  "You are a precise visual describer. Look at the provided image and produce a single, " +
  "richly detailed description suitable for use as a text-to-image prompt. Cover: subject, " +
  "pose, clothing, materials, setting, lighting, camera framing, and overall mood. " +
  "For the most prominent objects/garments/elements, append the dominant color in #RRGGBB hex " +
  "in parentheses, e.g. 'red leather jacket (#7A1F1F)'. Output only the description — no headers, " +
  "no bullet points, no commentary.";

/**
 * Describes an image using a cheap vision LLM (Gemini Flash) and returns the description string.
 * The description is intended to be used as a text-to-image generation prompt.
 *
 * Token cost is deducted from `userId` based on the LLM's usage; failures during deduction
 * are logged but do not prevent the description from being returned.
 */
export async function describeImageForPrompt(
  userId: bigint,
  imageUrl: string,
  forModel: string,
): Promise<string> {
  const model = AI_MODELS[DESCRIBE_MODEL_ID];
  if (!model) throw new Error(`Describe model missing from AI_MODELS: ${DESCRIBE_MODEL_ID}`);

  const adapter = new GeminiAdapter(DESCRIBE_MODEL_ID, 0);
  let inputTokens = 0;
  let outputTokens = 0;
  const chunks: string[] = [];

  const stream = adapter.chatStream({
    prompt: "Describe this image for use as an image-generation prompt.",
    systemPrompt: SYSTEM_PROMPT,
    imageUrl,
  });

  while (true) {
    const next = await stream.next();
    if (next.done) {
      inputTokens = next.value?.inputTokensUsed ?? 0;
      outputTokens = next.value?.outputTokensUsed ?? 0;
      break;
    }
    chunks.push(next.value);
  }

  const description = chunks.join("").trim();
  if (!description) throw new Error("Describe model returned empty description");

  const cost = calculateCost(model, inputTokens, outputTokens);
  if (cost > 0) {
    // Audit: describe-image идёт через тот же модельный provider — fallback'а
    // на этом hot-path нет, actualProvider = model.provider.
    const actualCostUsd = calculateProviderCostUsd(model, inputTokens, outputTokens);
    await deductTokens(userId, cost, forModel, undefined, "describe_image", {
      actualProvider: model.provider,
      actualCostUsd,
    }).catch((err) => {
      logger.warn({ err, userId: userId.toString() }, "Failed to deduct describe-image cost");
    });
  }

  return description;
}
