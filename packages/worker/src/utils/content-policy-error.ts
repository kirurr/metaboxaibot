/**
 * Классификация content-policy / модерационных ошибок генеративных моделей
 * для retry→fallback логики (см. handleContentPolicyRetryFallback).
 *
 * Контекст: провайдерская модерация часто срабатывает НЕДЕТЕРМИНИРОВАННО —
 * тот же запрос при перезапуске или на другом провайдере нередко проходит
 * (особенно output-модерация, где есть рандом сида). Поэтому на content-policy
 * мы делаем 1 ретрай на провайдере → fallback → 1 ретрай на fallback → и только
 * потом отдаём юзеру понятную ошибку. Теряем только время (failed-генерации
 * обычно не списываются провайдером).
 *
 * ЖЁСТКОЕ ИСКЛЮЧЕНИЕ: child-safety / CSAM модерация НИКОГДА не ретраится и не
 * fallback'ится — это правовая линия. `isChildSafetyError` намеренно
 * консервативен (любое сомнение → считаем child-safety → НЕ ретраим).
 */

import { classifyError } from "./classify-error.js";

/**
 * Маркеры child-safety / CSAM в тексте ошибки. Консервативно широкие: ложное
 * срабатывание = просто НЕ ретраим (безопасно, как сегодня), пропуск = ретрай
 * child-safety (недопустимо). Проверяются ТОЛЬКО когда ошибка уже признана
 * модерационной, поэтому «minor» и т.п. здесь почти всегда = несовершеннолетний.
 */
const CHILD_SAFETY_PATTERNS: RegExp[] = [
  /\bchild(ren|hood)?\b/i,
  /\bminors?\b/i,
  /\bunderage[d]?\b/i,
  /\bkids?\b/i,
  /\bbab(y|ies)\b/i,
  /\binfants?\b/i,
  /\btoddlers?\b/i,
  /\bpre-?teens?\b/i,
  /\bcsam\b/i,
  /\bcsae[mi]?\b/i,
  /\bcsem\b/i,
  /\bcsea[mi]?\b/i,
  /\bpa?edophil/i,
  /\blolicon\b/i,
  /child (safety|sexual|protection|abuse|exploitation)/i,
  /sexual[a-z]* (of |involving )?(a )?(child|minor)/i,
];

/** HeyGen `code` для child-safety модерации (см. classify-error.ts). */
const HEYGEN_CHILD_SAFETY_CODE = 402007;

/** Собирает message по cause-цепочке (до 6 уровней) для текстового поиска. */
function collectMessages(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    if (typeof cur !== "object" || seen.has(cur as object)) break;
    seen.add(cur as object);
    const e = cur as { message?: unknown; cause?: unknown };
    if (typeof e.message === "string") parts.push(e.message);
    cur = e.cause;
  }
  return parts.join(" ");
}

/**
 * True если ошибка — child-safety / CSAM модерация. Такие НИКОГДА не
 * ретраятся/fallback'ятся. Консервативно: HeyGen-код + любые текстовые маркеры
 * в message/cause.
 */
export function isChildSafetyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === HEYGEN_CHILD_SAFETY_CODE) return true;
  const msg = collectMessages(err);
  if (!msg) return false;
  return CHILD_SAFETY_PATTERNS.some((p) => p.test(msg));
}

/**
 * True если ошибка — content-policy / модерация, на которую МОЖНО делать
 * retry→fallback (т.е. НЕ child-safety). Покрывает input- и output-модерацию
 * всех провайдеров через `classifyError` (contentPolicyViolation,
 * publicFigureViolation, copyrightViolation, identityPreservationNotAllowed,
 * audioSensitiveWord, gptImageModerationBlocked + провайдерные коды).
 */
export function isContentPolicyError(err: unknown): boolean {
  // Жёсткая правовая линия: child-safety / CSAM не ретраим никогда.
  if (isChildSafetyError(err)) return false;
  const code = classifyError(err);
  return code === "INPUT_MODERATION" || code === "OUTPUT_MODERATION";
}
