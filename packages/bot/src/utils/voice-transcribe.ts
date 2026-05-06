import { randomBytes } from "crypto";
import { InlineKeyboard } from "grammy";
import { config } from "@metabox/shared";
import { transcribeAudio } from "@metabox/api/services/transcription";
import { logger } from "../logger.js";
import type { BotContext } from "../types/context.js";

// ── Transcription text store (TTL 10 min, max 500 entries) ──────────────────

const STORE_TTL_MS = 10 * 60 * 1000;
const STORE_MAX = 500;

interface StoreEntry {
  text: string;
  /** message_id of the original voice/audio message — so the result reply targets it. */
  voiceMessageId?: number;
  expiresAt: number;
}

const store = new Map<string, StoreEntry>();

function storeKey(userId: bigint, id: string): string {
  return `${userId}:${id}`;
}

function randomId(): string {
  return randomBytes(6).toString("hex");
}

function pruneStore(): void {
  if (store.size <= STORE_MAX) return;
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt < now) store.delete(key);
  }
  // If still over limit, drop oldest entries
  while (store.size > STORE_MAX) {
    const first = store.keys().next().value;
    if (first !== undefined) store.delete(first);
  }
}

export function storeTranscription(
  userId: bigint,
  id: string,
  text: string,
  voiceMessageId?: number,
): void {
  pruneStore();
  store.set(storeKey(userId, id), {
    text,
    voiceMessageId,
    expiresAt: Date.now() + STORE_TTL_MS,
  });
}

export function getStoredTranscription(
  userId: bigint,
  id: string,
): { text: string; voiceMessageId?: number } | null {
  const entry = store.get(storeKey(userId, id));
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(storeKey(userId, id));
    return null;
  }
  return { text: entry.text, voiceMessageId: entry.voiceMessageId };
}

// ── MarkdownV2 escaping ─────────────────────────────────────────────────────

const MD2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MD2_SPECIAL, "\\$&");
}

// ── Main transcribe-and-reply helper ────────────────────────────────────────

export type VoiceSection = "gpt" | "design" | "video" | "audio";

/**
 * Transcribes a voice/audio message and replies with the result + "Use as prompt" button.
 * Returns the transcribed text, or null on failure.
 */
export async function transcribeAndReply(
  ctx: BotContext,
  section: VoiceSection,
): Promise<string | null> {
  if (!ctx.user) return null;
  const audioMsg = ctx.message?.voice ?? ctx.message?.audio;
  if (!audioMsg) return null;

  const chatId = ctx.chat?.id;
  if (!chatId) return null;

  // Show pending message
  const pendingMsg = await ctx.reply(ctx.t.voice.transcribing);

  try {
    // Download audio from Telegram
    const file = await ctx.api.getFile(audioMsg.file_id);
    const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
    const res = await fetch(tgUrl);
    if (!res.ok) throw new Error(`Telegram download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    // Determine mime type
    const isVoice = !!ctx.message?.voice;
    const mime = isVoice ? "audio/ogg" : (ctx.message?.audio?.mime_type ?? "audio/mpeg");

    // Map user language to Whisper language code (2-letter ISO 639-1)
    const lang = ctx.user.language === "ru" ? "ru" : undefined;

    // Transcribe
    const text = await transcribeAudio(buffer, mime, lang);

    // Delete pending message
    await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);

    if (!text.trim()) {
      await ctx.reply(ctx.t.voice.failed);
      return null;
    }

    // Generate a short random ID for the callback data
    const id = randomId();

    // Store the transcribed text before sending (so the callback can find it immediately)
    storeTranscription(ctx.user.id, id, text, ctx.message?.message_id);

    // Build MarkdownV2 message with expandable blockquote for easy copying
    const header = escapeMarkdownV2(ctx.t.voice.transcriptionResult);
    const hint = escapeMarkdownV2(ctx.t.voice.transcriptionHint);
    const quotedText = "```\n".concat(escapeMarkdownV2(text), "```\n");
    const md2Text = `${header}\n\n${quotedText}\n\n${hint}`;

    const kb = new InlineKeyboard().text(ctx.t.voice.useAsPrompt, `vp:${section}:${id}`);

    await ctx.reply(md2Text, {
      parse_mode: "MarkdownV2",
      reply_markup: kb,
    });

    return text;
  } catch (err) {
    logger.error(err, "transcribeAndReply: failed");
    await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);
    await ctx.reply(ctx.t.voice.failed);
    return null;
  }
}
