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

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  AI_MODELS,
  MODELS_BY_SECTION,
  MODEL_FAMILIES,
  SUPPORTED_LANGUAGES,
  getResolvedModes,
  defaultModeId,
  getT,
  type Section,
  type Language,
} from "@metabox/shared";

// Set для O(1)-валидации `?lang=` query param. Без проверки `langOverride as Language`
// мог бы прокинуть мусор в getT() — getT() сам бы вернул en-фоллбэк, но юзер бы
// не понял почему его явный `?lang=fr` молча проигнорирован.
const SUPPORTED_LANG_SET = new Set<string>(SUPPORTED_LANGUAGES);
import { webAuthPreHandler } from "../middlewares/web-auth.js";
import { calculateCost } from "../services/token.service.js";
import { db } from "../db.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

// Approx стоимость LLM считаем за 1000 токенов сообщения, разбитых 50/50
// input/output. Это даёт нейтральную оценку, не перекошенную ни в сторону
// моделей с дорогим output, ни в сторону cached-input скидок. UI рисует
// результат как «≈ X.XX ✦ / 1k tok» (см. Chat.tsx → modelRate()).
const APPROX_INPUT_TOKENS_PER_1K = 500;
const APPROX_OUTPUT_TOKENS_PER_1K = 500;

// hiddenFromCarousel-модели в общий каталог не попадают (см. фильтр ниже), но
// некоторые из них веб активирует через URL-пресеты (`/image/upscale` и т.п.,
// см. packages/web/src/config/presets.ts). Такие модели отдаём в каталог точечно,
// а на клиенте они скрыты из дефолтных списков по флагу `hiddenFromCarousel`.
export const WEB_PRESET_MODEL_IDS = new Set<string>([
  "image-upscale",
  "bg-removal",
  "face-swap-classic",
  "clothing-tryon",
  "object-removal",
  "photo-create",
  "photo-animate",
  "video-upscale",
]);

