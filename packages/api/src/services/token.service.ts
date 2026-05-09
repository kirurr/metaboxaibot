import { db } from "../db.js";
import { config } from "@metabox/shared";
import type { AIModel } from "@metabox/shared";
import { getModelMultiplier, getEffectiveTargetMargin } from "./pricing-config.service.js";

export interface DeductResult {
  /** Tokens actually deducted (same as input `amount`). */
  deducted: number;
  /** Subscription token balance AFTER deduction. */
  subscriptionTokenBalance: number;
  /** Regular (purchased) token balance AFTER deduction. */
  tokenBalance: number;
}

/**
 * Опциональная audit-метаинформация для деаukция: фактический provider
 * (отличается от model.provider при fallback'е) и сырая цена в USD по нему
 * БЕЗ pricing-коэффициентов. Используется только для записи в transaction —
 * на расчёт списания не влияет.
 */
export interface ActualUsageMeta {
  actualProvider?: string;
  actualCostUsd?: number;
}

/**
 * Deduct tokens for AI usage. Subscription tokens are spent first, then regular tokens.
 * Atomically updates balances and records the transaction. Returns post-deduction balances.
 */
export async function deductTokens(
  userId: bigint,
  amount: number,
  modelId: string,
  dialogId?: string,
  reason?: string,
  actual?: ActualUsageMeta,
): Promise<DeductResult> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      subscriptionTokenBalance: true,
      tokenBalance: true,
      finishedOnboarding: true,
      generationCount: true,
    },
  });

  // Subscription tokens are spent first, then regular (purchased) tokens.
  const fromSub = Math.min(Number(user.subscriptionTokenBalance), amount);
  const fromRegular = Math.min(Number(user.tokenBalance), amount - fromSub);

  // Onboarding: count generations and flip the flag after 10
  const newCount = user.generationCount + 1;
  const shouldFinishOnboarding = !user.finishedOnboarding && newCount >= 10;

  const [updatedUser] = await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: {
        ...(fromSub > 0 ? { subscriptionTokenBalance: { decrement: fromSub } } : {}),
        ...(fromRegular > 0 ? { tokenBalance: { decrement: fromRegular } } : {}),
        generationCount: { increment: 1 },
        ...(shouldFinishOnboarding ? { finishedOnboarding: true } : {}),
      },
      select: { subscriptionTokenBalance: true, tokenBalance: true },
    }),
    db.tokenTransaction.create({
      data: {
        userId,
        amount: -amount,
        type: "debit",
        reason: reason ?? "ai_usage",
        modelId,
        dialogId: dialogId ?? null,
        ...(actual?.actualProvider ? { actualProvider: actual.actualProvider } : {}),
        ...(actual?.actualCostUsd !== undefined ? { actualCostUsd: actual.actualCostUsd } : {}),
      },
    }),
  ]);

  return {
    deducted: amount,
    subscriptionTokenBalance: Number(updatedUser.subscriptionTokenBalance),
    tokenBalance: Number(updatedUser.tokenBalance),
  };
}

/**
 * Возвращает токены пользователю — обратная операция к `deductTokens`.
 * Используется когда генерация была списана, но результат не доставлен
 * (например, файл провайдера 404'ит на финальной отправке в Telegram —
 * ничего ценного юзер не получил).
 *
 * Стратегия зачисления зеркальна списанию: subscriptionTokens возвращаем
 * в первую очередь (decrement шёл сначала с них), regular — остаток.
 * Распределение определяется по `subscriptionTokenBalance` в момент
 * списания, но мы не храним splits — поэтому пишем всё в `tokenBalance`
 * как «безопасный» минимум: пусть лучше у юзера окажется чуть больше
 * regular-токенов, чем мы запутаемся в попытках восстановить subscription
 * lifetime. Транзакция помечается `type=credit` / `reason=ai_refund`.
 */
export async function refundTokens(
  userId: bigint,
  amount: number,
  modelId: string,
  reason: string = "ai_refund",
  dialogId?: string,
): Promise<void> {
  if (amount <= 0) return;
  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: { tokenBalance: { increment: amount } },
    }),
    db.tokenTransaction.create({
      data: {
        userId,
        amount,
        type: "credit",
        reason,
        modelId,
        dialogId: dialogId ?? null,
      },
    }),
  ]);
}

/**
 * Throw NO_SUBSCRIPTION if the user has no active subscription,
 * or INSUFFICIENT_TOKENS if combined balance is below required amount.
 */
