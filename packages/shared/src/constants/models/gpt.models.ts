import type { AIModel, ModelSettingDef } from "../../types/ai.js";

// ── Reusable setting blocks ───────────────────────────────────────────────────

const TEMPERATURE_SETTING: ModelSettingDef = {
  key: "temperature",
  label: "Температура",
  description:
    "Степень случайности ответов: ниже — точнее и предсказуемее, выше — разнообразнее и творчески.",
  type: "slider",
  min: 0,
  max: 2,
  step: 0.05,
  default: 1.0,
  advanced: true,
};

/** Perplexity and Qwen require t < 2 (strictly), so cap at 1.99. */
const TEMPERATURE_SETTING_CAPPED: ModelSettingDef = { ...TEMPERATURE_SETTING, max: 1.99 };

/** Anthropic Claude accepts temperature 0..1 only. */
const TEMPERATURE_SETTING_ANTHROPIC: ModelSettingDef = { ...TEMPERATURE_SETTING, max: 1 };

/** Standard LLM controls: temperature, max output tokens, system prompt. */
const LLM_SETTINGS: ModelSettingDef[] = [
  TEMPERATURE_SETTING,
  {
    key: "max_tokens",
    label: "Макс. длина ответа",
    description:
      "Максимальное количество слов, которые ИИ может написать за один ответ. Увеличьте для длинных текстов.",
    type: "slider",
    min: 256,
    max: 8192,
    step: 256,
    default: 2048,
  },
  {
    key: "system_prompt",
    label: "Системный промпт",
    description:
      "Скрытая инструкция, которую ИИ всегда соблюдает: задайте роль, стиль или ограничения для всего диалога.",
    type: "text",
    default: "",
    advanced: true,
  },
];

const PERPLEXITY_SYSTEM_PROMPT: ModelSettingDef = {
  key: "system_prompt",
  label: "Системный промпт",
  description:
    "Скрытая инструкция, которую ИИ всегда соблюдает: задайте роль, стиль или ограничения для всего диалога.",
  type: "text",
  default:
    "Отвечай на языке пользователя. Используй только Telegram Markdown: *жирный*, _курсив_, `код`, ```блок кода```. Не используй заголовки (##) и двойные звёздочки (**). Ссылки на источники указывай в конце ответа нумерованным списком с полными URL.",
  advanced: true,
};

/** Extra setting for Perplexity search models. */
const PERPLEXITY_EXTRA: ModelSettingDef = {
  key: "search_recency_filter",
  label: "Период поиска",
  description:
    "Ограничьте поиск свежими материалами: только за последний час, день, неделю или месяц.",
  type: "select",
  options: [
    { value: "month", label: "Месяц" },
    { value: "week", label: "Неделя" },
    { value: "day", label: "День" },
    { value: "hour", label: "Час" },
  ],
  default: "month",
};

/** Depth of search for Perplexity models. */
const PERPLEXITY_SEARCH_CONTEXT: ModelSettingDef = {
  key: "search_context_size",
  label: "Глубина поиска",
  description: "low — быстрее и дешевле, high — больше источников и точнее, но дороже.",
  type: "select",
  options: [
    { value: "low", label: "Низкая" },
    { value: "medium", label: "Средняя" },
    { value: "high", label: "Высокая" },
  ],
  default: "medium",
};

/** Domain filter for Perplexity models. */
const PERPLEXITY_DOMAIN_FILTER: ModelSettingDef = {
  key: "search_domain_filter",
  label: "Фильтр сайтов",
  description:
    "Ограничить поиск конкретными доменами (через запятую, напр. wikipedia.org, bbc.com). Пусто — без ограничений.",
  type: "text",
  default: "",
  advanced: true,
};

/** Reasoning effort for OpenAI o-series and Grok reasoning models (low/medium/high). */
const REASONING_EFFORT: ModelSettingDef = {
  key: "reasoning_effort",
  label: "Глубина рассуждений",
  description:
    "Сколько усилий модель тратит на обдумывание: low — быстро, high — тщательнее и точнее, но дольше.",
  type: "select",
  options: [
    { value: "low", label: "Низкая" },
    { value: "medium", label: "Средняя" },
    { value: "high", label: "Высокая" },
  ],
  default: "medium",
};

/**
 * Reasoning effort for gpt-5.4 / gpt-5.4-pro — supported: medium, high, xhigh.
 */
const REASONING_EFFORT_GPT5: ModelSettingDef = {
  key: "reasoning_effort",
  label: "Глубина рассуждений",
  description: "Средняя — сбалансировано, Макс. — максимальная точность для сложных задач.",
  type: "select",
  options: [
    { value: "medium", label: "Средняя" },
    { value: "high", label: "Высокая" },
    { value: "xhigh", label: "Макс." },
  ],
  default: "medium",
};

/**
 * Reasoning effort for gpt-5.5 / gpt-5.5-pro — supports none/low/medium/high/xhigh.
 * `none` отключает reasoning (модель отвечает сразу без chain-of-thought).
 */
