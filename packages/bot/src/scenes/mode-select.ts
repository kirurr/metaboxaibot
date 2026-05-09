import type { BotContext } from "../types/context.js";
import {
  AI_MODELS,
  config,
  getResolvedModes,
  getActiveSlots,
  isKnownModeId,
} from "@metabox/shared";
import { userStateService } from "@metabox/api/services";
import { InlineKeyboard } from "grammy";
import {
  buildMediaInputStatusMenu,
  buildModePickerMenu,
  clearActiveSlot,
} from "../utils/media-input-state.js";
import { refreshMediaHint } from "../utils/media-hint.js";

/**
 * Callback handler for `mode:<section>:<modelId>:<modeId>`. Persists the
 * selection, removes the picker message, and follows up with the mode-
 * activation message + slot keyboard filtered to this mode's slots.
 *
 * Routes both `mode:video:*` and `mode:design:*` — the section is encoded
 * in the data so a single handler covers both scenes.
 */
export async function handleModeSet(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  if (parts.length < 4 || parts[0] !== "mode") {
    await ctx.answerCallbackQuery();
    return;
  }
  const section = parts[1];
  const modelId = parts[2];
  const modeId = parts.slice(3).join(":");

  if (section !== "video" && section !== "design") {
    await ctx.answerCallbackQuery();
    return;
  }
  const model = AI_MODELS[modelId];
  if (!model || !isKnownModeId(model, modeId)) {
    await ctx.answerCallbackQuery();
    return;
  }
  const modes = getResolvedModes(model);
  const mode = modes?.find((m) => m.id === modeId);
  if (!mode) {
    await ctx.answerCallbackQuery();
    return;
  }

  await userStateService.setSelectedMode(ctx.user.id, modelId, modeId);
  // Re-clear any in-flight active slot from a prior mode so the next upload
  // routes through the new mode's slot set.
  clearActiveSlot(ctx.user.id);

  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => void 0);

  const modeLabel = String(
    ctx.t.modelModes[mode.labelKey as keyof typeof ctx.t.modelModes] ?? mode.labelKey,
  );
  const webappUrl = config.bot.webappUrl;
  const kb = new InlineKeyboard();
  const mgmtLabel = section === "video" ? ctx.t.video.management : ctx.t.design.management;

  if (mode.textOnly) {
    kb.text(ctx.t.modelModes.change, `change_mode:${section}:${modelId}`).row();
    if (webappUrl) kb.webApp(mgmtLabel, `${webappUrl}?page=management&section=${section}`);
    const text = ctx.t.modelModes.activatedTextOnly.replace("{mode}", modeLabel);
    await ctx.reply(text, { reply_markup: kb.inline_keyboard.length ? kb : undefined });
    await refreshMediaHint(ctx, section, modelId);
    return;
  }

  const activeSlots = getActiveSlots(model, modeId);
  const filledInputs = await userStateService.getMediaInputs(ctx.user.id, modelId);
  const { kb: slotsKb } = buildMediaInputStatusMenu(activeSlots, filledInputs, section, ctx.t, {
    promptOptional: model.promptOptional,
    promptOptionalRequiresMedia: model.promptOptionalRequiresMedia,
  });
  for (const row of slotsKb.inline_keyboard) kb.row(...row);
  kb.text(ctx.t.modelModes.change, `change_mode:${section}:${modelId}`).row();
  if (webappUrl) kb.webApp(mgmtLabel, `${webappUrl}?page=management&section=${section}`);
  const text = ctx.t.modelModes.activated.replace("{mode}", modeLabel);
  await ctx.reply(text, { reply_markup: kb.inline_keyboard.length ? kb : undefined });
  await refreshMediaHint(ctx, section, modelId);
}

/**
 * Callback handler for `change_mode:<section>:<modelId>`. Removes the current
 * mode-activated message and shows the mode picker again so the user can
 * pick a different mode without re-activating the model.
 */
export async function handleChangeMode(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  if (parts.length < 3 || parts[0] !== "change_mode") {
    await ctx.answerCallbackQuery();
    return;
  }
  const section = parts[1];
  const modelId = parts.slice(2).join(":");
  if (section !== "video" && section !== "design") {
    await ctx.answerCallbackQuery();
    return;
  }
  const model = AI_MODELS[modelId];
  const modes = model ? getResolvedModes(model) : null;
  if (!model || !modes) {
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => void 0);

  const { text, kb } = buildModePickerMenu(modes, section, modelId, ctx.t);
  await ctx.reply(text, { reply_markup: kb });
}
