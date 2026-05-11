/**
 * Resolves a provider error to a user-facing message, or returns null
 * if the error is technical/unknown (should trigger a tech alert instead).
 */

import { hasFalUserFacingError, getFalUserMessage } from "@metabox/api/utils/fal-error";
import { isHeyGenUserFacingError, getHeyGenUserMessage } from "@metabox/api/utils/heygen-error";
import { isLumaUserFacingError, getLumaUserMessage } from "@metabox/api/utils/luma-error";
import { isMinimaxUserFacingError, getMinimaxUserMessage } from "@metabox/api/utils/minimax-error";
import { isRunwayUserFacingError, getRunwayUserMessage } from "@metabox/api/utils/runway-error";
import {
  isReplicateUserFacingError,
  getReplicateUserMessage,
} from "@metabox/api/utils/replicate-error";
import {
  type Translations,
  type GenerationFailedSection,
  UserFacingError,
  resolveUserFacingErrorVariant,
  pickGenerationFailedMessage,
} from "@metabox/shared";

export function resolveUserFacingMessage(err: unknown, t: Translations): string | null {
  if (err instanceof UserFacingError) return resolveUserFacingErrorVariant(err, t);
  if (isHeyGenUserFacingError(err)) return getHeyGenUserMessage(err, t);
  if (isRunwayUserFacingError(err)) return getRunwayUserMessage(err, t);
  if (isMinimaxUserFacingError(err)) return getMinimaxUserMessage(err, t);
  if (isLumaUserFacingError(err)) return getLumaUserMessage(err, t);
  if (isReplicateUserFacingError(err)) return getReplicateUserMessage(err, t);
  if (hasFalUserFacingError(err))
    return getFalUserMessage(err, t) ?? t.errors.contentPolicyViolation;
  return null;
}

/**
 * Returns true when a user-facing error should ALSO send a tech-channel alert
 * (e.g. AI-classified provider errors that we want to keep tracking until we
 * add a hardcoded handler for them).
 */
export function shouldNotifyOps(err: unknown): boolean {
  return err instanceof UserFacingError && err.notifyOps === true;
}

/**
 * Returns the dedup key for ops alerts when the underlying error wants
 * the tech channel throttled (provider-wide conditions like credits
 * exhausted). `null` → caller should send a regular non-throttled alert.
 */
export function getOpsAlertDedupKey(err: unknown): string | null {
  if (err instanceof UserFacingError && err.opsAlertDedupKey) {
    return err.opsAlertDedupKey;
  }
  return null;
}

/**
 * Resolve a sub-job error в form для virtual batch'а.
 *
 *   - userText: показывается юзеру только в K=0 user-fault ветке
 *     (image.processor: «есть user-facing ошибка → выводим её, чтобы юзер
 *     понимал что фиксить»). На partial-success и K=0 not-user-fault путях
 *     userText не используется — там идёт обобщённое batchSubJobFailedMessage
 *     или pickGenerationFailedMessage. Сначала пробуем `resolveUserFacingMessage`
 *     (mapping UserFacingError → локализованный текст, hardcoded provider helpers,
 *     AI-classified errors). Если ничего не подошло — generic шаблон.
 *   - rawText: сырое err.message для логов и notifyTechError.
 *   - isUserFacing: true если userText резолвился из UserFacingError /
 *     provider-helper'а; false если упали на generic шаблон. Помогает
 *     решить надо ли алертить ops + триггерить K=0 user-fault ветку.
 *
 * Mirror'ит поведение single-shot path'а (см. catch в processImageJob /
 * processVideoJob), просто формализованное в helper для batch контекста.
 */
export function resolveSubJobError(
  err: unknown,
  t: Translations,
  modelName: string,
  section: GenerationFailedSection = "design",
): { userText: string; rawText: string; isUserFacing: boolean } {
  // rawText включает cause-chain — без этого undici-ошибки выглядят как
  // абстрактное "fetch failed" в notifyTechError. Видим: сообщение, code,
  // syscall/host из каждого уровня cause до 4 шагов.
  const rawText = formatErrorWithCauseChain(err);
  const mapped = resolveUserFacingMessage(err, t);
  if (mapped !== null) {
    return { userText: mapped, rawText, isUserFacing: true };
  }
  const userText = pickGenerationFailedMessage(t, modelName, section);
  return { userText, rawText, isUserFacing: false };
}

/**
 * Распаковывает err.message + cause-chain в одну строку. Для каждого уровня
 * выводит message + .code если есть. Используется для записи в `errorRaw`
 * sub-job'а — потом этот текст идёт в notifyTechError.
 */
function formatErrorWithCauseChain(err: unknown): string {
  const lines: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur; depth++) {
    if (typeof cur !== "object" || cur === null) {
      lines.push(String(cur));
      break;
    }
    const e = cur as Record<string, unknown>;
    const msg = typeof e.message === "string" ? e.message : "[no message]";
    const code = e.code ?? e.errno;
    const codeStr = typeof code === "string" || typeof code === "number" ? ` [code: ${code}]` : "";
    const prefix = depth === 0 ? "" : `caused by: `;
    lines.push(`${prefix}${msg}${codeStr}`);
    cur = e.cause;
  }
  return lines.join("\n  ");
}
