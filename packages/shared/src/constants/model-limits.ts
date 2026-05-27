import { UserFacingError } from "../errors.js";

/**
 * Лимиты длины полей провайдеров. Single source of truth для service-layer
 * pre-flight'а и адаптеров — чтобы валидация не разъезжалась между точками.
 *
 * Источники:
 *  - Suno: docs/schema/kie/suno-quickstart.md (Prompt/Style Character Limits)
 *  - Nano Banana Pro: backend hard limit 2000 chars (см. evolink.adapter.ts:76)
 */

// ─── Suno ────────────────────────────────────────────────────────────────────

export const SUNO_NON_CUSTOM_PROMPT_MAX = 500;

interface SunoModelLimits {
  /** Лимит на `prompt` в API в custom mode — это lyrics. */
  customPrompt: number;
  /** Лимит на `style` в API в custom mode — это описание стиля. */
  style: number;
}

/**
 * V5_5 в доке отдельно не упомянут — относим к группе V4_5+ (та же архитектура,
 * подтверждено практикой работы провайдера).
 */
const SUNO_MODEL_LIMITS: Record<string, SunoModelLimits> = {
  V4: { customPrompt: 3000, style: 200 },
  V4_5: { customPrompt: 5000, style: 1000 },
  V4_5PLUS: { customPrompt: 5000, style: 1000 },
  V5: { customPrompt: 5000, style: 1000 },
  V5_5: { customPrompt: 5000, style: 1000 },
};

const SUNO_DEFAULT_MODEL = "V4_5";

export function getSunoLimits(modelVersion: string | undefined): SunoModelLimits {
  return (
    SUNO_MODEL_LIMITS[modelVersion ?? SUNO_DEFAULT_MODEL] ?? SUNO_MODEL_LIMITS[SUNO_DEFAULT_MODEL]
  );
}

export interface SunoValidationInput {
  /** Что юзер ввёл в чате: в custom mode это `style`, в non-custom — `prompt`. */
  prompt: string;
  /** Что юзер ввёл в Управлении (lyrics). Триггерит custom mode если задан. */
  lyrics?: string;
  /** Если true — генерация без вокала, lyrics игнорируется → non-custom. */
  instrumental?: boolean;
  modelVersion?: string;
}

/**
 * Pre-flight валидация Suno-инпута против provider-лимитов. Бросает
 * UserFacingError с понятным ключом, если превышены. Используется и в
 * service-layer (до acquireKey), и внутри адаптеров (safety net).
 */
export function validateSunoInput(input: SunoValidationInput): void {
  const lyrics = input.lyrics?.trim() || undefined;
  const instrumental = input.instrumental ?? false;
  const customMode = !instrumental && Boolean(lyrics);
  const limits = getSunoLimits(input.modelVersion);

  if (customMode && lyrics) {
    if (lyrics.length > limits.customPrompt) {
      throw new UserFacingError(`Suno: lyrics ${lyrics.length} > ${limits.customPrompt} chars`, {
        key: "sunoPromptTooLong",
        params: { max: limits.customPrompt, current: lyrics.length },
      });
    }
    if (input.prompt.length > limits.style) {
      throw new UserFacingError(`Suno: style ${input.prompt.length} > ${limits.style} chars`, {
        key: "sunoPromptTooLong",
        params: { max: limits.style, current: input.prompt.length },
      });
    }
    return;
  }

  if (input.prompt.length > SUNO_NON_CUSTOM_PROMPT_MAX) {
    throw new UserFacingError(
      `Suno: prompt ${input.prompt.length} > ${SUNO_NON_CUSTOM_PROMPT_MAX} chars`,
      {
        key: "sunoPromptTooLongNoLyrics",
        params: { current: input.prompt.length },
      },
    );
  }
}

// ─── Nano Banana Pro ─────────────────────────────────────────────────────────

export const NANO_BANANA_PROMPT_MAX = 2000;

/**
 * Pre-flight валидация nano-banana-pro prompt'а. Лимит провайдер-агностический —
 * единый backend, fallback на другой ключ не лечит. Бросает UserFacingError.
 */
export function validateNanoBananaPromptLength(prompt: string): void {
  if (prompt.length > NANO_BANANA_PROMPT_MAX) {
    throw new UserFacingError(
      `Nano Banana Pro: prompt ${prompt.length} > ${NANO_BANANA_PROMPT_MAX} chars`,
      {
        key: "nanoBananaPromptTooLong",
        params: { max: NANO_BANANA_PROMPT_MAX, current: prompt.length },
      },
    );
  }
}
