import type { BotContext } from "../types/context.js";
import {
  chatService,
  dialogService,
  userStateService,
  uploadBuffer,
  getFileUrl,
  DocumentNotSupportedError,
  DocumentExtractFailedError,
  ContextOverflowError,
} from "@metabox/api/services";
import type { StoredAttachment, SendMessageResult } from "@metabox/api/services";
import { logger } from "../logger.js";
import {
  config,
  AI_MODELS,
  buildDialogHint,
  formatGenerationCostLine,
  generateWebToken,
  UserFacingError,
  resolveUserFacingErrorVariant,
} from "@metabox/shared";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";
import { InlineKeyboard } from "grammy";
import { toMarkdownV2, closeOpenMarkdownV2 } from "../utils/markdown.js";
import { notifyTechError } from "../utils/notify-tech.js";
import { randomUUID } from "crypto";
import { transcribeAndReply } from "../utils/voice-transcribe.js";

/** Media group buffer: groups multiple photos sent at once before processing. */
interface MediaGroupEntry {
  dialogId: string;
  userId: bigint;
  chatId: number;
  urls: string[];
  s3Keys: string[];
  caption: string;
  ctx: BotContext;
  timer: ReturnType<typeof setTimeout>;
}
const mediaGroupBuffer = new Map<string, MediaGroupEntry>();

/**
 * Dedup для предупреждения «модель не поддерживает фото» при альбоме: Telegram
 * шлёт по одному update на фото, без дедупа юзер получил бы N одинаковых
 * предупреждений. Хранится 10 секунд, потом сам очищается.
 */
const noImageWarningBuffer = new Map<string, { timer: ReturnType<typeof setTimeout> }>();

/** Separate buffer for document media groups — Telegram disallows mixing docs & photos. */
interface DocumentGroupEntry {
  dialogId: string;
  userId: bigint;
  chatId: number;
  attachments: StoredAttachment[];
  caption: string;
  ctx: BotContext;
  timer: ReturnType<typeof setTimeout>;
}
const documentGroupBuffer = new Map<string, DocumentGroupEntry>();

/** Max document file size that we can download from Telegram Bot API. */
const MAX_DOC_SIZE = 20 * 1024 * 1024;

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const ALLOWED_DOC_MIMES = new Set<string>([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/comma-separated-values",
  "text/html",
  "text/xml",
  "application/json",
  DOCX_MIME,
  XLSX_MIME,
]);

const EXT_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "text/xml",
  ".docx": DOCX_MIME,
  ".xlsx": XLSX_MIME,
};

/** Default model for new GPT dialogs (user can change via Management). */
const DEFAULT_GPT_MODEL = "o4-mini";
/**
 * Minimum ms between Telegram message edits (rate-limit safety). Telegram
 * держит per-chat editMessage rate-limit и периодически отвечает 429 с
 * retry_after в десятки секунд — 2.2с интервал даёт запас сверх их 1с/edit
 * политики, чтобы реже ловить 429 на длинных стримах.
 */
const EDIT_THROTTLE_MS = 2200;
/** Finalize current message and start a new one when accumulated text reaches this length. */
const MSG_SPLIT_AT = 3800;
/**
 * Максимум сырого текста на один финальный chunk. Телеграмовский лимит — 4096
 * символов, но MarkdownV2-escape добавляет `\` к каждому спец-символу — на
 * code-блоке с обилием `\n`/`{`/`}`/`*` инфляция бывает ощутимая. Делаем
 * консервативный запас, чтобы даже после escape тело укладывалось в 4096.
 */
const FINAL_CHUNK_MAX = 3500;

/**
 * Telegram отдаёт 429 с `parameters.retry_after` (секунды). Когда мы стримим
 * длинный ответ кучей edit'ов, лимит на чат периодически срабатывает —
 * парсим cooldown и используем чтобы либо подождать (если короткий), либо
 * отстать от editMessage (если длинный, см. RETRY_AFTER_INLINE_MAX_MS).
 */
function parseRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { error_code?: unknown; parameters?: { retry_after?: unknown } };
  if (e.error_code === 429 && typeof e.parameters?.retry_after === "number") {
    return e.parameters.retry_after * 1000;
  }
  return null;
}

/** Максимум inline-ожидания после 429 — дальше пробрасываем результат через
 *  sendMessage (новое сообщение) вместо застрявшего edit'а. */
const RETRY_AFTER_INLINE_MAX_MS = 5000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Strip <think>...</think> blocks. During streaming, also hides an unclosed partial block. */
function stripThinkingBlocks(text: string): string {
  let result = text.replace(/\s*<think>[\s\S]*?<\/think>\s*/g, "");
  const openIdx = result.indexOf("<think>");
  if (openIdx !== -1) result = result.slice(0, openIdx);
  return result.trim();
}