const REASONING_EFFORT_GPT55: ModelSettingDef = {
  key: "reasoning_effort",
  label: "Глубина рассуждений",
  description:
    "Без — мгновенный ответ без рассуждений, Низкая/Средняя — баланс, Высокая/Макс. — точнее для сложных задач (дольше).",
  type: "select",
  options: [
    { value: "none", label: "Без" },
    { value: "low", label: "Низкая" },
    { value: "medium", label: "Средняя" },
    { value: "high", label: "Высокая" },
    { value: "xhigh", label: "Макс." },
  ],
  default: "medium",
};

/**
 * Reasoning effort for gpt-5-nano — позиционируется как лёгкая модель,
 * default `low` оставляет больше бюджета видимому ответу. Без явного
 * выбора OpenAI применил бы `medium`, что на маленьком max_output_tokens
 * приводило к пустым ответам (reasoning съедал весь бюджет).
 */
const REASONING_EFFORT_GPT5_NANO: ModelSettingDef = {
  key: "reasoning_effort",
  label: "Глубина рассуждений",
  description: "Низкая — мгновенно, Средняя — баланс, Высокая — точнее на сложных задачах.",
  type: "select",
  options: [
    { value: "low", label: "Низкая" },
    { value: "medium", label: "Средняя" },
    { value: "high", label: "Высокая" },
  ],
  default: "low",
};

/**
 * Reasoning effort for gpt-5-pro — only "high" is supported.
 */
const REASONING_EFFORT_GPT5_PRO: ModelSettingDef = {
  key: "reasoning_effort",
  label: "Глубина рассуждений",
  description: "gpt-5-pro поддерживает только максимальный уровень рассуждений.",
  type: "select",
  options: [{ value: "high", label: "Высокая" }],
  default: "high",
};

/** Output verbosity for gpt-5 family models. */
const VERBOSITY_SETTING: ModelSettingDef = {
  key: "verbosity",
  label: "Подробность ответа",
  description:
    "Краткий — краткие ответы, Стандартный — сбалансировано, Подробный — развёрнуто (для объяснений и аналитики).",
  type: "select",
  options: [
    { value: "low", label: "Краткий" },
    { value: "medium", label: "Стандартный" },
    { value: "high", label: "Подробный" },
  ],
  default: "medium",
};

/** Extended thinking toggle for Anthropic models. */
const EXTENDED_THINKING: ModelSettingDef = {
  key: "extended_thinking",
  label: "Расширенное мышление",
  description:
    "Модель думает дольше перед ответом — точнее для сложных задач, но медленнее. При включении настройка «Макс. длина ответа» игнорируется: ответ может занять до ~16 000 токенов.",
  type: "toggle",
  default: false,
};

/** Thinking mode toggle for Qwen reasoning models. */
const ENABLE_THINKING: ModelSettingDef = {
  key: "enable_thinking",
  label: "Режим размышления",
  description:
    "Модель рассуждает перед ответом — точнее для сложных задач, но цена за запрос значительно больше.",
  type: "toggle",
  default: true,
};

/** Thinking budget slider for Gemini 2.x (thinking optional, can be disabled). */
const THINKING_BUDGET: ModelSettingDef = {
  key: "thinking_budget",
  label: "Бюджет рассуждений",
  description: "Сколько токенов модель может потратить на внутренние рассуждения (0 = выключено).",
  type: "slider",
  min: 0,
  max: 24576,
  step: 256,
  default: 0,
};

/**
 * Thinking budget slider for Gemini 3.x — thinking is REQUIRED, нельзя 0.
 * Google API на budget=0 вернёт 400 "This model only works in thinking mode".
 * Min/default подняты до 128 чтобы UI не позволял задать невалидное значение.
 */
const THINKING_BUDGET_REQUIRED: ModelSettingDef = {
  key: "thinking_budget",
  label: "Бюджет рассуждений",
  description: "Сколько токенов модель может потратить на внутренние рассуждения.",
  type: "slider",
  min: 128,
  max: 24576,
  step: 256,
  default: 1024,
};

/**
 * Settings for reasoning models (gpt-5 family, o-series) — no temperature.
 * Temperature is unsupported by these models via the Responses API.
 */
const REASONING_MODEL_SETTINGS: ModelSettingDef[] = [
  {
    key: "max_tokens",
    label: "Макс. длина ответа",
    description:
      "Максимальное количество слов, которые ИИ может написать за один ответ. Увеличьте для длинных текстов.",
    type: "slider",
    min: 256,
    max: 8192,
    step: 256,
    default: 2048,
  },
  {
    key: "system_prompt",
    label: "Системный промпт",
    description:
      "Скрытая инструкция, которую ИИ всегда соблюдает: задайте роль, стиль или ограничения для всего диалога.",
    type: "text",
    default: "",
    advanced: true,
  },
];

/**
 * Context window slider — limits how much of the model's physical context
 * window the chat service is allowed to fill before truncating history.
 * Built dynamically per-model so the slider's `max` matches the model's
 * `contextWindow`. Min 32K, step 1K.
 */