export async function checkBalance(userId: bigint, required: number): Promise<void> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      tokenBalance: true,
      subscriptionTokenBalance: true,
      role: true,
    },
  });
  if (user.role === "ADMIN") {
    return;
  }
  // Check active subscription from LocalSubscription (single source of truth)
  const sub = await db.localSubscription.findUnique({ where: { userId } });
  const hasActiveSub = sub && sub.isActive && sub.endDate > new Date();
  if (!hasActiveSub) throw new Error("NO_SUBSCRIPTION");
  const total = Number(user.subscriptionTokenBalance) + Number(user.tokenBalance);
  if (total < required) throw new Error("INSUFFICIENT_TOKENS");
}

/**
 * Throw NO_SUBSCRIPTION if the user has no active subscription.
 * Triаl counts as active — используется для гейта AI-генерации (chat / image /
 * video / audio), где триальщик должен иметь доступ.
 */
export async function checkSubscription(userId: bigint): Promise<void> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { role: true },
  });
  if (user.role === "ADMIN") {
    return;
  }
  const sub = await db.localSubscription.findUnique({ where: { userId } });
  if (!sub || !sub.isActive || sub.endDate <= new Date()) {
    throw new Error("NO_SUBSCRIPTION");
  }
}

/**
 * Throw NO_SUBSCRIPTION если у юзера нет активной **платной** подписки.
 * Триал (planName === "Trial") здесь НЕ считается подпиской.
 *
 * Используется для гейта покупки пакетов токенов: триальщик сначала должен
 * оформить нормальную подписку, только потом докупать пакеты.
 */
export async function checkPaidSubscription(userId: bigint): Promise<void> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { role: true },
  });
  if (user.role === "ADMIN") {
    return;
  }
  const sub = await db.localSubscription.findUnique({ where: { userId } });
  if (!sub || !sub.isActive || sub.endDate <= new Date() || sub.planName === "Trial") {
    throw new Error("NO_SUBSCRIPTION");
  }
}

// ─── Internal billing helpers ─────────────────────────────────────────────────

interface ResolvedRates {
  baseRequest: number;
  inputCostPerMToken: number;
  /**
   * Discounted rate for tokens served from the provider's prompt cache.
   * `undefined` → cached tokens billed at the regular `inputCostPerMToken` rate.
   */
  cachedInputCostPerMToken?: number;
  outputCostPerMToken: number;
  costPerSecond?: number;
  costPerMVideoToken?: number;
  costPerKChar?: number;
}

/**
 * Apply costVariants (setting-based overrides) and contextPricingTiers (token-count
 * multipliers) to produce a snapshot of resolved rates for this request.
 */
function resolveRates(
  model: AIModel,
  inputTokens: number,
  modelSettings: Record<string, unknown> | undefined,
): ResolvedRates {
  let baseRequest = model.costUsdPerRequest;
  let inputCostPerMToken = model.inputCostUsdPerMToken;
  let cachedInputCostPerMToken = model.cachedInputCostUsdPerMToken;
  let outputCostPerMToken = model.outputCostUsdPerMToken;
  let costPerSecond = model.costUsdPerSecond;
  let costPerMVideoToken = model.costUsdPerMVideoToken;
  let costPerKChar = model.costUsdPerKChar;

  // Context-size pricing tiers (e.g. GPT-5.4 doubles rates above 272k tokens)
  if (model.contextPricingTiers && inputTokens > model.contextPricingTiers.thresholdTokens) {
    inputCostPerMToken *= model.contextPricingTiers.inputMultiplier;
    outputCostPerMToken *= model.contextPricingTiers.outputMultiplier;
    if (cachedInputCostPerMToken !== undefined) {
      cachedInputCostPerMToken *= model.contextPricingTiers.inputMultiplier;
    }
  }

  // Setting-based cost overrides
  if (model.costVariants && modelSettings) {
    const settingVal = modelSettings[model.costVariants.settingKey];
    const variant = model.costVariants.map[String(settingVal)];
    if (typeof variant === "number") {
      baseRequest = variant;
    } else if (variant) {
      if (variant.costUsdPerRequest !== undefined) baseRequest = variant.costUsdPerRequest;
      if (variant.outputCostUsdPerMToken !== undefined)
        outputCostPerMToken = variant.outputCostUsdPerMToken;
      if (variant.costUsdPerSecond !== undefined) costPerSecond = variant.costUsdPerSecond;
      if (variant.costUsdPerMVideoToken !== undefined)
        costPerMVideoToken = variant.costUsdPerMVideoToken;
      if (variant.costUsdPerKChar !== undefined) costPerKChar = variant.costUsdPerKChar;
    }
  }

  return {
    baseRequest,
    inputCostPerMToken,
    cachedInputCostPerMToken,
    outputCostPerMToken,
    costPerSecond,
    costPerMVideoToken,
    costPerKChar,
  };
}

