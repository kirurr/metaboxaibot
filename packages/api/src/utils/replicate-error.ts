/**
 * Structured error handling for Replicate prediction failures.
 *
 * Replicate embeds error codes in the format E#### inside prediction.error strings.
 * User-facing codes are those caused by user input (file size, invalid params, OOM from large input).
 * All other codes are tech/infrastructure errors that should trigger a tech alert.
 */

/** Codes that indicate a user-correctable problem. */
const USER_FACING_CODES = new Set(["E005", "E006", "E1001", "E9243", "E9825"]);

export class ReplicatePredictionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReplicatePredictionError";
  }
}

/**
 * Patterns для случаев, когда Replicate model вернул user-facing ошибку без
 * структурного E-кода — текст явно описывает проблему юзера, но код извлечь
 * нельзя. Тогда мапим по тексту на синтетический известный код, чтобы
 * существующий `getReplicateUserMessage` отдал релевантный i18n-текст вместо
 * generic'а.
 *
 * Пример: Midjourney через Replicate отдаёт "All generated images contained
 * NSFW content. Try running it again with a different prompt." — без E006,
 * но это очевидный content-policy блок.
 */
const USER_FACING_TEXT_PATTERNS: { pattern: RegExp; code: string }[] = [
  // Content moderation / NSFW → E006 (content policy)
  { pattern: /\bNSFW\b/i, code: "E006" },
  { pattern: /\bcontent (policy|moderation|filter)/i, code: "E006" },
  { pattern: /\bsafety (filter|policy)/i, code: "E006" },
  { pattern: /try (running it )?again with a different prompt/i, code: "E006" },
  // Multimodal модели (Gemini-based image, и т.п.) при отказе генерировать
  // картинку возвращают текстовый output вместо image — Replicate-обвязка
  // в адаптере падает с "No image content found in response". Самый частый
  // root cause — silent refusal по content policy либо модель сочла промпт
  // непригодным. Мапим на E006 → юзеру говорим «измените промпт или фото».
  { pattern: /no image content found in response/i, code: "E006" },
];

/**
 * Parses a failed/canceled prediction into a typed error.
 * Extracts the E#### code from the error string if present; falls back to E1000 (unknown).
 * Если структурного кода нет — пробуем определить категорию по тексту через
 * USER_FACING_TEXT_PATTERNS, чтобы юзер увидел релевантную ошибку.
 */
export function parseReplicatePredictionFailure(
  error: unknown,
  status: string,
): ReplicatePredictionError {
  const errorStr = String(error ?? "");
  // Replicate uses E#### (4-digit) codes, but some model errors use shorter codes like E006.
  const codeMatch = errorStr.match(/\bE\d{3,4}\b/);
  let code = codeMatch ? codeMatch[0] : "E1000";

  if (code === "E1000") {
    for (const { pattern, code: synthCode } of USER_FACING_TEXT_PATTERNS) {
      if (pattern.test(errorStr)) {
        code = synthCode;
        break;
      }
    }
  }

  return new ReplicatePredictionError(code, `Replicate prediction ${status}: ${errorStr}`);
}

export function isReplicateUserFacingError(err: unknown): err is ReplicatePredictionError {
  return err instanceof ReplicatePredictionError && USER_FACING_CODES.has(err.code);
}

export function getReplicateUserMessage(
  err: ReplicatePredictionError,
  t: { errors: Record<string, string> },
): string {
  const e = t.errors;
  switch (err.code) {
    // E005 — Sora и др. video-модели на Replicate: "The input or output was
    // flagged as sensitive". Семантика та же, что и E006 (content policy).
    case "E005":
    case "E006":
      return e.replicateContentPolicy;
    case "E1001":
      return e.replicateOom;
    case "E9243":
      return e.replicateInvalidParams;
    case "E9825":
      return e.replicateFileTooLarge;
    default:
      return e.generationFailed;
  }
}
