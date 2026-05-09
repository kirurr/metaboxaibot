/**
 * Sends a structured error notification to the tech Telegram chat (ALERT_CHAT_ID).
 * Mirrors the worker's notify-error utility but uses the bot's own Api instance.
 * Silently no-ops if ALERT_CHAT_ID is not configured or sending fails.
 */

import { Api } from "grammy";
import { config, AI_MODELS, UserFacingError } from "@metabox/shared";
import { db } from "@metabox/api/db";

const telegram = new Api(config.bot.token);

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializeError(err: unknown): string {
  if (err === null || err === undefined) return String(err);

  const parts: string[] = [];

  if (typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") parts.push(e.message);
    if (typeof e.status === "number" || typeof e.statusCode === "number") {
      parts.push(`HTTP ${e.status ?? e.statusCode}`);
    }
    if (e.body !== undefined) {
      try {
        parts.push("body: " + JSON.stringify(e.body, null, 2));
      } catch {
        parts.push("body: [unserializable]");
      }
    }
    if (typeof e.stack === "string") {
      const stackLines = e.stack.split("\n").slice(0, 6).join("\n");
      parts.push(stackLines);
    }
    if (e.cause !== undefined) {
      parts.push("caused by: " + serializeError(e.cause));
    }
  } else {
    parts.push(String(err));
  }

  return parts.join("\n");
}

export interface TechErrorContext {
  section?: string;
  modelId?: string;
  userId?: string;
  dialogId?: string;
}

/**
 * Резолвим metadata модели по modelId из глобального каталога. Возвращаем
 * provider и человекочитаемое name (если такие есть). null если не удалось
 * найти — например, для internal helper-id'ов вроде "voice-clone", которых
 * в AI_MODELS нет.
 */
function resolveModelMeta(
  modelId: string | undefined,
): { name?: string; provider?: string } | null {
  if (!modelId) return null;
  const m = AI_MODELS[modelId];
  if (!m) return null;
  return { name: m.name, provider: m.provider };
}

/**
 * Если у нас есть dialogId, но не передан modelId — подтягиваем modelId
 * из dialogs.modelId. Используется в gpt.ts catch-блоке, где dialogId есть,
 * а modelId на месте error path удобнее не пробрасывать вручную.
 */
async function fetchDialogModelId(dialogId: string | undefined): Promise<string | undefined> {
  if (!dialogId) return undefined;
  try {
    const d = await db.dialog.findUnique({
      where: { id: dialogId },
      select: { modelId: true },
    });
    return d?.modelId;
  } catch {
    return undefined;
  }
}

/**
 * Sends a tech error alert to ALERT_CHAT_ID. Does not throw — always resolves.
 *
 * Резолв модели/провайдера (приоритет сверху вниз):
 * 1. `UserFacingError.tech` — если caller передал ошибку-обёртку с tech-meta
 *    (chat.service.ts заполняет actual + primary при fallback'е), используем
 *    её. В alert уйдут ОБА провайдера: на котором фактически упало и primary.
 * 2. `ctx.modelId` — явно переданный id, резолвим из `AI_MODELS`.
 * 3. `ctx.dialogId` — подтягиваем modelId из БД (`dialogs.modelId`).
 *
 * Header: `[section/<active-or-modelId> @ <active-provider>]`.
 * Meta включает friendly name, primary modelId/provider если был fallback.
 * Если модели в каталоге нет (e.g. "voice-clone") — header выводит только id.
 */
export async function notifyTechError(err: unknown, ctx: TechErrorContext): Promise<void> {
  const chatId = config.alerts.chatId;
  if (!chatId) return;

  const threadId = config.alerts.threadId;

  // Извлекаем tech-meta из UserFacingError (если это он). chat.service.ts
  // заполняет это поле при падении после fallback'а, чтобы alert показал
  // и actual provider, и primary.
  const tech = err instanceof UserFacingError ? err.tech : undefined;

  // Резолв actual model: tech > ctx.modelId > dialog.modelId.
  const effectiveModelId =
    tech?.activeModelId ?? ctx.modelId ?? (await fetchDialogModelId(ctx.dialogId));
  const effectiveProvider = tech?.activeProvider ?? resolveModelMeta(effectiveModelId)?.provider;
  const friendlyName = resolveModelMeta(effectiveModelId)?.name;

  const labelParts = [ctx.section, effectiveModelId].filter(Boolean) as string[];
  let label = labelParts.join("/") || "gpt";
  if (effectiveProvider) label += ` @ ${effectiveProvider}`;
  const header = `🔴 <b>Chat error</b> [${label}]`;

  const meta: string[] = [];
  if (friendlyName && friendlyName !== effectiveModelId) {
    meta.push(`model: <code>${escapeHtml(friendlyName)}</code>`);
  }
  // Если был использован fallback — отдельной строкой показываем primary,
  // чтобы on-call видел разницу между «упала исходная модель» и «упал
  // fallback (значит и primary до него был сломан)».
  if (tech?.fallbackUsed && tech.primaryModelId && tech.primaryModelId !== effectiveModelId) {
    const primaryProvLabel = tech.primaryProvider ? ` @ ${tech.primaryProvider}` : "";
    meta.push(
      `primary: <code>${escapeHtml(tech.primaryModelId)}${escapeHtml(primaryProvLabel)}</code>`,
    );
  }
  if (ctx.dialogId) meta.push(`dialog: <code>${ctx.dialogId}</code>`);
  if (ctx.userId) meta.push(`user: <code>${ctx.userId}</code>`);

  const errorText = serializeError(err);
  const maxErrorLen = 3500 - header.length - meta.join(" | ").length;
  const truncated =
    errorText.length > maxErrorLen ? errorText.slice(0, maxErrorLen) + "\n…[truncated]" : errorText;

  const text = [
    header,
    meta.length ? meta.join(" | ") : null,
    `<pre>${escapeHtml(truncated)}</pre>`,
  ]
    .filter(Boolean)
    .join("\n");

  await telegram
    .sendMessage(chatId, text, {
      parse_mode: "HTML",
      ...(threadId ? { message_thread_id: threadId } : {}),
    })
    .catch(() => void 0);
}