interface MediaOpts {
  megapixels?: number;
  /**
   * Megapixels of the input image (img2img models). Used to add an
   * input-image surcharge via `costUsdPerMPixelInput`. Ignored when the
   * model has `costUsdPerMPixelInputFixed === true` (flat fee).
   */
  inputMegapixels?: number;
  /**
   * Per-image megapixel sizes for multi-image inputs (img2img with N images).
   * When set, overrides `inputMegapixels`/`hasInputImage`:
   *   - fixed:    cost += length * costUsdPerMPixelInput
   *   - per-MP:   cost += sum(ceil(mp_i)) * costUsdPerMPixelInput
   */
  inputImagesMegapixels?: number[];
  /** True when an input image is present. Needed for flat-fee input billing. */
  hasInputImage?: boolean;
  videoTokens?: number;
  durationSeconds?: number;
  charCount?: number;
  modelSettings?: Record<string, unknown>;
  /**
   * When true, indicates reference video inputs were provided (e.g. Seedance r2v).
   * Applies a 0.6× multiplier on per-video-token cost per provider pricing.
   */
  hasVideoInputs?: boolean;
}

/**
 * Compute the base provider USD cost for media models (image / audio / video).
 * Billing mode priority:
 *   1. costMatrix  — exact lookup by setting values (returns immediately)
 *   2. per-megapixel
 *   3. per-video-token
 *   4. per-second  (includes baseRequest flat fee)
 *   5. per-kchar   (includes baseRequest flat fee)
 *   6. fallback    — baseRequest
 *
 * Per-input-image surcharge (`costUsdPerMPixelInput`) применяется ОТДЕЛЬНО в
 * `computeInputImageSurcharge` — независимо от режима базовой цены, чтобы
 * модели с per-call/quality-variant биллингом тоже могли тарифицировать
 * referenced images (например, nano-banana через evolink).
 */
function computeMediaBaseUsd(model: AIModel, rates: ResolvedRates, opts: MediaOpts): number {
  const { megapixels, videoTokens, charCount, modelSettings } = opts;

  // Resolve effective duration (explicit arg → modelSettings → undefined)
  const durationSeconds =
    opts.durationSeconds ??
    (rates.costPerSecond !== undefined && typeof modelSettings?.duration_seconds === "number"
      ? modelSettings.duration_seconds
      : undefined);

  // 1. Multi-dimensional pricing table
  if (model.costMatrix && modelSettings) {
    const key = model.costMatrix.dims.map((dim) => String(modelSettings[dim] ?? "")).join("__");
    const matrixCost = model.costMatrix.table[key];
    if (matrixCost !== undefined) {
      // When the model also has costUsdPerSecond, the matrix value is a per-second rate.
      if (model.costUsdPerSecond !== undefined && durationSeconds !== undefined) {
        return rates.baseRequest + durationSeconds * matrixCost;
      }
      return matrixCost;
    }
  }

  // 2. Per-megapixel
  if (model.costUsdPerMPixel && megapixels) {
    return (model.costUsdPerMPixelBase ?? 0) + Math.ceil(megapixels) * model.costUsdPerMPixel;
  }

  // 3. Per-video-token
  if (rates.costPerMVideoToken && videoTokens) {
    const base = (videoTokens / 1_000_000) * rates.costPerMVideoToken;
    // Seedance r2v pricing: ×0.6 when reference video inputs are provided.
    return opts.hasVideoInputs ? base * 0.6 : base;
  }

  // 4. Per-second (flat fee + duration charge)
  if (rates.costPerSecond !== undefined && durationSeconds !== undefined) {
    return rates.baseRequest + durationSeconds * rates.costPerSecond;
  }

  // 5. Per-kchar (flat fee + character charge)
  if (rates.costPerKChar !== undefined && charCount !== undefined) {
    return rates.baseRequest + (charCount / 1000) * rates.costPerKChar;
  }

  // 6. Fallback: fixed per-request
  return rates.baseRequest;
}

