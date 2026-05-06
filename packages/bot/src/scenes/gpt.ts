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
import type { StoredAttachment } from "@metabox/api/services";
import { logger } from "../logger.js";
import {
  config,
  AI_MODELS,
  buildDialogHint,
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
    const trySend = async (text: string, withMarkdown: boolean): Promise<void> => {
      await ctx.api.sendMessage(chatId, text, withMarkdown ? { parse_mode: "MarkdownV2" } : {});
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

    for await (const chunk of stream) {
      accumulated += chunk;

      // Split into a new message when approaching Telegram's 4096-char limit.
      // `while` (а не `if`): один stream-chunk может прилететь огромным
      // (например, целый code-block залпом) — нужно вырезать столько кусков
      // подряд, сколько потребуется, иначе остаток уезжает в финал и там
      // уже не пролезает в 4096-лимит даже после finalize-сплита.
      while (accumulated.length >= MSG_SPLIT_AT) {
        // Prefer splitting at a newline; fall back to hard cut if none found in the latter half
        const newlineIdx = accumulated.lastIndexOf("\n", MSG_SPLIT_AT);
        const splitAt = newlineIdx > MSG_SPLIT_AT / 2 ? newlineIdx + 1 : MSG_SPLIT_AT;
        const firstPart = accumulated.slice(0, splitAt);
        const remainder = accumulated.slice(splitAt);
        const { closed, opener } = closeOpenMarkdownV2(stripThinkingBlocks(firstPart));
        await finalizeMessage(placeholder.message_id, closed);
        placeholder = await ctx.reply("⏳");
        accumulated = opener + remainder;
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
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
      // Тех-канал получает alert только если UserFacingError просит об этом
      // (notifyOps=true) или несёт оригинальную ошибку через cause —
      // notifyTechError развернёт её через `caused by:` в alert'е.
      if (err.notifyOps || err.cause !== undefined) {
        void notifyTechError(err.cause ?? err, {
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
  if (!webappUrl || !ctx.user) {
    await ctx.reply(ctx.t.gpt.noActiveDialog);
    return;
  }
  const token = generateWebToken(ctx.user.id, config.bot.token);
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