function contextWindowSetting(modelMaxTokens: number): ModelSettingDef {
  return {
    key: "context_window",
    label: "Контекстное окно",
    description:
      "Максимальный размер истории диалога в токенах. Старые сообщения автоматически отбрасываются, чтобы запрос уложился в этот лимит.",
    type: "slider",
    min: 32_000,
    max: modelMaxTokens,
    step: 1_000,
    default: modelMaxTokens,
    advanced: true,
  };
}

/** Reasoning effort for Grok 3 Mini — only supports low/high (no medium). */
const GROK_MINI_REASONING: ModelSettingDef = {
  key: "reasoning_effort",
  label: "Режим рассуждений",
  description: "low — быстро и дёшево, high — точнее для сложных задач.",
  type: "select",
  options: [
    { value: "low", label: "Низкая" },
    { value: "high", label: "Высокая" },
  ],
  default: "low",
};

export const GPT_MODELS: Record<string, AIModel> = {
  // ── GPT / LLM ─────────────────────────────────────────────────────────────
  // LLM models have costUsdPerRequest = 0; cost is entirely token-driven.
  // Per-token prices sourced from provider pricing pages (2026-03-17).
  // Order matches the mini-app display order.

  // ── GPT 5 ─────────────────────────────────────────────────────────────────
  "gpt-5.5": {
    id: "gpt-5.5",
    name: "💬 GPT 5.5",
    description:
      "Новейший флагман OpenAI с контекстом 1M+ токенов и поддержкой reasoning-режима (от выкл. до максимального). Лучший баланс интеллекта, скорости и цены в линейке.",
    section: "gpt",
    provider: "openai",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 5, // long context: ×2 = $10/M
    cachedInputCostUsdPerMToken: 0.5, // OpenAI prompt cache: 90% off; long context: ×2 = $1/M
    outputCostUsdPerMToken: 30, // long context: ×1.5 = $45/M
    contextPricingTiers: { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "provider_chain",
    contextMaxMessages: 0,
    settings: [REASONING_EFFORT_GPT55, VERBOSITY_SETTING, ...REASONING_MODEL_SETTINGS],
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    name: "💬 GPT 5.4",
    description:
      "Флагман OpenAI нового поколения — умнее и быстрее GPT 5 Pro. Лучший баланс интеллекта, скорости и цены в линейке.",
    section: "gpt",
    provider: "openai",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 2.5, // >272k tokens: ×2 = $5/M
    cachedInputCostUsdPerMToken: 0.25, // OpenAI prompt cache: 90% off для gpt-5.4
    outputCostUsdPerMToken: 15, // >272k tokens: ×1.5 = $22.5/M
    contextPricingTiers: { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "provider_chain",
    contextMaxMessages: 0,
    settings: [REASONING_EFFORT_GPT5, VERBOSITY_SETTING, ...REASONING_MODEL_SETTINGS],
  },
  // "gpt-5-mini": { //TODO: verify account org
  //   id: "gpt-5-mini",
  //   name: "🌀 GPT 5 Mini",
  //   description: "Компактная и быстрая, хороша для повседневных задач.",
  //   section: "gpt",
  //   provider: "openai",
  //   costUsdPerRequest: 0,
  //   inputCostUsdPerMToken: 0.25,
  //   outputCostUsdPerMToken: 2.0,
  //   supportsImages: true,
  //   supportsVoice: false,
  //   supportsWeb: false,
  //   isAsync: false,
  //   contextStrategy: "provider_chain",
  //   contextMaxMessages: 0,
  //   settings: [VERBOSITY_SETTING, ...REASONING_MODEL_SETTINGS],
  // },
  "gpt-5-nano": {
    id: "gpt-5-nano",
    name: "✨ GPT 5 Nano",
    description:
      "Самая лёгкая и дешёвая в линейке GPT 5 — мгновенные ответы для простых задач. Не поддерживает изображения.",
    section: "gpt",
    provider: "openai",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 0.05,
    cachedInputCostUsdPerMToken: 0.02, // OpenAI prompt cache: 90% off
    outputCostUsdPerMToken: 0.4,
    supportsImages: false,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "provider_chain",
    contextMaxMessages: 0,
    settings: [REASONING_EFFORT_GPT5_NANO, VERBOSITY_SETTING, ...REASONING_MODEL_SETTINGS],
  },
  "o4-mini": {
    id: "o4-mini",
    name: "🔬 GPT-o4 Mini",
    description:
      "Новейшая reasoning-модель OpenAI — цепочка рассуждений для сложных задач. Понимает изображения, умнее o3 Mini.",
    section: "gpt",
    provider: "openai",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 1.1,
    cachedInputCostUsdPerMToken: 0.275, // OpenAI prompt cache: 75% off
    outputCostUsdPerMToken: 4.4,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "provider_chain",
    contextMaxMessages: 0,
    settings: [REASONING_EFFORT, ...REASONING_MODEL_SETTINGS],
  },
  // o3: {
  //   id: "o3",
  //   name: "🧩 GPT-o3",
  //   description: "Мощная reasoning-модель OpenAI, глубокие рассуждения для самых сложных задач.",
  //   section: "gpt",
  //   provider: "openai",
  //   costUsdPerRequest: 0,
  //   inputCostUsdPerMToken: 2.0,
  //   outputCostUsdPerMToken: 8.0,
  //   supportsImages: true,
  //   supportsVoice: false,
  //   supportsWeb: false,
  //   isAsync: false,
  //   contextStrategy: "provider_chain",
  //   contextMaxMessages: 0,
  //   settings: [REASONING_EFFORT, ...REASONING_MODEL_SETTINGS],
  // },
  "o3-mini": {
    id: "o3-mini",
    name: "🔩 GPT-o3 Mini",
    description:
      "Предыдущая компактная reasoning-модель OpenAI. Не понимает изображения — для текстовых задач с цепочкой рассуждений.",
    section: "gpt",
    provider: "openai",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 1.1,
    cachedInputCostUsdPerMToken: 0.55, // OpenAI prompt cache: 50% off (o3 family)
    outputCostUsdPerMToken: 4.4,
    supportsImages: false,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "provider_chain",
    contextMaxMessages: 0,
    settings: [REASONING_EFFORT, ...REASONING_MODEL_SETTINGS],
  },

  // "claude-opus-4-5": закомментировано — экономически нецелесообразно держать
  //   предыдущее поколение Opus параллельно с 4.6. Чтобы вернуть — раскомментируйте
  //   и убедитесь, что claude-opus-4-5 поддерживается у kie на /claude/v1/messages.
  // "claude-opus-4-5": {
  //   id: "claude-opus-4-5",
  //   name: "🃏 Claude 4.5 Opus",
  //   description:
  //     "Предыдущее поколение Opus (версия 4.5). Глубокий анализ и длинные тексты. Чуть слабее 4.6 в рассуждениях, но проверенная стабильность.",
  //   section: "gpt",
  //   provider: "kie-claude",
  //   costUsdPerRequest: 0,
  //   inputCostUsdPerMToken: 1.425,
  //   outputCostUsdPerMToken: 7.15,
  //   supportsImages: true,
  //   supportsVoice: false,
  //   supportsWeb: false,
  //   isAsync: false,
  //   contextStrategy: "db_history",
  //   contextMaxMessages: 50,
  // },
  "claude-sonnet": {
    id: "claude-sonnet",
    name: "📜 Claude 4.6 Sonnet",
    description:
      "Новейший Sonnet (версия 4.6) — лучший баланс цена/качество у Anthropic. Быстрее и дешевле Opus, отлично для кода, текстов и анализа.",
    section: "gpt",
    provider: "kie-claude",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 0.85,
    outputCostUsdPerMToken: 4.275,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "db_history", // нет серверного контекста
    contextMaxMessages: 50,
  },
  // "claude-sonnet-4-5": закомментировано — см. claude-opus-4-5.
  // "claude-sonnet-4-5": {
  //   id: "claude-sonnet-4-5",
  //   name: "🖊️ Claude 4.5 Sonnet",
  //   description:
  //     "Предыдущее поколение Sonnet (версия 4.5). Надёжная рабочая лошадка, чуть слабее 4.6. Отлично для кода и текстов.",
  //   section: "gpt",
  //   provider: "kie-claude",
  //   costUsdPerRequest: 0,
  //   inputCostUsdPerMToken: 0.85,
  //   outputCostUsdPerMToken: 4.275,
  //   supportsImages: true,
  //   supportsVoice: false,
  //   supportsWeb: false,
  //   isAsync: false,
  //   contextStrategy: "db_history",
  //   contextMaxMessages: 50,
  // },
  "claude-haiku": {
    id: "claude-haiku",
    name: "🍃 Claude 4.5 Haiku",
    description:
      "Самая быстрая и дешёвая модель Anthropic. Мгновенные ответы для простых задач, понимает изображения. Слабее Sonnet и Opus в рассуждениях.",
    section: "gpt",
    provider: "kie-claude",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 0.275,
    outputCostUsdPerMToken: 1.425,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 50,
  },

  // ── Google Gemini ──────────────────────────────────────────────────────────
  "gemini-3-pro": {
    id: "gemini-3-pro",
    name: "💎 Gemini 3 Pro",
    description:
      "Флагман Google, контекст до 1M токенов и мультимодальность. Поддерживает поиск в интернете. Базовая версия 3 Pro.",
    section: "gpt",
    provider: "google",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 2.0, //	$2.00, prompts <= 200k tokens; $4.00, prompts > 200k tokens
    outputCostUsdPerMToken: 12.0, //$12.00, prompts <= 200k tokens; $18.00, prompts > 200k
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: true,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 50,
  },
  "gemini-3.1-pro": {
    id: "gemini-3.1-pro",
    name: "💍 Gemini 3.1 Pro",
    description:
      "Обновлённый Gemini 3 Pro (версия 3.1) — лучше следует инструкциям и точнее отвечает. Та же цена, что и 3.0. Поиск в интернете.",
    section: "gpt",
    provider: "google",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 2.0, //	$2.00, prompts <= 200k tokens; $4.00, prompts > 200k tokens
    outputCostUsdPerMToken: 12.0, //$12.00, prompts <= 200k tokens; $18.00, prompts > 200k
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: true,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 50,
  },
  "gemini-2-flash": {
    id: "gemini-2-flash",
    name: "🌟 Gemini 2.5 Flash",
    description:
      "Быстрая и дешёвая модель Google с reasoning. Отличное соотношение цена/качество, дешевле Pro в ~7 раз. Поиск в интернете.",
    section: "gpt",
    provider: "google",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 0.3,
    outputCostUsdPerMToken: 2.5,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: true,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 50,
  },
  "gemini-2-flash-lite": {
    id: "gemini-2-flash-lite",
    name: "⭐ Gemini 2.5 Flash Lite",
    description:
      "Самая лёгкая и дешёвая модель Google. Для простых задач с минимальными затратами. Без изображений и поиска в интернете.",
    section: "gpt",
    provider: "google",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 0.1,
    outputCostUsdPerMToken: 0.4,
    supportsImages: false,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 50,
  },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  "deepseek-r1": {
    id: "deepseek-r1",
    name: "🔍 DeepSeek R1",
    description:
      "Reasoning-модель из Китая — сильна в математике и коде, думает пошагово. Медленнее V3, но точнее для сложных задач.",
    section: "gpt",
    provider: "deepseek",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 0.28,
    outputCostUsdPerMToken: 0.42,
    supportsImages: false,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 40,
  },
  "deepseek-v3": {
    id: "deepseek-v3",
    name: "🐋 DeepSeek V3",
    description:
      "Быстрая модель DeepSeek для общих задач и генерации текста. Без пошагового reasoning — быстрее R1, но менее точна в сложных задачах.",
    section: "gpt",
    provider: "deepseek",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 0.28,
    outputCostUsdPerMToken: 0.42,
    supportsImages: false,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 40,
  },

  // ── xAI Grok ──────────────────────────────────────────────────────────────
  "grok-4": {
    id: "grok-4",
    name: "🤖 Grok 4",
    description:
      "Флагман xAI — максимальное качество рассуждений, контекст 256K. Дороже Grok 4 Fast, но точнее для сложных задач.",
    section: "gpt",
    provider: "grok",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 2.0, // x2 if context > 200k
    outputCostUsdPerMToken: 6.0, // x2 if context > 200k
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 40,
    contextPricingTiers: { thresholdTokens: 200_000, inputMultiplier: 2, outputMultiplier: 2 },
  },
  "grok-4-fast": {
    id: "grok-4-fast",
    name: "🏎️ Grok 4 Fast",
    description:
      "Ускоренная версия Grok 4 от xAI. Контекст до 2M токенов, в ~10 раз дешевле стандартного Grok 4. Быстрые ответы с рассуждением.",
    section: "gpt",
    provider: "grok",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 0.2, // x2 if context > 128k
    outputCostUsdPerMToken: 0.5, // x2 if context > 128k
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 40,
    contextPricingTiers: { thresholdTokens: 128_000, inputMultiplier: 2, outputMultiplier: 2 },
  },

  // ── Perplexity ────────────────────────────────────────────────────────────
  "perplexity-sonar-pro": {
    id: "perplexity-sonar-pro",
    name: "🌐 Perplexity Sonar Pro + Internet",
    description:
      "Мощный AI-поиск с глубокими ответами из интернета. Дороже Sonar, но точнее анализирует источники и даёт более развёрнутые ответы.",
    section: "gpt",
    provider: "perplexity",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 3.0,
    outputCostUsdPerMToken: 15.0,
    supportsImages: false,
    supportsVoice: false,
    supportsWeb: true,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 20,
  },
  "perplexity-sonar-research": {
    id: "perplexity-sonar-research",
    name: "🔭 Perplexity Sonar Deep Research",
    description:
      "Автономный исследователь — анализирует десятки источников за один запрос. Идеален для глубокого ресёрча, дольше обычного Sonar.",
    section: "gpt",
    provider: "perplexity",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 2.0,
    outputCostUsdPerMToken: 8.0,
    supportsImages: false,
    supportsVoice: false,
    supportsWeb: true,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 20,
  },
  "perplexity-sonar": {
    id: "perplexity-sonar",
    name: "📡 Perplexity Sonar + Internet",
    description:
      "Быстрый и дешёвый AI-поиск с актуальными данными из интернета. Базовая версия — для оперативных вопросов без глубокого анализа.",
    section: "gpt",
    provider: "perplexity",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 1.0,
    outputCostUsdPerMToken: 1.0,
    supportsImages: false,
    supportsVoice: false,
    supportsWeb: true,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 20,
  },

  // ── Qwen 3 ───────────────────────────────────────────────────────────────
  "qwen-3-max-thinking": {
    id: "qwen-3-max-thinking",
    name: "🧮 Qwen 3 Max Thinking",
    description:
      "Крупнейшая reasoning-модель Alibaba. Максимальное качество в линейке Qwen — для самых сложных задач. Дороже Qwen 3 Thinking.",
    section: "gpt",
    provider: "alibaba",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 0.7,
    outputCostUsdPerMToken: 8.4, // thinking on (default); off=$2.80
    costVariants: {
      settingKey: "enable_thinking",
      map: { true: { outputCostUsdPerMToken: 8.4 }, false: { outputCostUsdPerMToken: 2.8 } },
    },
    supportsImages: false,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 40,
  },
  "qwen-3-thinking": {
    id: "qwen-3-thinking",
    name: "💭 Qwen 3 Thinking",
    description:
      "Reasoning-модель Alibaba среднего размера — дешевле Max, но сильна в коде и математике. Оптимальный баланс цена/качество в линейке Qwen.",
    section: "gpt",
    provider: "alibaba",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 0.2,
    outputCostUsdPerMToken: 2.4, // thinking on (default); off=$0.80
    costVariants: {
      settingKey: "enable_thinking",
      map: { true: { outputCostUsdPerMToken: 2.4 }, false: { outputCostUsdPerMToken: 0.8 } },
    },
    supportsImages: false,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 40,
  },
  // ── Claude (primary через kie.ai, fallback на evolink.ai) ────────────────
  // Цены — USD за 1M ТЕКСТОВЫХ токенов модели (input / output Anthropic-native).
  // Оба прокси (kie, evolink) проксируют /v1/messages 1:1 c Anthropic SSE,
  // adapter парсит usage.input_tokens / usage.output_tokens напрямую.
  //
  // Цены ниже — KIE-прайсинг (зашитый исторически: credits/1M × $/credit).
  // У evolink цены могут отличаться, но calculateCost у нас по фиксированным
  // полям модели — биллинг юзеру одинаковый независимо от того, через какого
  // прокси прошёл запрос. Платим провайдерам мы по факту, разница идёт в маржу.
  //
  // PDF прокси не поддерживают напрямую → автоматически активируется
  // documentTextExtractFallback (см. ниже).
  //
  // Fallback на evolink-claude конфигурится в FALLBACK_LLM_MODELS — chat.service
  // переключится туда при исчерпании kie-ключей с 5xx/network ошибкой.
  "claude-opus": {
    id: "claude-opus",
    name: "🎭 Claude 4.6 Opus",
    description:
      "Новейшая и самая умная модель Anthropic (версия 4.6). Лучшая для сложных аналитических и творческих задач. Понимает изображения.",
    section: "gpt",
    provider: "kie-claude",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 1.425,
    outputCostUsdPerMToken: 7.15,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 50,
  },
  // "qwen-3": {
  //   id: "qwen-3",
  //   name: "🏮 Qwen 3",
  //   description: "Быстрая модель Alibaba, отличная для мультиязычных задач.",
  //   section: "gpt",
  //   provider: "alibaba",
  //   costUsdPerRequest: 0,
  //   inputCostUsdPerMToken: 0.18,
  //   outputCostUsdPerMToken: 2.1, // thinking on (default); off=$0.70
  //   costVariants: {
  //     settingKey: "enable_thinking",
  //     map: { true: { outputCostUsdPerMToken: 2.1 }, false: { outputCostUsdPerMToken: 0.7 } },
  //   },
  //   supportsImages: false,
  //   supportsVoice: false,
  //   supportsWeb: false,
  //   isAsync: false,
  //   contextStrategy: "db_history",
  //   contextMaxMessages: 40,
  // },
  "gpt-5.5-pro": {
    id: "gpt-5.5-pro",
    name: "🧠 GPT 5.5 Pro",
    description:
      "Новейшая флагманская модель OpenAI. Максимальная точность и глубокие рассуждения с расширенным контекстом 1M+ токенов. Дороже GPT 5.5 — для задач, где важна безупречная точность.",
    section: "gpt",
    provider: "openai",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 30, // long context: ×2 = $60/M
    outputCostUsdPerMToken: 180, // long context: ×1.5 = $270/M
    contextPricingTiers: { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "provider_chain",
    contextMaxMessages: 0,
    settings: [REASONING_EFFORT_GPT55, VERBOSITY_SETTING, ...REASONING_MODEL_SETTINGS],
  },
  "gpt-5.4-pro": {
    id: "gpt-5.4-pro",
    name: "🧠 GPT 5.4 Pro",
    description:
      "Самая мощная модель OpenAI. Максимальная точность, глубокие рассуждения. Значительно дороже GPT 5.4 — для задач, где важна безупречная точность.",
    section: "gpt",
    provider: "openai",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 30, // >272k tokens: ×2 = $60/M
    outputCostUsdPerMToken: 180, // >272k tokens: ×1.5 = $270/M
    contextPricingTiers: { thresholdTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5 },
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "provider_chain",
    contextMaxMessages: 0,
    settings: [REASONING_EFFORT_GPT5, VERBOSITY_SETTING, ...REASONING_MODEL_SETTINGS],
  },
  "gpt-5-pro": {
    id: "gpt-5-pro",
    name: "💡 GPT 5 Pro",
    description:
      "Предыдущее поколение флагмана OpenAI. Только максимальный уровень рассуждений — для самых сложных задач. Дороже GPT 5.4.",
    section: "gpt",
    provider: "openai",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 15.0,
    outputCostUsdPerMToken: 120.0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "provider_chain",
    contextMaxMessages: 0,
    settings: [REASONING_EFFORT_GPT5_PRO, VERBOSITY_SETTING, ...REASONING_MODEL_SETTINGS],
  },
};

// ── Apply context window sizes (in tokens) ───────────────────────────────────
// Physical context windows per provider/model. Used by token-aware truncation
// in chat.service and the user-configurable `context_window` setting.
const CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI gpt-5.5 family: 1.05M
  "gpt-5.5-pro": 1_050_000,
  "gpt-5.5": 1_050_000,
  // OpenAI gpt-5 family: 400K
  "gpt-5.4-pro": 400_000,
  "gpt-5.4": 400_000,
  "gpt-5-pro": 400_000,
  "gpt-5-nano": 400_000,
  // OpenAI o-series: 200K
  "o4-mini": 200_000,
  "o3-mini": 200_000,
  // Anthropic Claude: 200K
  "claude-opus": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-sonnet": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-haiku": 200_000,
  // Google Gemini: 1M
  "gemini-3-pro": 1_000_000,
  "gemini-3.1-pro": 1_000_000,
  "gemini-2-flash": 1_000_000,
  "gemini-2-flash-lite": 1_000_000,
  // DeepSeek: 128K
  "deepseek-r1": 128_000,
  "deepseek-v3": 128_000,
  // xAI Grok: 256K (grok-4) / 2M (grok-4-fast)
  "grok-4": 256_000,
  "grok-4-fast": 2_000_000,
  // Perplexity Sonar: 128K
  "perplexity-sonar-pro": 200_000,
  "perplexity-sonar-research": 128_000,
  "perplexity-sonar": 128_000,
  // Qwen 3: 256K
  "qwen-3-max-thinking": 256_000,
  "qwen-3-thinking": 256_000,
};
for (const [id, model] of Object.entries(GPT_MODELS)) {
  const cw = CONTEXT_WINDOWS[id];
  if (cw) model.contextWindow = cw;
}

// ── Apply document-input capability flags ────────────────────────────────────
// OpenAI Responses API and Anthropic accept PDFs natively via content blocks.
// All other providers get server-side text extraction fallback.
for (const model of Object.values(GPT_MODELS)) {
  if (model.provider === "openai" || model.provider === "anthropic") {
    model.supportsDocuments = true;
  } else {
    model.documentTextExtractFallback = true;
  }
}

// ── Apply thinking/reasoning flag ─────────────────────────────────────────────
// Models that support a thinking/reasoning mode (extended thinking, reasoning
// effort, thinking budget, etc.). Responses from these models may take
// significantly longer (up to 10 minutes).
const THINKING_MODEL_IDS = new Set([
  // OpenAI o-series
  "o4-mini",
  "o3-mini",
  // GPT-5 family (all have reasoning_effort)
  "gpt-5.5-pro",
  "gpt-5.5",
  "gpt-5.4-pro",
  "gpt-5.4",
  "gpt-5-pro",
  // Anthropic (extended thinking)
  "claude-opus",
  "claude-opus-4-5",
  "claude-sonnet",
  "claude-sonnet-4-5",
  // Google Gemini (thinking budget)
  "gemini-3-pro",
  "gemini-3.1-pro",
  "gemini-2-flash",
  // DeepSeek R1 (always-on reasoning)
  "deepseek-r1",
  // xAI Grok (reasoning)
  "grok-4",
  "grok-4-fast",
  // Qwen thinking
  "qwen-3-max-thinking",
  "qwen-3-thinking",
]);
for (const [id, model] of Object.entries(GPT_MODELS)) {
  if (THINKING_MODEL_IDS.has(id)) {
    model.supportsThinking = true;
    model.description += " 🧠 Поддерживает режим размышлений.";
  }
}

// ── Apply settings ────────────────────────────────────────────────────────────
// Models with explicitly defined settings (e.g. gpt-5 family, o-series) are skipped.
// All other LLM models get LLM_SETTINGS + provider-specific extras.
const ANTHROPIC_THINKING_IDS = new Set([
  "claude-opus",
  "claude-opus-4-5",
  "claude-sonnet",
  "claude-sonnet-4-5",
]);
const QWEN_THINKING_IDS = new Set(["qwen-3-max-thinking", "qwen-3-thinking", "qwen-3"]);
const GEMINI_THINKING_IDS = new Set([
  "gemini-2-flash",
  "gemini-2-pro",
  "gemini-3-pro",
  "gemini-3.1-pro",
]);

for (const [id, model] of Object.entries(GPT_MODELS)) {
  if (model.settings) continue; // already explicitly set — do not overwrite

  const extras: ModelSettingDef[] = [];

  if (id.startsWith("perplexity")) {
    model.settings = [
      TEMPERATURE_SETTING_CAPPED,
      LLM_SETTINGS[1], // max_tokens
      PERPLEXITY_SYSTEM_PROMPT,
      PERPLEXITY_EXTRA,
      PERPLEXITY_SEARCH_CONTEXT,
      PERPLEXITY_DOMAIN_FILTER,
    ];
    continue;
  }
  if (id.startsWith("qwen")) {
    const qwenExtras: ModelSettingDef[] = [];
    if (QWEN_THINKING_IDS.has(id)) qwenExtras.push(ENABLE_THINKING);
    model.settings = [TEMPERATURE_SETTING_CAPPED, ...LLM_SETTINGS.slice(1), ...qwenExtras];
    continue;
  }
  if (id === "grok-3-mini") {
    extras.push(GROK_MINI_REASONING);
  }
  if (ANTHROPIC_THINKING_IDS.has(id)) {
    extras.push(EXTENDED_THINKING);
  }
  if (QWEN_THINKING_IDS.has(id)) {
    extras.push(ENABLE_THINKING);
  }
  if (GEMINI_THINKING_IDS.has(id)) {
    // Gemini 3.x требует thinking mode > 0; 2.x допускает 0 (выкл.).
    extras.push(id.startsWith("gemini-3") ? THINKING_BUDGET_REQUIRED : THINKING_BUDGET);
  }
  const temp =
    ANTHROPIC_THINKING_IDS.has(id) || id === "claude-haiku"
      ? TEMPERATURE_SETTING_ANTHROPIC
      : TEMPERATURE_SETTING;
  model.settings = [temp, ...LLM_SETTINGS.slice(1), ...extras];
}

// ── Append context window slider to every text model ────────────────────────
// Slider is rendered last so it appears at the bottom of the settings sheet.
// Min 32K, step 1K, max = model's physical context window. Default = max
// (token-aware truncation only kicks in when the user lowers it).
for (const model of Object.values(GPT_MODELS)) {
  if (!model.contextWindow) continue;
  if (!model.settings) model.settings = [];
  model.settings.push(contextWindowSetting(model.contextWindow));
}

// ── LLM fallback registry ───────────────────────────────────────────────────
// Зеркало FALLBACK_DESIGN_MODELS / FALLBACK_VIDEO_MODELS, но для текстовых
// моделей (`section: "gpt"`). Каждая запись — `AIModel` с тем же `id` что
// у primary, но другим `provider` (другой адаптер / другой ключ-пул).
//
// Записи здесь НЕ попадают в AI_MODELS (там id'ы уникальны = primary).
// Используются только chat.service'ом для подбора альтернативного провайдера
// при исчерпании primary'а на 5xx/network ошибке. Биллинг и UI настройки
// берутся всегда из primary — fallback наследует их «фантомно», поэтому
// fields name/description/settings игнорируются.
//
// Перебор кандидатов выполняется в порядке добавления в FALLBACK_LLM_MODELS;
// chat.service берёт первый совместимый. Сейчас порядок: evolink → ... (далее
// можно добавлять прямой Anthropic, OpenRouter и т.п.).
export const FALLBACK_LLM_MODELS: AIModel[] = [
  // ── Claude через evolink (fallback при недоступности kie) ────────────────
  // Цены ниже совпадают с primary — calculateCost ходит по полям primary'а,
  // здесь они только для типобезопасности и (если когда-то) промоушена
  // в самостоятельную модель.
  {
    id: "claude-opus",
    name: "Claude 4.6 Opus (evolink fallback)",
    description: "Fallback на evolink при недоступности kie.",
    section: "gpt",
    provider: "evolink-claude",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 1.425,
    outputCostUsdPerMToken: 7.15,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 50,
  },
  {
    id: "claude-sonnet",
    name: "Claude 4.6 Sonnet (evolink fallback)",
    description: "Fallback на evolink при недоступности kie.",
    section: "gpt",
    provider: "evolink-claude",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 0.85,
    outputCostUsdPerMToken: 4.275,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 50,
  },
  {
    id: "claude-haiku",
    name: "Claude 4.5 Haiku (evolink fallback)",
    description: "Fallback на evolink при недоступности kie.",
    section: "gpt",
    provider: "evolink-claude",
    costUsdPerRequest: 0,
    inputCostUsdPerMToken: 0.275,
    outputCostUsdPerMToken: 1.425,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: false,
    contextStrategy: "db_history",
    contextMaxMessages: 50,
  },
];