/**
 * Доплата за reference images (img2img / image editing): применяется поверх
 * любой базовой цены — per-megapixel, per-call, costVariants и т.д. Раньше
 * surcharge был встроен в per-megapixel ветку, поэтому модели с
 * `costUsdPerRequest`/`costVariants` и referenced images не могли его
 * учитывать (например, nano-banana через evolink).
 *
 * Логика идентична старой:
 *   - `inputImagesMegapixels` (массив N изображений):
 *     • fixed=true → N × costUsdPerMPixelInput
 *     • fixed=false → sum(ceil(mp_i)) × costUsdPerMPixelInput
 *   - `hasInputImage=true` без массива (legacy single-image):
 *     • fixed=true → costUsdPerMPixelInput
 *     • fixed=false → ceil(inputMegapixels) × costUsdPerMPixelInput
 */
function computeInputImageSurcharge(model: AIModel, opts: MediaOpts): number {
  if (!model.costUsdPerMPixelInput) return 0;
  const rate = model.costUsdPerMPixelInput;
  const fixed = !!model.costUsdPerMPixelInputFixed;

  const perImage = opts.inputImagesMegapixels;
  if (perImage && perImage.length > 0) {
    if (fixed) return perImage.length * rate;
    const totalCeil = perImage.reduce((sum, mp) => sum + Math.ceil(mp), 0);
    return totalCeil * rate;
  }
  if (opts.hasInputImage) {
    if (fixed) return rate;
    if (opts.inputMegapixels !== undefined && opts.inputMegapixels > 0) {
      return Math.ceil(opts.inputMegapixels) * rate;
    }
  }
  return 0;
}

/**
 * Sum additive cost components from model.costAddons (e.g. web search, high thinking).
 */
function computeAddonUsd(
  model: AIModel,
  modelSettings: Record<string, unknown> | undefined,
): number {
  if (!model.costAddons || !modelSettings) return 0;
  let total = 0;
  for (const addon of model.costAddons) {
    const val = String(modelSettings[addon.settingKey] ?? "");
    total += addon.map[val] ?? 0;
  }
  return total;
}

/**
 * Compute LLM per-token USD cost.
 *
 * `cachedInputTokens` (subset of `inputTokens`) is billed at the model's
 * `cachedInputCostUsdPerMToken` if defined. When the model has no cached
 * rate, cached tokens fall through to the regular input rate (no discount).
 */