/** Telegram HTML — escape only the four chars that break parser inside text nodes. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Extract content of every closed <think>...</think> block, in order. */
function extractThinkingBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /<think>([\s\S]*?)<\/think>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1]?.trim();
    if (body) blocks.push(body);
  }
  return blocks;
}

/**
 * Размер чанка reasoning-сообщения. Telegram-лимит 4096 на сообщение, и
 * HTML-escape `<` → `&lt;`, `&` → `&amp;` инфлирует длину до ~4× в худшем
 * случае (когда reasoning содержит код/JSON с обилием спецсимволов).
 * 3000 даёт ~1000 chars запаса под escape + заголовок + `<blockquote>` теги.
 * При обычном prose-reasoning escape добавляет <5%, лимит почти никогда
 * не достигается — это safety margin от MESSAGE_TOO_LONG, не таргет.
 */
const REASONING_CHUNK_MAX = 3000;

/** Split reasoning text into chunks ≤ max, preferring newline boundaries. */
function splitReasoning(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    const newlineIdx = remaining.lastIndexOf("\n", max);
    const splitAt = newlineIdx > max / 2 ? newlineIdx + 1 : max;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

/** Максимум попыток на одно reasoning-сообщение перед тем как сдаться и идти
 *  к следующей части. На 429 ждём ровно `retry_after` от Telegram и пробуем
 *  снова; не-429 ошибки (parse, network) не ретраим — повтор не поможет. */
const REASONING_SEND_MAX_ATTEMPTS = 3;

/**
 * Шлёт reasoning-блоки модели юзеру отдельными сообщениями с
 * `<blockquote expandable>` (по умолчанию свёрнуты). Несколько <think>
 * блоков в стриме объединяются переводом строки, режутся на ≤3000 симв.
 * чанки и каждый идёт отдельным сообщением — Telegram-лимит 4096 на сообщение
 * не позволяет ужать длинный reasoning в одно.
 *
 * Rate-limit: на 429 ждём ровно `retry_after` и пробуем до 3 раз. Между
 * чанками помним cooldown через `blockedUntil` — если Telegram попросил
 * подождать на части N, то перед отправкой части N+1 ждём остаток интервала
 * сразу (а не идём к новому 429). Видимый ответ к этому моменту уже в чате
 * (reasoning шлётся ПОСЛЕ finalizeMessage), так что задержка не ломает UX.
 */
async function sendReasoningMessages(
  ctx: BotContext,
  chatId: number,
  rawAccumulated: string,
): Promise<void> {
  const blocks = extractThinkingBlocks(rawAccumulated);
  if (blocks.length === 0) return;
  const merged = blocks.join("\n\n");
  const parts = splitReasoning(merged, REASONING_CHUNK_MAX);

  // Closure-scoped: cooldown переносится между чанками внутри одного вызова,
  // но не между разными юзерами (sendReasoningMessages вызывается per-request).
  let blockedUntil = 0;

  const sendOne = async (body: string): Promise<void> => {
    for (let attempt = 1; attempt <= REASONING_SEND_MAX_ATTEMPTS; attempt++) {
      const waitMs = blockedUntil - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      try {
        await ctx.api.sendMessage(chatId, body, { parse_mode: "HTML" });
        return;
      } catch (err) {
        const retryMs = parseRetryAfterMs(err);
        if (retryMs === null) {
          // Не-429 ошибка (parse error, network drop) — повтор не поможет,
          // выходим сразу.
          logger.warn(err, "GPT reasoning: send failed");
          return;
        }
        // Запоминаем cooldown — следующая итерация (этого же чанка либо
        // следующего) подождёт нужное время через pre-wait check.
        blockedUntil = Date.now() + retryMs + 100;
        if (attempt === REASONING_SEND_MAX_ATTEMPTS) {
          logger.warn(
            { retryMs, attempts: attempt },
            "GPT reasoning: send still 429 after max attempts",
          );
        }
      }
    }
  };

  for (let i = 0; i < parts.length; i++) {
    const header =
      parts.length > 1
        ? `${ctx.t.gpt.reasoningHeader} (${ctx.t.gpt.reasoningPartLabel
            .replace("{index}", String(i + 1))
            .replace("{total}", String(parts.length))})`
        : ctx.t.gpt.reasoningHeader;
    const body = `<b>${escapeHtml(header)}</b>\n<blockquote expandable>${escapeHtml(
      parts[i]!,
    )}</blockquote>`;
    await sendOne(body);
  }
}

// ── Shared streaming helper ───────────────────────────────────────────────────

async function streamGptResponse(
  ctx: BotContext,
  chatId: number,
  dialogId: string,
  content: string,
  imageUrls?: string[],
  imageS3Keys?: string[],
  documentAttachments?: StoredAttachment[],
  promptMessageId?: number,
): Promise<void> {
  let placeholder = await ctx.reply("⏳", {
    ...(promptMessageId
      ? {
          reply_parameters: {
            message_id: promptMessageId,
            allow_sending_without_reply: true,
          },
        }
      : {}),
  });
  let accumulated = "";
  let lastEdit = Date.now();
  // 429 на edit означает per-chat rate-limit. Пока wall-clock < editBlockedUntil
  // не пытаемся делать preview-edit'ы — иначе только усугубляем cooldown.
  let editBlockedUntil = 0;

  /**
   * Доставка одного finalize-чанка. Для первого чанка пробуем edit плейсхолдера;
   * если получаем 429 с длинным cooldown'ом — переходим на sendMessage
   * (новое сообщение), чтобы юзер не ждал минуту-две Telegram'овского rate-limit.
   * Короткий cooldown (<= RETRY_AFTER_INLINE_MAX_MS) пересиживаем и пытаемся
   * edit ещё раз. На MarkdownV2-parse-fail падаем в plain-text. Subsequent
   * чанки всегда идут sendMessage'ом.
   */
  const deliverChunk = async (
    msgId: number,
    body: string,
    v2: string,
    isFirst: boolean,
  ): Promise<void> => {
    const tryEdit = async (text: string, withMarkdown: boolean): Promise<void> => {
      await ctx.api.editMessageText(
        chatId,
        msgId,
        text,
        withMarkdown ? { parse_mode: "MarkdownV2" } : {},
      );
    };
    const trySendRaw = async (text: string, withMarkdown: boolean): Promise<void> => {
      await ctx.api.sendMessage(chatId, text, withMarkdown ? { parse_mode: "MarkdownV2" } : {});
    };
    // sendMessage с уважением 429 retry_after и общего per-chat cooldown'а
    // (editBlockedUntil). Telegram 429 на отправку нельзя обойти plain-text'ом —
    // throttle per-chat. До MAX_ATTEMPTS попыток с sleep'ом между, дальше
    // сдаёмся (логируем). Non-429 ошибки (parse-fail и т.п.) бросаем наверх,
    // чтобы caller мог фолбэкнуться на plain text.
    const SEND_MAX_ATTEMPTS = 3;
    const trySend = async (text: string, withMarkdown: boolean): Promise<void> => {
      for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
        const waitMs = editBlockedUntil - Date.now();
        if (waitMs > 0) await sleep(waitMs);
        try {
          await trySendRaw(text, withMarkdown);
          return;
        } catch (err) {
          const retryMs = parseRetryAfterMs(err);
          if (retryMs === null) throw err;
          editBlockedUntil = Date.now() + retryMs + 100;
          if (attempt === SEND_MAX_ATTEMPTS) {
            logger.warn(
              { retryMs, attempts: attempt },
              "GPT finalize: send still 429 after max attempts, dropping chunk",
            );
            return;
          }
        }
      }
    };

    if (!isFirst) {
      // Subsequent части: всегда новое сообщение. Markdown → plain fallback.
      try {
        await trySend(v2, true);
      } catch (markdownErr) {
        logger.warn(markdownErr, "GPT finalize: MarkdownV2 send failed, retrying as plain text");
        await trySend(body, false).catch((plainErr) =>
          logger.error(plainErr, "GPT finalize: plain text send fallback also failed"),
        );
      }
      return;
    }

    // Первый чанк: editMessageText по плейсхолдеру.
    // Каскад: MarkdownV2-edit → 429-handle → plain-edit → 429-handle.
    // На любом 429 с retry_after > RETRY_AFTER_INLINE_MAX_MS не ждём, а
    // отдаём результат через sendMessage (плейсхолдер просто остаётся ⏳).
    const editWithRateLimit = async (text: string, withMarkdown: boolean): Promise<boolean> => {
      try {
        await tryEdit(text, withMarkdown);
        return true;
      } catch (err) {
        const retryMs = parseRetryAfterMs(err);
        if (retryMs === null) throw err;
        if (retryMs <= RETRY_AFTER_INLINE_MAX_MS) {
          editBlockedUntil = Date.now() + retryMs;
          await sleep(retryMs + 100);
          try {
            await tryEdit(text, withMarkdown);
            return true;
          } catch (retryErr) {
            const retryRetryMs = parseRetryAfterMs(retryErr);
            if (retryRetryMs !== null) {
              editBlockedUntil = Date.now() + retryRetryMs;
              logger.warn(
                { retryRetryMs },
                "GPT finalize: edit still 429 after wait, sending as new message",
              );
              return false;
            }
            throw retryErr;
          }
        }
        editBlockedUntil = Date.now() + retryMs;
        logger.warn(
          { retryMs },
          "GPT finalize: 429 cooldown too long for inline wait, sending as new message",
        );
        return false;
      }
    };

    try {
      const ok = await editWithRateLimit(v2, true);
      if (!ok) {
        await trySend(v2, true).catch((sendErr) =>
          logger.error(sendErr, "GPT finalize: send-as-new MarkdownV2 fallback failed"),
        );
      }
    } catch (markdownErr) {
      logger.warn(markdownErr, "GPT finalize: MarkdownV2 parse failed, retrying as plain text");
      try {
        const ok = await editWithRateLimit(body, false);
        if (!ok) {
          await trySend(body, false).catch((sendErr) =>
            logger.error(sendErr, "GPT finalize: send-as-new plain fallback failed"),
          );
        }
      } catch (plainErr) {
        logger.error(plainErr, "GPT finalize: plain text fallback also failed");
      }
    }
  };

  const finalizeMessage = async (msgId: number, text: string) => {
    // Бьём длинный итоговый текст на части ≤ FINAL_CHUNK_MAX по \n границам.
    // Телеграм режет на 4096 символов даже plain-text — без сплита `editMessage`
    // на ответе с code-блоком на 16к символов получаем `MESSAGE_TOO_LONG`.
    const parts: string[] = [];
    let remaining = text;
    while (remaining.length > FINAL_CHUNK_MAX) {
      const newlineIdx = remaining.lastIndexOf("\n", FINAL_CHUNK_MAX);
      const splitAt = newlineIdx > FINAL_CHUNK_MAX / 2 ? newlineIdx + 1 : FINAL_CHUNK_MAX;
      parts.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }
    if (remaining) parts.push(remaining);

    // Если split произошёл посреди ``` code-блока — закрываем на текущем chunk'е
    // и переоткрываем opener'ом на следующем, чтобы каждое сообщение
    // парсилось как самостоятельный markdown.
    let carryOpener = "";
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const raw = carryOpener + parts[i];
      let body: string;
      if (isLast) {
        body = raw;
        carryOpener = "";
      } else {
        const { closed, opener } = closeOpenMarkdownV2(raw);
        body = closed;
        carryOpener = opener;
      }
      const v2 = toMarkdownV2(body);
      await deliverChunk(msgId, body, v2, i === 0);
    }
  };

  try {
    const stream = chatService.sendMessageStream({
      dialogId,
      userId: ctx.user!.id,
      content,
      ...(imageUrls?.length ? { imageUrls } : {}),
      ...(imageS3Keys?.length ? { imageS3Keys } : {}),
      ...(documentAttachments?.length ? { documentAttachments } : {}),
    });

    // Захватываем return-value стрима (`SendMessageResult`) через manual
    // итерацию — for-await его теряет. Нужен для пост-show «списано X / баланс Y».
    let streamResult: SendMessageResult | undefined;
    while (true) {
      const next = await stream.next();
      if (next.done) {
        streamResult = next.value;
        break;
      }
      const chunk = next.value;
      accumulated += chunk;

      // Split into a new message when approaching Telegram's 4096-char limit.
      // `while` (а не `if`): один stream-chunk может прилететь огромным
      // (например, целый code-block залпом) — нужно вырезать столько кусков
      // подряд, сколько потребуется, иначе остаток уезжает в финал и там
      // уже не пролезает в 4096-лимит даже после finalize-сплита.
      while (true) {
        // Режем по длине ВИДИМОГО ответа, а не сырого `accumulated`: reasoning
        // (`<think>…</think>`) скрыт и уезжает отдельным сообщением в конце —
        // в 4096-лимит он не идёт. `<think>`-блок (reasoning стримится первым)
        // НИКОГДА не режем: срез внутри него оторвал бы `</think>` от `<think>`,
        // `stripThinkingBlocks` не сматчил бы пару — и reasoning утёк бы в текст
        // ответа (баг на «Макс.» глубине: reasoning длиннее одного сообщения).
        const thinkOpen = accumulated.indexOf("<think>");
        const thinkClose = accumulated.indexOf("</think>");
        // `<think>` ещё открыт — весь хвост reasoning, видимого ответа нет.
        if (thinkOpen !== -1 && thinkClose === -1) break;
        const thinkEnd = thinkClose === -1 ? 0 : thinkClose + "</think>".length;
        const thinkPrefix = accumulated.slice(0, thinkEnd);
        const answerPart = accumulated.slice(thinkEnd);
        if (answerPart.length < MSG_SPLIT_AT) break;
        // Prefer splitting at a newline; fall back to hard cut if none found in the latter half
        const newlineIdx = answerPart.lastIndexOf("\n", MSG_SPLIT_AT);
        const splitAt = newlineIdx > MSG_SPLIT_AT / 2 ? newlineIdx + 1 : MSG_SPLIT_AT;
        const firstPart = answerPart.slice(0, splitAt);
        const remainder = answerPart.slice(splitAt);
        const { closed, opener } = closeOpenMarkdownV2(stripThinkingBlocks(firstPart));
        await finalizeMessage(placeholder.message_id, closed);
        placeholder = await ctx.reply("⏳");
        accumulated = thinkPrefix + opener + remainder;
        lastEdit = Date.now();
      }

      const now = Date.now();
      // Если поймали 429 на edit'е — пропускаем preview-edit'ы пока cooldown
      // не истечёт. Финальный edit/send всё равно произойдёт в finalizeMessage.
      if (now < editBlockedUntil) continue;
      if (now - lastEdit >= EDIT_THROTTLE_MS && accumulated.trim()) {
        const visible = stripThinkingBlocks(accumulated);
        if (visible) {
          const preview = toMarkdownV2(closeOpenMarkdownV2(visible).closed) + " ▌";
          // Перехватываем 429 в обоих ветках (markdown + plain) и устанавливаем
          // editBlockedUntil — без этого продолжали бы биться в rate-limit
          // на каждом chunk'е и копить штраф.
          const handlePreviewError = (err: unknown, ctxLabel: string): void => {
            const retryMs = parseRetryAfterMs(err);
            if (retryMs !== null) {
              editBlockedUntil = Date.now() + retryMs;
              logger.warn({ retryMs }, `${ctxLabel}: rate-limited, deferring preview edits`);
            } else {
              logger.warn(err, `${ctxLabel}: edit failed`);
            }
          };
          await ctx.api
            .editMessageText(chatId, placeholder.message_id, preview, { parse_mode: "MarkdownV2" })
            .catch(async (err) => {
              const retryMs = parseRetryAfterMs(err);
              if (retryMs !== null) {
                editBlockedUntil = Date.now() + retryMs;
                logger.warn({ retryMs }, "GPT stream: rate-limited, deferring preview edits");
                return;
              }
              logger.warn(err, "GPT stream: markdown preview failed, retrying as plain text");
              await ctx.api
                .editMessageText(chatId, placeholder.message_id, visible + " ▌")
                .catch((e) => handlePreviewError(e, "GPT stream: plain text preview"));
            });
          lastEdit = now;
        }
      }
    }

    const finalText = stripThinkingBlocks(accumulated);
    if (finalText) {
      await finalizeMessage(placeholder.message_id, finalText);
    } else {
      await ctx.api.deleteMessage(chatId, placeholder.message_id).catch(() => void 0);
    }
    // Reasoning-сообщения шлём ПОСЛЕ финализации основного ответа. Если юзер
    // выключил тогл show_reasoning — адаптеры не yield'ят `<think>` маркеров,
    // extractThinkingBlocks вернёт [] и эта функция тихо ничего не пошлёт.
    await sendReasoningMessages(ctx, chatId, accumulated);

    // Cost-line отдельным сообщением, как просили — зеркалит cost-блок в
    // caption'ах image/video результатов (`generationCostLine`). Шлём только
    // если реально что-то списано (tokensUsed > 0) — на edge-cases вроде
    // admin'a/пустого ответа лишнее сообщение про «0 ✦» бесполезно.
    if (streamResult && streamResult.tokensUsed > 0) {
      const costLine = formatGenerationCostLine(
        ctx.t,
        streamResult.tokensUsed,
        streamResult.subscriptionTokenBalance,
        streamResult.tokenBalance,
      );
      await ctx.reply(costLine).catch((err) => {
        logger.warn(err, "GPT stream: failed to send cost-line, ignoring");
      });
    }
  } catch (err: unknown) {
    logger.error(err, "GPT message error");
    await ctx.api.deleteMessage(chatId, placeholder.message_id).catch(() => void 0);
    if (err instanceof Error && err.message === "NO_SUBSCRIPTION") {
      await replyNoSubscription(ctx);
    } else if (err instanceof Error && err.message === "INSUFFICIENT_TOKENS") {
      await replyInsufficientTokens(ctx);
    } else if (err instanceof DocumentNotSupportedError) {
      await ctx.reply(ctx.t.gpt.docModelNotSupported);
    } else if (err instanceof DocumentExtractFailedError) {
      await ctx.reply(ctx.t.gpt.docExtractFailed);
    } else if (err instanceof ContextOverflowError) {
      await ctx.reply(ctx.t.gpt.contextOverflow);
    } else if (err instanceof UserFacingError) {
      // Спец-кейс «модель только подумала» — i18n тексты outputLimitOnlyThinking
      // и modelOnlyThinking обещают «Размышления выше ☝», а в success-path
      // reasoning публикуется на строке выше (sendReasoningMessages после
      // finalizeMessage). В error-path placeholder удалён, reasoning не
      // отправлен — обещание невыполнено. Публикуем reasoning ДО error-текста
      // ровно в этих двух ветках; для других ошибок accumulated может
      // содержать reasoning, но показывать его без явной отсылки нет смысла.
      if (err.key === "outputLimitOnlyThinking" || err.key === "modelOnlyThinking") {
        await sendReasoningMessages(ctx, chatId, accumulated);
      }
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
      // Тех-канал получает alert только если UserFacingError просит об этом
      // (notifyOps=true) или несёт оригинальную ошибку через cause —
      // notifyTechError развернёт её через `caused by:` в alert'е.
      // Шлём САМ UFE (а не err.cause): notify-tech читает из UFE поле `tech`
      // (provider/модель на момент падения, флаг fallback'а), а сериализер всё
      // равно идёт по cause-chain и выводит raw provider error.
      if (err.notifyOps || err.cause !== undefined) {
        void notifyTechError(err, {
          section: "gpt",
          dialogId,
          userId: String(ctx.user!.id),
        });
      }
    } else {
      await ctx.reply(ctx.t.errors.unexpected);
      void notifyTechError(err, {
        section: "gpt",
        dialogId,
        userId: String(ctx.user!.id),
      });
    }
  }
}

