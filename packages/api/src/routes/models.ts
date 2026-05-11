import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  AI_MODELS,
  MODEL_FAMILIES,
  MODELS_BY_SECTION,
  getResolvedModes,
  defaultModeId,
  getT,
  type AIModel,
  type Language,
} from "@metabox/shared";
import { calculateCost, usdToTokens } from "../services/token.service.js";
import { getModelMultiplier } from "../services/pricing-config.service.js";
import { db } from "../db.js";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

/** USD → tokens с применением per-model multiplier (единый шаблон с calculateCost). */
function modelUsdToTokens(modelId: string, usd: number): number {
  // Без округления — фронт форматирует через toFixed(2). Округление здесь
  // распухало бы дробные cost matrix-ячейки (например, 0.012 → 1).
  return usdToTokens(usd) * getModelMultiplier(modelId);
}

type AuthRequestM = FastifyRequest & { userId: bigint };

/** Typical message size used for LLM cost estimation */
const TYPICAL_INPUT_TOKENS = 500;
const TYPICAL_OUTPUT_TOKENS = 500;

function serializeModel(m: AIModel, lang: Language) {
  const isLLM = m.inputCostUsdPerMToken > 0;
  const isPerMPixel = (m.costUsdPerMPixel ?? 0) > 0;
  const isPerMVideoToken = (m.costUsdPerMVideoToken ?? 0) > 0;
  const isPerSecond = (m.costUsdPerSecond ?? 0) > 0;
  const isPerKChar = m.costUsdPerKChar !== undefined;
  const t = getT(lang);
  const resolvedModes = getResolvedModes(m);
  const modes = resolvedModes
    ? resolvedModes.map((mode) => ({
        id: mode.id,
        label: String((t.modelModes as Record<string, string>)[mode.labelKey] ?? mode.labelKey),
        textOnly: mode.textOnly ?? false,
        default: mode.id === defaultModeId(resolvedModes),
      }))
    : null;
  return {
    /** Operation modes (e.g. t2v, i2v, r2v) — null if model has no modes. */
    modes,
    /** Family id this model belongs to, null for standalone models. */
    familyId: m.familyId ?? null,
    /** Display name of the family (includes emoji), null for standalone models. */
    familyName: m.familyId ? (MODEL_FAMILIES[m.familyId]?.name ?? null) : null,
    /** Default model ID for the family (used to pre-select variant before activation). */
    familyDefaultModelId: m.familyId ? (MODEL_FAMILIES[m.familyId]?.defaultModelId ?? null) : null,
    /** Version label within the family, e.g. "v3", "v4". */
    versionLabel: m.versionLabel ?? null,
    /** Variant label within the family, e.g. "Standard", "Pro". */
    variantLabel: m.variantLabel ?? null,
    /** Per-variant description override (replaces family description when set). */
    descriptionOverride: m.descriptionOverride ?? null,
    id: m.id,
    name: m.name,
    description: m.description,
    section: m.section,
    // Нормализуем claude-прокси (kie-claude / evolink-claude) → anthropic для
    // клиентов: provider — это бренд в UI/каталоге, а не путь до API. Прокси-
    // провайдеры используются только внутри фабрики LLM и резолвере ключей.
    provider:
      m.provider === "kie-claude" || m.provider === "evolink-claude" ? "anthropic" : m.provider,
    supportsImages: m.supportsImages,
    supportsDocuments: m.supportsDocuments ?? false,
    supportsVoice: m.supportsVoice,
    supportsWeb: m.supportsWeb,
    isAsync: m.isAsync,
    supportedAspectRatios: m.supportedAspectRatios ?? null,
    supportedDurations: m.supportedDurations ?? null,
    durationRange: m.durationRange ?? null,
    /** Fixed cost per request in internal tokens (0 for LLM, per-MP, and per-video-token models) */
    tokenCostPerRequest: isLLM || isPerMPixel || isPerMVideoToken ? 0 : calculateCost(m),
    /** Estimated cost per message in internal tokens (LLM only, based on typical msg size) */
    tokenCostApproxMsg: isLLM ? calculateCost(m, TYPICAL_INPUT_TOKENS, TYPICAL_OUTPUT_TOKENS) : 0,
    /** Cost per megapixel in internal tokens (only for per-megapixel billing models, e.g. FLUX) */
    tokenCostPerMPixel: isPerMPixel ? calculateCost(m, 0, 0, 1) : 0,
    /**
     * Cost per 1M video tokens in internal tokens (only for per-video-token billing models, e.g. Seedance).
     * videoTokens = (width × height × fps × duration) / 1024
     */
    tokenCostPerMVideoToken: isPerMVideoToken ? calculateCost(m, 0, 0, undefined, 1_000_000) : 0,
    /** FPS used in video token calculation (only for per-video-token billing models). */
    videoFps: m.videoFps ?? 0,
    /** Cost per second in internal tokens (only for per-second billing models, e.g. Kling, Pika). */
    tokenCostPerSecond: isPerSecond
      ? calculateCost(m, 0, 0, undefined, undefined, undefined, 1)
      : 0,
    /** Cost per 1K characters in internal tokens (only for per-kchar billing models, e.g. TTS). */
    tokenCostPerKChar: isPerKChar
      ? calculateCost(m, 0, 0, undefined, undefined, undefined, undefined, 1000)
      : 0,
    isLLM,
    /** Configurable generation parameters. Empty array if none. */
    settings: m.settings ?? [],
    /**
     * Multi-dimensional cost table (internal tokens) for models where price depends on 2+ settings.
     * e.g. gpt-image-1.5: quality × size. null for models without multi-dim pricing.
     */
    costMatrix: m.costMatrix
      ? {
          dims: m.costMatrix.dims,
          table: Object.fromEntries(
            Object.entries(m.costMatrix.table).map(([k, v]) => [k, modelUsdToTokens(m.id, v)]),
          ),
        }
      : null,
    /**
     * Token cost per variant value (only for models with costVariants).
     * Per-second models: tokens per 1 second for each variant.
     * Per-request models: total tokens per request for each variant.
     * null if model has no costVariants.
     */
    tokenCostVariants:
      !isLLM && !isPerMPixel && !isPerMVideoToken && m.costVariants
        ? {
            settingKey: m.costVariants.settingKey,
            map: Object.fromEntries(
              Object.keys(m.costVariants.map).map((k) => [
                k,
                calculateCost(
                  m,
                  0,
                  0,
                  undefined,
                  undefined,
                  { [m.costVariants!.settingKey]: k },
                  isPerSecond ? 1 : undefined,
                  isPerKChar ? 1000 : undefined,
                ),
              ]),
            ),
          }
        : null,
    /**
     * Additive token cost per setting value (only for models with costAddons).
     * Frontend sums these on top of the base cost.
     * null if model has no costAddons.
     */
    tokenCostAddons: m.costAddons?.length
      ? m.costAddons.map((addon) => ({
          settingKey: addon.settingKey,
          map: Object.fromEntries(
            Object.entries(addon.map).map(([k, v]) => [k, modelUsdToTokens(m.id, v as number)]),
          ),
        }))
      : null,
  };
}

export const modelsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["models"]),
  );

  /** GET /models?section=gpt — list all models or filter by section */
  fastify.get<{ Querystring: { section?: string } }>("/models", {
    schema: {
      description: "Get all models or filter by section",
      querystring: { type: "object", properties: { section: { type: "string", description: "Filter by section (e.g., gpt, image)" } } },
      response: { 200: { type: "array", items: { type: "object" } } },
    },
  }, async (request) => {
    const { userId } = request as AuthRequestM;
    const { section } = request.query;
    const user = await db.user.findUnique({ where: { id: userId }, select: { language: true } });
    const lang = (user?.language ?? "en") as Language;

    const allModels = section ? (MODELS_BY_SECTION[section] ?? []) : Object.values(AI_MODELS);
    // Скрытые модели (например, `grok-imagine-extend`) активируются только
    // через спец-сценарии (кнопка «Продлить») и не должны показываться в
    // обычном webapp-списке моделей.
    const models = allModels.filter((m) => !m.hiddenFromCarousel);

    return models.map((m) => serializeModel(m, lang));
  });
};
