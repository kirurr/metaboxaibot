import type { BotContext } from "../types/context.js";
import { userStateService } from "@metabox/api/services";
import { buildDesignModelKeyboard } from "../scenes/design.js";
import { buildVideoModelKeyboard } from "../scenes/video.js";
import { MODELS_BY_SECTION, config, generateWebToken } from "@metabox/shared";
import { InlineKeyboard } from "grammy";

function buildAudioModelKeyboard(): InlineKeyboard {
  const models = MODELS_BY_SECTION["audio"] ?? [];
  const kb = new InlineKeyboard();
  const rows = models.map((m) => [m.name, `audio_model:${m.id}`] as [string, string]);
  for (let i = 0; i < rows.length; i += 2) {
    kb.text(rows[i][0], rows[i][1]);
    if (rows[i + 1]) kb.text(rows[i + 1][0], rows[i + 1][1]);
    kb.row();
  }
  return kb;
}

/** Sent when the user writes a message but no tool/section is active. */
export async function handleNoTool(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  const state = await userStateService.get(ctx.user.id);
  const section = state?.section;

  if (section === "gpt") {
    const webappUrl = config.bot.webappUrl;
    const token =
      webappUrl && ctx.user.telegramId
        ? generateWebToken(ctx.user.telegramId, config.bot.token)
        : "";
    const kb = new InlineKeyboard();
    if (webappUrl) {
      kb.webApp(ctx.t.gpt.management, `${webappUrl}?page=management&section=gpt&wtoken=${token}`);
    }
    await ctx.reply(ctx.t.errors.noToolGpt, { reply_markup: kb });
    return;
  }

  if (section === "design") {
    const kb = buildDesignModelKeyboard(state?.designModelId);
    await ctx.reply(ctx.t.errors.noToolDesign, { reply_markup: kb });
    return;
  }

  if (section === "audio") {
    const kb = buildAudioModelKeyboard();
    await ctx.reply(ctx.t.errors.noToolAudio, { reply_markup: kb });
    return;
  }

  if (section === "video") {
    const kb = buildVideoModelKeyboard(state?.videoModelId);
    await ctx.reply(ctx.t.errors.noToolVideo, { reply_markup: kb });
    return;
  }

  // No section active — show section picker
  const kb = new InlineKeyboard()
    .text(ctx.t.menu.gpt, "section:gpt")
    .text(ctx.t.menu.design, "section:design")
    .row()
    .text(ctx.t.menu.audio, "section:audio")
    .text(ctx.t.menu.video, "section:video");
  await ctx.reply(ctx.t.errors.noTool, { reply_markup: kb });
}