// ── New dialog ────────────────────────────────────────────────────────────────

export async function createNewDialog(
  ctx: BotContext,
  modelId: string,
): Promise<string | undefined> {
  if (!ctx.user) return undefined;

  const dialog = await dialogService.create({
    userId: ctx.user.id,
    section: "gpt",
    modelId,
  });

  await userStateService.setState(ctx.user.id, "GPT_ACTIVE", "gpt");
  await userStateService.setDialogForSection(ctx.user.id, "gpt", dialog.id);

  const model = AI_MODELS[modelId];
  const hint = buildDialogHint(ctx.t, model);
  const text = hint ? `${ctx.t.gpt.newDialogCreated}\n\n${hint}` : ctx.t.gpt.newDialogCreated;
  await ctx.reply(text, { parse_mode: "HTML" });
  return dialog.id;
}

export async function handleNewGptDialog(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  const state = await userStateService.get(ctx.user.id);
  const activeDialog = !!state?.gptDialogId && (await dialogService.findById(state.gptDialogId));
  const modelId = activeDialog ? activeDialog.modelId : DEFAULT_GPT_MODEL;

  await createNewDialog(ctx, modelId);
}

// ── No-dialog prompt ─────────────────────────────────────────────────────────

async function replyNoActiveDialog(ctx: BotContext): Promise<void> {
  const webappUrl = config.bot.webappUrl;
  if (!webappUrl || !ctx.user || !ctx.user.telegramId) {
    await ctx.reply(ctx.t.gpt.noActiveDialog);
    return;
  }
  const token = generateWebToken(ctx.user.telegramId, config.bot.token);
  const kb = new InlineKeyboard().webApp(
    ctx.t.gpt.createDialog,
    `${webappUrl}?page=management&section=gpt&action=new&wtoken=${token}`,
  );
  await ctx.reply(ctx.t.gpt.noActiveDialog, { reply_markup: kb });
}

