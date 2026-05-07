import { getStoredTranscription } from "../utils/voice-transcribe.js";
import { executeGptPrompt } from "../scenes/gpt.js";
import { executeDesignPrompt } from "../scenes/design.js";
import { executeVideoPrompt } from "../scenes/video.js";
import { executeAudioPrompt } from "../scenes/audio.js";
import { acquireLock } from "../utils/dedup.js";
import { logger } from "../logger.js";
import type { BotContext } from "../types/context.js";

/**
 * Handles the "Use as prompt" inline button callback after voice transcription.
 * Callback data format: `vp:{section}:{id}`
 */
export async function handleVoicePromptCallback(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const parts = data.split(":");
  if (parts.length < 3) return;

  const section = parts[1];
  const id = parts[2];

  try {
    const acquired = await acquireLock(`dedup:gen:vp:${ctx.user.id}:${id}`, 120);
    if (!acquired) {
      await ctx.answerCallbackQuery({ text: ctx.t.errors.alreadyGenerating });
      return;
    }
  } catch {
    // fail-open: proceed if Redis unavailable
  }

  await ctx.answerCallbackQuery();

  const stored = getStoredTranscription(ctx.user.id, id);
  if (!stored) {
    await ctx.reply(ctx.t.voice.expired);
    return;
  }
  const { text, voiceMessageId } = stored;

  logger.debug({ section, textLength: text.length }, "voicePromptCallback: executing prompt");

  switch (section) {
    case "gpt":
      await executeGptPrompt(ctx, text, voiceMessageId);
      break;
    case "design":
      await executeDesignPrompt(ctx, text, undefined, voiceMessageId);
      break;
    case "video":
      await executeVideoPrompt(ctx, text, undefined, voiceMessageId);
      break;
    case "audio":
      await executeAudioPrompt(ctx, text, voiceMessageId);
      break;
    default:
      logger.warn({ section }, "voicePromptCallback: unknown section");
  }
}