function computeLlmUsd(
  rates: ResolvedRates,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
): number {
  const cached = Math.min(Math.max(cachedInputTokens, 0), inputTokens);
  const billedFresh = inputTokens - cached;
  const cachedRate = rates.cachedInputCostPerMToken ?? rates.inputCostPerMToken;
  return (
    (billedFresh * rates.inputCostPerMToken +
      cached * cachedRate +
      outputTokens * rates.outputCostPerMToken) /
    1_000_000
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Calculate the internal token cost for a request.
 *
 * Billing mode is determined by which cost fields are set on the model:
 *   - costMatrix              → exact table lookup (setting values → USD)
 *   - costUsdPerMPixel        → per-megapixel (image models)
 *   - costUsdPerMVideoToken   → per-video-token (Seedance-style)
 *   - costUsdPerSecond        → per-second + flat costUsdPerRequest (video/audio)
 *   - costUsdPerKChar         → per-kchar + flat costUsdPerRequest (TTS)
 *   - costUsdPerRequest       → fixed per-request (fallback)
 *   - inputCostUsdPerMToken   → per-token in+out (LLM)
 *
 * costVariants and contextPricingTiers can override any of the above.
 * costAddons are summed on top of the base cost.
 */
export function calculateCost(
  model: AIModel,
  inputTokens = 0,
  outputTokens = 0,
  megapixels?: number,
  videoTokens?: number,
  modelSettings?: Record<string, unknown>,
  durationSeconds?: number,
  charCount?: number,
  extra?: {
    inputMegapixels?: number;
    inputImagesMegapixels?: number[];
    hasInputImage?: boolean;
    hasVideoInputs?: boolean;
    /**
     * Subset of `inputTokens` served from the provider's prompt cache —
     * billed at `cachedInputCostUsdPerMToken` if set on the model, otherwise
     * at the regular input rate.
     */
    cachedInputTokens?: number;
  },
): number {
  const usd = calculateProviderCostUsd(
    model,
    inputTokens,
    outputTokens,
    megapixels,
    videoTokens,
    modelSettings,
    durationSeconds,
    charCount,
    extra,
  );
  // Применяем per-model multiplier (по умолчанию 1.0) на финальные токены.
  // НЕ округляем — для LLM-моделей одно сообщение часто стоит долю токена
  // (например, 0.05 ✦), и Math.ceil превращало бы это в 1 ✦ (×20 overcharge).
  // Внутренние токены — Decimal в БД, fractional accepted в deductTokens.
  return usdToTokens(usd) * getModelMultiplier(model.id);
}

/**
 * Сырая цена запроса в USD по конкретной модели (provider-side стоимость) —
 * БЕЗ pricing-коэффициентов (per-model multiplier, target margin). Это сумма
 * `mediaUsd + inputImageUsd + addonUsd + llmUsd`, рассчитанная по тарифам
 * именно `model`, что важно при fallback'е: сначала юзеру списывается цена
 * по primary через `calculateCost(primaryModel)`, а в audit-поле
 * `actualCostUsd` транзакции пишется результат `calculateProviderCostUsd(activeModel)`.
 *
 * Используется для аудита фактических расходов / маржи между primary-pricing
 * (с коэффициентами) и actual-provider-cost (raw USD).
 */
export function calculateProviderCostUsd(
  model: AIModel,
  inputTokens = 0,
  outputTokens = 0,
  megapixels?: number,
  videoTokens?: number,
  modelSettings?: Record<string, unknown>,
  durationSeconds?: number,
  charCount?: number,
  extra?: {
    inputMegapixels?: number;
    inputImagesMegapixels?: number[];
    hasInputImage?: boolean;
    hasVideoInputs?: boolean;
    cachedInputTokens?: number;
  },
): number {
  const rates = resolveRates(model, inputTokens, modelSettings);
  const mediaOpts: MediaOpts = {
    megapixels,
    inputMegapixels: extra?.inputMegapixels,
    inputImagesMegapixels: extra?.inputImagesMegapixels,
    hasInputImage: extra?.hasInputImage,
    videoTokens,
    durationSeconds,
    charCount,
    modelSettings,
    hasVideoInputs: extra?.hasVideoInputs,
  };
  const mediaUsd = computeMediaBaseUsd(model, rates, mediaOpts);
  const inputImageUsd = computeInputImageSurcharge(model, mediaOpts);
  const addonUsd = computeAddonUsd(model, modelSettings);
  const llmUsd = computeLlmUsd(rates, inputTokens, outputTokens, extra?.cachedInputTokens ?? 0);
  return mediaUsd + inputImageUsd + addonUsd + llmUsd;
}

/** Convert a USD cost to internal tokens using the billing config. */
export function usdToTokens(usd: number): number {
  return (usd / config.billing.usdPerToken) * getEffectiveTargetMargin();
}

/**
 * Compute video tokens for per-video-token billing models (e.g. Seedance).
 * videoTokens = (width × height × fps × duration) / 1024
 *
 * Prefer actual dimensions (parsed from the generated MP4) over aspect-ratio estimates.
 * When estimating, resolution (e.g. "720p") determines the short side of the frame,
 * and the aspect ratio determines the long side proportionally.
 */
export function computeVideoTokens(
  model: AIModel,
  aspectRatio: string | undefined,
  duration: number,
  actualWidth?: number,
  actualHeight?: number,
  actualFps?: number,
  resolution?: string,
): number {
  if (!model.videoFps) return 0;

  let w: number;
  let h: number;

  if (actualWidth && actualHeight) {
    w = actualWidth;
    h = actualHeight;
  } else {
    [w, h] = estimateVideoDimensions(aspectRatio ?? "16:9", resolution ?? "720p");
  }

  const fps = actualFps ?? model.videoFps;
  return (w * h * fps * duration) / 1024;
}

/**
 * Estimate pixel dimensions from aspect ratio and resolution string.
 * Resolution (e.g. "720p") sets the short side; the long side is computed
 * from the aspect ratio.  For square ratios both sides equal the base.
 */
export function estimateVideoDimensions(aspectRatio: string, resolution: string): [number, number] {
  const base = parseInt(resolution, 10) || 720;

  const match = aspectRatio.match(/^(\d+):(\d+)$/);
  if (!match) return [base, base]; // "auto" or unknown → square at base

  const rw = Number(match[1]);
  const rh = Number(match[2]);

  if (rw === rh) return [base, base];

  const long = Math.round((base * Math.max(rw, rh)) / Math.min(rw, rh));
  return rw > rh ? [long, base] : [base, long];
}