// ── Incoming message in active GPT dialog ────────────────────────────────────

/**
 * Executes a text prompt in the active GPT dialog.
 * Used by handleGptMessage (text) and the voice-prompt callback.
 */
export async function executeGptPrompt(
  ctx: BotContext,
  text: string,
  promptMessageId?: number,
): Promise<void> {
  if (!ctx.user) return;

  const gptDialogId = (await userStateService.get(ctx.user.id))?.gptDialogId ?? null;
  if (!gptDialogId) {
    await replyNoActiveDialog(ctx);
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  await streamGptResponse(
    ctx,
    chatId,
    gptDialogId,
    text,
    undefined,
    undefined,
    undefined,
    promptMessageId,
  );
}

export async function handleGptMessage(ctx: BotContext): Promise<void> {
  if (!ctx.user || !ctx.message?.text) return;
  await executeGptPrompt(ctx, ctx.message.text, ctx.message.message_id);
}

// ── Photo / document image in active GPT dialog ───────────────────────────────

export async function handleGptPhoto(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  const gptDialogId = (await userStateService.get(ctx.user.id))?.gptDialogId ?? null;
  if (!gptDialogId) {
    await replyNoActiveDialog(ctx);
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Активная модель диалога без vision-режима (o3-mini, deepseek и т.п.) —
  // не имеет смысла гнать фото в провайдера: OpenAI/Anthropic вернут 400
  // («model does not support image inputs»), юзер получит generic ошибку и
  // мы зря потратим попытку. Зеркало design.ts:643.
  const dialog = await dialogService.findById(gptDialogId);
  const model = dialog ? AI_MODELS[dialog.modelId] : undefined;
  if (model && !model.supportsImages) {
    const mediaGroupId = ctx.message?.media_group_id;
    // Альбом: один update на фото, дедупим предупреждение через буфер.
    if (mediaGroupId) {
      const key = `${ctx.user.id}__${mediaGroupId}`;
      if (noImageWarningBuffer.has(key)) {
        // Caption обрабатываем только на первом фото — игнорируем последующие.
        return;
      }
      noImageWarningBuffer.set(key, {
        timer: setTimeout(() => noImageWarningBuffer.delete(key), 10_000),
      });
    }
    await ctx.reply(
      ctx.t.errors.modelDoesNotSupportImages.replace("{modelName}", model.name ?? dialog!.modelId),
    );
    // Caption — это полноценный пользовательский промпт; прогоняем как обычный текст.
    const captionText = ctx.message?.caption?.trim();
    if (captionText) {
      await streamGptResponse(
        ctx,
        chatId,
        gptDialogId,
        captionText,
        undefined,
        undefined,
        undefined,
        ctx.message?.message_id,
      );
    }
    return;
  }

  // Resolve file ID — photo (compressed) or document (original file)
  let fileId: string;
  if (ctx.message?.photo) {
    fileId = ctx.message.photo.at(-1)!.file_id;
  } else if (ctx.message?.document?.mime_type?.startsWith("image/")) {
    fileId = ctx.message.document.file_id;
  } else {
    return;
  }

  const file = await ctx.api.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
  const caption = ctx.message?.caption?.trim() ?? "";
  const mediaGroupId = ctx.message?.media_group_id;

  // Upload to S3 and get presigned URL; fall back to Telegram URL if S3 not available
  const uploadPhoto = async (
    telegramUrl: string,
  ): Promise<{ url: string; s3Key: string | null }> => {
    try {
      const res = await fetch(telegramUrl);
      if (!res.ok) return { url: telegramUrl, s3Key: null };
      const buffer = Buffer.from(await res.arrayBuffer());
      const s3Key = `chat/${ctx.user!.id}/${randomUUID()}.jpg`;
      const uploaded = await uploadBuffer(s3Key, buffer, "image/jpeg");
      if (!uploaded) return { url: telegramUrl, s3Key: null };
      const presigned = await getFileUrl(s3Key);
      return { url: presigned ?? telegramUrl, s3Key };
    } catch {
      return { url: telegramUrl, s3Key: null };
    }
  };

  if (mediaGroupId) {
    // Buffer photos from the same album and process together after 800 ms silence
    const key = `${ctx.user.id}__${mediaGroupId}`;
    const { url, s3Key } = await uploadPhoto(tgUrl);
    const existing = mediaGroupBuffer.get(key);

    if (existing) {
      clearTimeout(existing.timer);
      existing.urls.push(url);
      if (s3Key) existing.s3Keys = [...(existing.s3Keys ?? []), s3Key];
      if (!existing.caption && caption) existing.caption = caption;
      existing.timer = setTimeout(() => {
        mediaGroupBuffer.delete(key);
        const prompt = existing.caption || existing.ctx.t.gpt.photoDefaultPrompt;
        void streamGptResponse(
          existing.ctx,
          existing.chatId,
          existing.dialogId,
          prompt,
          existing.urls,
          existing.s3Keys,
          undefined,
          existing.ctx.message?.message_id,
        );
      }, 800);
    } else {
      const entry: MediaGroupEntry = {
        dialogId: gptDialogId,
        userId: ctx.user.id,
        chatId,
        urls: [url],
        s3Keys: s3Key ? [s3Key] : [],
        caption,
        ctx,
        timer: setTimeout(() => {
          mediaGroupBuffer.delete(key);
          const prompt = entry.caption || ctx.t.gpt.photoDefaultPrompt;
          void streamGptResponse(
            ctx,
            chatId,
            gptDialogId,
            prompt,
            entry.urls,
            entry.s3Keys.length ? entry.s3Keys : undefined,
            undefined,
            ctx.message?.message_id,
          );
        }, 800),
      };
      mediaGroupBuffer.set(key, entry);
    }
  } else {
    // Single photo — process immediately
    const { url, s3Key } = await uploadPhoto(tgUrl);
    const prompt = caption || ctx.t.gpt.photoDefaultPrompt;
    await streamGptResponse(
      ctx,
      chatId,
      gptDialogId,
      prompt,
      [url],
      s3Key ? [s3Key] : undefined,
      undefined,
      ctx.message?.message_id,
    );
  }
}

// ── Document (PDF) in active GPT dialog ───────────────────────────────────────

export async function handleGptDocument(ctx: BotContext): Promise<void> {
  if (!ctx.user || !ctx.message?.document) return;

  const gptDialogId = (await userStateService.get(ctx.user.id))?.gptDialogId ?? null;
  if (!gptDialogId) {
    await replyNoActiveDialog(ctx);
    return;
  }

  const doc = ctx.message.document;
  const rawMime = doc.mime_type ?? "application/octet-stream";
  const name = doc.file_name ?? "document";
  const size = doc.file_size ?? 0;

  // Resolve mime: whitelist check, fall back to extension inference for
  // generic application/octet-stream uploads from Telegram clients.
  const ext = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  let mime = rawMime;
  if (!ALLOWED_DOC_MIMES.has(mime)) {
    const inferred = ext ? EXT_TO_MIME[ext] : undefined;
    if (inferred) mime = inferred;
    else {
      await ctx.reply(ctx.t.gpt.docUnsupportedType);
      return;
    }
  }
  if (size > MAX_DOC_SIZE) {
    await ctx.reply(ctx.t.gpt.docTooLarge);
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Download from Telegram → upload to S3
  let attachment: StoredAttachment | null = null;
  try {
    const file = await ctx.api.getFile(doc.file_id);
    const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
    const res = await fetch(tgUrl);
    if (!res.ok) throw new Error(`Telegram download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const s3Key = `chat-docs/${ctx.user.id}/${randomUUID()}${ext ?? ""}`;
    const uploaded = await uploadBuffer(s3Key, buffer, mime);
    if (!uploaded) throw new Error("S3 upload returned false");
    attachment = { s3Key, mimeType: mime, name, size };
  } catch (err) {
    logger.error(err, "handleGptDocument: download/upload failed");
    await ctx.reply(ctx.t.gpt.docUploadFailed);
    return;
  }

  const caption = ctx.message.caption?.trim() ?? "";
  const mediaGroupId = ctx.message.media_group_id;

  if (mediaGroupId) {
    const key = `${ctx.user.id}__${mediaGroupId}`;
    const existing = documentGroupBuffer.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.attachments.push(attachment);
      if (!existing.caption && caption) existing.caption = caption;
      existing.timer = setTimeout(() => {
        documentGroupBuffer.delete(key);
        const prompt = existing.caption || existing.ctx.t.gpt.docDefaultPrompt;
        void streamGptResponse(
          existing.ctx,
          existing.chatId,
          existing.dialogId,
          prompt,
          undefined,
          undefined,
          existing.attachments,
          existing.ctx.message?.message_id,
        );
      }, 800);
    } else {
      const entry: DocumentGroupEntry = {
        dialogId: gptDialogId,
        userId: ctx.user.id,
        chatId,
        attachments: [attachment],
        caption,
        ctx,
        timer: setTimeout(() => {
          documentGroupBuffer.delete(key);
          const prompt = entry.caption || ctx.t.gpt.docDefaultPrompt;
          void streamGptResponse(
            ctx,
            chatId,
            gptDialogId,
            prompt,
            undefined,
            undefined,
            entry.attachments,
            ctx.message?.message_id,
          );
        }, 800),
      };
      documentGroupBuffer.set(key, entry);
    }
  } else {
    const prompt = caption || ctx.t.gpt.docDefaultPrompt;
    await streamGptResponse(
      ctx,
      chatId,
      gptDialogId,
      prompt,
      undefined,
      undefined,
      [attachment],
      ctx.message?.message_id,
    );
  }
}

// ── Voice / audio message in active GPT dialog ─────────────────────────────────

export async function handleGptVoice(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  const gptDialogId = (await userStateService.get(ctx.user.id))?.gptDialogId ?? null;
  if (!gptDialogId) {
    await replyNoActiveDialog(ctx);
    return;
  }

  await transcribeAndReply(ctx, "gpt");
}

// ── Management — opens Mini App ───────────────────────────────────────────────

export async function handleGptManagement(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const webappUrl = config.bot.webappUrl;
  if (!webappUrl) {
    await ctx.reply(ctx.t.errors.unexpected);
    return;
  }
  const kb = new InlineKeyboard().webApp(
    ctx.t.gpt.management,
    `${webappUrl}?page=management&section=gpt`,
  );
  await ctx.reply(ctx.t.gpt.management, { reply_markup: kb });
}

// ── Prompts (stub — full implementation pending) ──────────────────────────────

// export async function handleGptPrompts(ctx: BotContext): Promise<void> {
//   if (!ctx.user) return;
//   await ctx.reply(ctx.t.gpt.prompts + ctx.t.common.comingSoon);
// }
