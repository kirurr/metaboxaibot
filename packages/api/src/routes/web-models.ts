/**
 * /web/models — каталог моделей для packages/web.
 *
 * Использует только `webAuthPreHandler`, без требования привязанного Telegram —
 * каталог не зависит от пользователя, его видно даже если юзер ещё не дошёл до
 * шага линковки. Telegram-only endpoints (баланс, история) и так
 * заблокированы 403 TELEGRAM_NOT_LINKED.
 *
 * Шейп ответа намеренно компактнее, чем у `/models` (миниапа) — фронту web не
 * нужны costMatrix/costAddons/режимы целиком, нужны: id/имя/секция/провайдер,
 * базовая стоимость в токенах и поддерживаемые параметры (aspect ratios /
 * durations) для страниц Image/Video/Audio.
 */

import type { FastifyPluginAsync } from "fastify";
import { AI_MODELS, MODELS_BY_SECTION, MODEL_FAMILIES, type Section } from "@metabox/shared";
import { webAuthPreHandler } from "../middlewares/web-auth.js";
import { calculateCost } from "../services/token.service.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

const TYPICAL_INPUT_TOKENS = 500;
const TYPICAL_OUTPUT_TOKENS = 500;

function serializeForWeb(m: (typeof AI_MODELS)[string]) {
  const isLLM = m.inputCostUsdPerMToken > 0;
  const isPerMPixel = (m.costUsdPerMPixel ?? 0) > 0;
  const isPerMVideoToken = (m.costUsdPerMVideoToken ?? 0) > 0;
  const isPerSecond = (m.costUsdPerSecond ?? 0) > 0;
  const isPerKChar = m.costUsdPerKChar !== undefined;
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    section: m.section,
    // claude-прокси нормализуем под бренд anthropic для каталога. См. routes/models.ts.
    provider:
      m.provider === "kie-claude" || m.provider === "evolink-claude" ? "anthropic" : m.provider,
    familyId: m.familyId ?? null,
    familyName: m.familyId ? (MODEL_FAMILIES[m.familyId]?.name ?? null) : null,
    versionLabel: m.versionLabel ?? null,
    variantLabel: m.variantLabel ?? null,
    descriptionOverride: m.descriptionOverride ?? null,
    supportsImages: m.supportsImages,
    supportsDocuments: m.supportsDocuments ?? false,
    supportsVoice: m.supportsVoice,
    supportsWeb: m.supportsWeb,
    isAsync: m.isAsync,
    isLLM,
    supportedAspectRatios: m.supportedAspectRatios ?? null,
    supportedDurations: m.supportedDurations ?? null,
    durationRange: m.durationRange ?? null,
    /** Базовая стоимость 1 запроса/среднего сообщения в токенах. UI показывает рядом с моделью. */
    tokenCostApprox: isLLM
      ? calculateCost(m, TYPICAL_INPUT_TOKENS, TYPICAL_OUTPUT_TOKENS)
      : isPerMPixel
        ? calculateCost(m, 0, 0, 1)
        : isPerSecond
          ? calculateCost(m, 0, 0, undefined, undefined, undefined, 1)
          : isPerMVideoToken
            ? calculateCost(m, 0, 0, undefined, 1_000_000)
            : isPerKChar
              ? calculateCost(m, 0, 0, undefined, undefined, undefined, undefined, 1000)
              : calculateCost(m),
    /** Единица измерения стоимости. UI рендерит «≈ 1.2k / msg», «≈ 900 / image» и т.п. */
    tokenCostUnit: isLLM
      ? ("msg" as const)
      : isPerMPixel
        ? ("mpx" as const)
        : isPerSecond
          ? ("second" as const)
          : isPerMVideoToken
            ? ("mvideotoken" as const)
            : isPerKChar
              ? ("kchar" as const)
              : ("request" as const),
  };
}

export type WebModelDto = ReturnType<typeof serializeForWeb>;

export const webModelsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", webAuthPreHandler);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["web-models"]));

  /** GET /web/models?section=image — список моделей опц. фильтрованный по секции. */
  fastify.get<{ Querystring: { section?: string } }>(
    "/web/models",
    {
      schema: {
        description: "Get AI models catalog for web UI, optionally filtered by section",
        querystring: {
          type: "object",
          properties: {
            section: {
              type: "string",
              description: "Filter by section: gpt | design | video | audio",
            },
          },
        },
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              // `additionalProperties: true` нужен, иначе fastify-serializer стирает
              // вложенные nullable-объекты (`durationRange.min/max` и т.п.).
              additionalProperties: true,
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                description: { type: "string" },
                section: { type: "string" },
                provider: { type: "string" },
                familyId: { type: "string", nullable: true },
                familyName: { type: "string", nullable: true },
                versionLabel: { type: "string", nullable: true },
                variantLabel: { type: "string", nullable: true },
                descriptionOverride: { type: "string", nullable: true },
                supportsImages: { type: "boolean" },
                supportsDocuments: { type: "boolean" },
                supportsVoice: { type: "boolean" },
                supportsWeb: { type: "boolean" },
                isAsync: { type: "boolean" },
                isLLM: { type: "boolean" },
                supportedAspectRatios: { type: "array", nullable: true },
                supportedDurations: { type: "array", nullable: true },
                durationRange: { type: "object", nullable: true, additionalProperties: true },
                tokenCostApprox: { type: "number" },
                tokenCostUnit: { type: "string" },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { section } = request.query;
      const all = section
        ? (MODELS_BY_SECTION[section as Section] ?? [])
        : Object.values(AI_MODELS);
      // hiddenFromCarousel-модели активируются только в спец-сценариях (например
      // «продлить» grok-imagine-extend) и не должны попадать в каталог UI.
      return all.filter((m) => !m.hiddenFromCarousel).map(serializeForWeb);
    },
  );
};