function serializeForWeb(m: (typeof AI_MODELS)[string], lang: Language) {
  const t = getT(lang);
  // Modes (operation modes — t2v/i2v/r2v и т.п.). Резолвим labelKey в локаль,
  // null = у модели нет режимов (значит и таб-переключателя в UI не будет).
  const resolvedModes = getResolvedModes(m);
  const modes = resolvedModes
    ? resolvedModes.map((mode) => ({
        id: mode.id,
        label: String((t.modelModes as Record<string, string>)[mode.labelKey] ?? mode.labelKey),
        slotKeys: mode.slotKeys,
        requiredSlotKeys: mode.requiredSlotKeys ?? null,
        textOnly: mode.textOnly ?? false,
        default: mode.id === defaultModeId(resolvedModes),
      }))
    : null;
  // Media input slots — все, с резолвленным label. Веб фильтрует их по active
  // mode на клиенте (избегаем дублирования логики getActiveSlots на каждый mode).
  const mediaInputs = (m.mediaInputs ?? []).map((slot) => ({
    slotKey: slot.slotKey,
    mode: slot.mode,
    label: String((t.mediaInput as Record<string, string>)[slot.labelKey] ?? slot.labelKey),
    maxImages: slot.maxImages ?? 1,
    required: slot.required ?? false,
    exclusiveGroup: slot.exclusiveGroup ?? null,
    imagesOnly: slot.imagesOnly ?? false,
    revealAfter: slot.revealAfter ?? null,
    constraints: slot.constraints ?? null,
  }));
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
    // true только у preset-exposed моделей (WEB_PRESET_MODEL_IDS). Клиент по этому
    // флагу прячет их из дефолтных списков (дропдаун Дизайна, мега-меню), но
    // оставляет доступными через URL-пресет.
    hiddenFromCarousel: m.hiddenFromCarousel ?? false,
    isLLM,
    supportedAspectRatios: m.supportedAspectRatios ?? null,
    supportedDurations: m.supportedDurations ?? null,
    durationRange: m.durationRange ?? null,
    /** Окно контекста модели (input+output tokens). Используется веб-композером для индикатора «X / Y» под полем ввода. */
    contextWindow: m.contextWindow ?? null,
    // Modes (null = single-mode model, без выбора режима в UI).
    modes,
    // Слоты для медиа-инпутов (фильтруются на клиенте по active mode.slotKeys).
    mediaInputs,
    // Настраиваемые параметры — фронт рендерит контролы по `type`.
    // Не нормализуем: ModelSettingDef[] передаём как есть — `additionalProperties: true`
    // в схеме ответа защищает вложенные объекты от сериализатора Fastify.
    settings: m.settings ?? [],
    promptOptional: m.promptOptional ?? false,
    promptOptionalRequiresMedia: m.promptOptionalRequiresMedia ?? false,
    /** @-reference capabilities (elements/images/video). null = модель не поддерживает @-рефы. */
    promptRefs: m.promptRefs ?? null,
    /** Базовая стоимость в токенах. Для LLM — за 1000 токенов сообщения (500 in + 500 out);
     * для прочих — за 1 единицу соответствующего unit'а. UI показывает рядом с моделью. */
    tokenCostApprox: isLLM
      ? calculateCost(m, APPROX_INPUT_TOKENS_PER_1K, APPROX_OUTPUT_TOKENS_PER_1K)
      : isPerMPixel
        ? calculateCost(m, 0, 0, 1)
        : isPerSecond
          ? calculateCost(m, 0, 0, undefined, undefined, undefined, 1)
          : isPerMVideoToken
            ? calculateCost(m, 0, 0, undefined, 1_000_000)
            : isPerKChar
              ? calculateCost(m, 0, 0, undefined, undefined, undefined, undefined, 1000)
              : calculateCost(m),
    /** Единица измерения стоимости. UI рендерит «≈ 0.13 ✦ / 1k tok» для LLM, «≈ 900 / image» и т.п. для остального. */
    tokenCostUnit: isLLM
      ? ("1k_tok" as const)
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

  /** GET /web/models?section=image&lang=ru — список моделей.
   * `lang` опционален: если задан — переопределяет язык локализации модов/слотов
   * (используется фронтом для синхронизации с UI-переключателем языка).
   * Иначе — берётся `user.language` из БД, иначе fallback "ru". */
  fastify.get<{ Querystring: { section?: string; lang?: string } }>(
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
            lang: {
              type: "string",
              description:
                "UI language override (ru/en/...). Без него используется user.language из БД.",
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
                hiddenFromCarousel: { type: "boolean" },
                isLLM: { type: "boolean" },
                supportedAspectRatios: { type: "array", nullable: true },
                supportedDurations: { type: "array", nullable: true },
                durationRange: { type: "object", nullable: true, additionalProperties: true },
                contextWindow: { type: "integer", nullable: true },
                tokenCostApprox: { type: "number" },
                tokenCostUnit: { type: "string" },
                modes: { type: "array", nullable: true },
                mediaInputs: { type: "array" },
                settings: { type: "array" },
                promptOptional: { type: "boolean" },
                promptOptionalRequiresMedia: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest) => {
      const { section, lang: langOverride } = request.query as {
        section?: string;
        lang?: string;
      };
      const { aibUserId } = request.webUser!;
      // Приоритет: явный ?lang= (UI-переключатель веба) > user.language (DB) > ru.
      // Без какого-либо lang'а mediaInput.labelKey'и смотрелись бы как `firstFrame`/etc.
      let lang: Language;
      if (langOverride && SUPPORTED_LANG_SET.has(langOverride)) {
        lang = langOverride as Language;
      } else {
        const user = aibUserId
          ? await db.user.findUnique({ where: { id: aibUserId }, select: { language: true } })
          : null;
        lang = (user?.language ?? "ru") as Language;
      }
      const all = section
        ? (MODELS_BY_SECTION[section as Section] ?? [])
        : Object.values(AI_MODELS);
      // hiddenFromCarousel-модели активируются только в спец-сценариях (например
      // «продлить» grok-imagine-extend) и не должны попадать в каталог UI. Исключение —
      // preset-exposed модели (WEB_PRESET_MODEL_IDS): их веб активирует через URL-пресет,
      // поэтому отдаём в каталог (клиент прячет их из дефолтных списков по флагу).
      return all
        .filter((m) => !m.hiddenFromCarousel || WEB_PRESET_MODEL_IDS.has(m.id))
        .map((mm) => serializeForWeb(mm, lang));
    },
  );
};
