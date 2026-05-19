import type { BotContext } from "../types/context.js";
import { buildMainMenuKeyboard } from "../keyboards/main-menu.keyboard.js";
import { userStateService, dialogService } from "@metabox/api/services";
import {
  config,
  generateWebToken,
  AI_MODELS,
  buildDialogHint,
  FACE_SWAP_BUFFER_MODEL_ID,
} from "@metabox/shared";
import type { Section } from "@metabox/shared";
import { buildDesignModelKeyboard } from "../scenes/design.js";
import { buildVideoModelKeyboard } from "../scenes/video.js";
import { clearActiveSlot } from "../utils/media-input-state.js";

/** Returns the active dialog label + modelId for a section, or undefined. */
async function activeDialogInfo(
  userId: bigint,
  section: string,
): Promise<{ label: string; modelId: string } | undefined> {
  const dialogId = await userStateService.getDialogForSection(userId, section as Section);
  if (!dialogId) return undefined;
  const dialog = await dialogService.findById(dialogId);
  if (!dialog) return undefined;
  return { label: dialog.title ?? dialog.modelId, modelId: dialog.modelId };
}

export async function handleMenu(ctx: BotContext): Promise<void> {
  if (ctx.user) {
    await userStateService.setState(ctx.user.id, "MAIN_MENU", null);
    // Гасим висящий face-swap буфер на случай, если юзер выпрыгнул из flow на
    // середине шага: не оставляем S3-ключи мёртвыми в user-state.
    await userStateService
      .clearMediaInputs(ctx.user.id, FACE_SWAP_BUFFER_MODEL_ID)
      .catch(() => void 0);
    clearActiveSlot(ctx.user.id);
  }
  await ctx.reply(ctx.t.start.mainMenuTitle, {
    reply_markup: buildMainMenuKeyboard(ctx.t, ctx.user?.telegramId),
  });
}

export async function handleScenarios(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  clearActiveSlot(ctx.user.id);
  await userStateService.setState(ctx.user.id, "SCENARIOS_SECTION", null);
  await ctx.reply(ctx.t.scenarios.sectionTitle, {
    reply_markup: {
      keyboard: [[{ text: ctx.t.scenarios.faceSwap }], [{ text: ctx.t.scenarios.backToMain }]],
      resize_keyboard: true,
      is_persistent: true,
    },
  });
}

export async function handleGpt(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  clearActiveSlot(ctx.user.id);
  const info = await activeDialogInfo(ctx.user.id, "gpt");
  // If a dialog is already active — go straight to GPT_ACTIVE so the user
  // can start chatting immediately without pressing an extra button.
  const newState = info ? "GPT_ACTIVE" : "GPT_SECTION";
  await userStateService.setState(ctx.user.id, newState, "gpt");

  let text = info
    ? `${ctx.t.gpt.sectionTitle}\n\n💬 Активный диалог: ${info.label}`
    : ctx.t.gpt.sectionTitle;

  if (info) {
    const hint = buildDialogHint(ctx.t, AI_MODELS[info.modelId]);
    if (hint) text += `\n\n${hint}`;
  }

  const webappUrl = config.bot.webappUrl;
  const token =
    webappUrl && ctx.user.telegramId ? generateWebToken(ctx.user.telegramId, config.bot.token) : "";
  const newDialogBtn = webappUrl
    ? {
        text: ctx.t.gpt.newDialog,
        web_app: { url: `${webappUrl}?page=management&section=gpt&action=new&wtoken=${token}` },
      }
    : { text: ctx.t.gpt.newDialog };
  const managementBtn = webappUrl
    ? {
        text: ctx.t.gpt.management,
        web_app: { url: `${webappUrl}?page=management&section=gpt&wtoken=${token}` },
      }
    : { text: ctx.t.gpt.management };

  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: {
      keyboard: [[newDialogBtn], [managementBtn], [{ text: ctx.t.common.backToMain }]],
      resize_keyboard: true,
      is_persistent: true,
    },
  });
}

export async function handleDesign(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  clearActiveSlot(ctx.user.id);
  const state = await userStateService.get(ctx.user.id);
  await userStateService.setState(ctx.user.id, "DESIGN_SECTION", "design");
  const text = ctx.t.design.sectionTitle;

  const webappUrl = config.bot.webappUrl;
  const token =
    webappUrl && ctx.user.telegramId ? generateWebToken(ctx.user.telegramId, config.bot.token) : "";
  const managementBtn = webappUrl
    ? {
        text: ctx.t.design.management,
        web_app: { url: `${webappUrl}?page=management&section=design&wtoken=${token}` },
      }
    : { text: ctx.t.design.management };

  await ctx.reply(text, {
    reply_markup: {
      keyboard: [
        [{ text: ctx.t.design.chooseModel }],
        [managementBtn],
        [{ text: ctx.t.common.backToMain }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    },
  });
  await ctx.reply(ctx.t.design.sectionTooltip, {
    reply_markup: buildDesignModelKeyboard(state?.designModelId),
  });
}

export async function handleAudio(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  clearActiveSlot(ctx.user.id);
  await userStateService.setState(ctx.user.id, "AUDIO_SECTION", "audio");

  const webappUrl = config.bot.webappUrl;
  const token =
    webappUrl && ctx.user.telegramId ? generateWebToken(ctx.user.telegramId, config.bot.token) : "";
  const managementBtn = webappUrl
    ? {
        text: ctx.t.audio.management,
        web_app: { url: `${webappUrl}?page=management&section=audio&wtoken=${token}` },
      }
    : { text: ctx.t.audio.management };

  await ctx.reply(ctx.t.audio.sectionTitle, {
    reply_markup: {
      keyboard: [
        [{ text: ctx.t.audio.tts }, { text: ctx.t.audio.voiceClone }],
        [{ text: ctx.t.audio.music }, { text: ctx.t.audio.sounds }],
        [managementBtn],
        [{ text: ctx.t.common.backToMain }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    },
  });
}

export async function handleVideo(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  clearActiveSlot(ctx.user.id);
  const state = await userStateService.get(ctx.user.id);
  await userStateService.setState(ctx.user.id, "VIDEO_SECTION", "video");

  const webappUrl = config.bot.webappUrl;
  const token =
    webappUrl && ctx.user.telegramId ? generateWebToken(ctx.user.telegramId, config.bot.token) : "";
  const managementBtn = webappUrl
    ? {
        text: ctx.t.video.management,
        web_app: { url: `${webappUrl}?page=management&section=video&wtoken=${token}` },
      }
    : { text: ctx.t.video.management };

  await ctx.reply(ctx.t.video.sectionTitle, {
    reply_markup: {
      keyboard: [
        [{ text: ctx.t.video.newDialog }],
        [{ text: ctx.t.video.avatars }, { text: ctx.t.video.lipSync }],
        [managementBtn],
        [{ text: ctx.t.common.backToMain }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    },
  });
  await ctx.reply(ctx.t.video.sectionTooltip, {
    reply_markup: buildVideoModelKeyboard(state?.videoModelId),
  });
}
