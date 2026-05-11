import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { userStateService } from "../services/user-state.service.js";
import { calculateCost, computeVideoTokens, usdToTokens } from "../services/token.service.js";
import { getModelMultiplier } from "../services/pricing-config.service.js";
import { db } from "../db.js";
import {
  AI_MODELS,
  config,
  generateWebToken,
  getT,
  resolveModelDisplay,
  getResolvedModes,
  resolveActiveMode,
  getActiveSlots,
  voiceCloneReturnRedisKey,
  type AIModel,
  type Section,
  type Translations,
} from "@metabox/shared";
import type { Language } from "@metabox/shared";
import { getRedis } from "../redis.js";
import { logger } from "../logger.js";
import { constructOpenAPIonRouteHook } from "../utils/openapi.js";

type AuthRequest = FastifyRequest & { userId: bigint };

/**
 * Build localised cost line with optional min–max range.
 * Range is derived from costVariants or costMatrix when they differ.
 */
function buildActivationCostLine(
  model: AIModel,
  modelSettings: Record<string, unknown>,
  t: Translations,
  defaultDuration?: number,
): string {
  const isPerMPixel = (model.costUsdPerMPixel ?? 0) > 0;
  const isPerSecond = model.costUsdPerSecond !== undefined && model.costUsdPerSecond > 0;
  const isPerKChar = model.costUsdPerKChar !== undefined;

  if (isPerMPixel) {
    const cost = calculateCost(model, 0, 0, 1.0, undefined, modelSettings);
    return t.common.costPerMPixel.replace("{cost}", cost.toFixed(2));
  }

  if (isPerKChar) {
    if (model.costVariants) {
      const costs = Object.keys(model.costVariants.map).map((k) =>
        calculateCost(
          model,
          0,
          0,
          undefined,
          undefined,
          { [model.costVariants!.settingKey]: k },
          undefined,
          1000,
        ),
      );
      const min = Math.min(...costs);
      const max = Math.max(...costs);
      if (min < max) {
        return t.common.costRangePerKChar
          .replace("{min}", min.toFixed(2))
          .replace("{max}", max.toFixed(2));
      }
    }
    const cost = calculateCost(model, 0, 0, undefined, undefined, modelSettings, undefined, 1000);
    return t.common.costPerKChar.replace("{cost}", cost.toFixed(2));
  }

  // Compute cost range via costVariants
  if (model.costVariants) {
    const durationArg = isPerSecond ? 1 : undefined;
    const costs = Object.keys(model.costVariants.map).map((k) =>
      calculateCost(
        model,
        0,
        0,
        undefined,
        undefined,
        { [model.costVariants!.settingKey]: k },
        durationArg,
      ),
    );
    const min = Math.min(...costs);
    const max = Math.max(...costs);
    if (min < max) {
      if (isPerSecond) {
        return t.common.costRangePerSecond
          .replace("{min}", min.toFixed(2))
          .replace("{max}", max.toFixed(2));
      }
      return t.common.costRangePerRequest
        .replace("{min}", min.toFixed(2))
        .replace("{max}", max.toFixed(2));
    }
    // min === max: fall through to single-value display below
  }

  // Compute cost range via costMatrix
  if (model.costMatrix && !model.costVariants) {
    const multiplier = getModelMultiplier(model.id);
    const costs = Object.values(model.costMatrix.table).map(
      (v) => usdToTokens(v as number) * multiplier,
    );
    const min = Math.min(...costs);
    const max = Math.max(...costs);
    if (min < max) {
      // When matrix values are per-second rates (model also has costUsdPerSecond)
      if (isPerSecond) {
        return t.common.costRangePerSecond
          .replace("{min}", min.toFixed(2))
          .replace("{max}", max.toFixed(2));
      }
      return t.common.costRangePerRequest
        .replace("{min}", min.toFixed(2))
        .replace("{max}", max.toFixed(2));
    }
  }

  // Single-value display
  if (isPerSecond) {
    const cost = calculateCost(model, 0, 0, undefined, undefined, modelSettings, 1);
    return t.common.costPerSecond.replace("{cost}", cost.toFixed(2));
  }

  const estimatedVideoTokens =
    model.costUsdPerMVideoToken && defaultDuration
      ? computeVideoTokens(
          model,
          undefined,
          defaultDuration,
          undefined,
          undefined,
          undefined,
          modelSettings?.resolution as string | undefined,
        )
      : undefined;

  const cost = calculateCost(
    model,
    0,
    0,
    undefined,
    estimatedVideoTokens,
    modelSettings,
    defaultDuration,
  );
  return t.common.costPerRequest.replace("{cost}", cost.toFixed(2));
}

/**
 * Структура persistent reply-keyboard'а для раздела с СВЕЖИМ wtoken для
 * кнопки «Управление» (web_app). Используется для refresh'а wtoken'а на
 * любом сообщении без inline-кнопок — без этого token'ы протухают через ~24ч
 * и юзер видит "ссылка устарела" при клике на mgmt.
 *
 * Возвращает null если section не имеет persistent-keyboard'а (gpt и т.п.).
 */
function buildSectionReplyMarkup(
  userId: bigint,
  section: string,
  t: Translations,
  token: string,
  webappUrl: string | undefined,
): {
  keyboard: { text: string; web_app?: { url: string } }[][];
  resize_keyboard: boolean;
  is_persistent: boolean;
} | null {
  const wtoken = webappUrl ? generateWebToken(userId, token) : "";
  const makeMgmtBtn = (label: string) =>
    webappUrl
      ? {
          text: label,
          web_app: {
            url: `${webappUrl}?page=management&section=${section}&wtoken=${wtoken}`,
          },
        }
      : { text: label };

  let keyboard: { text: string; web_app?: { url: string } }[][];
  if (section === "audio") {
    keyboard = [
      [{ text: t.audio.tts }, { text: t.audio.voiceClone }],
      [{ text: t.audio.music }, { text: t.audio.sounds }],
      [makeMgmtBtn(t.audio.management)],
      [{ text: t.common.backToMain }],
    ];
  } else if (section === "design") {
    keyboard = [
      [{ text: t.design.chooseModel }],
      [makeMgmtBtn(t.design.management)],
      [{ text: t.common.backToMain }],
    ];
  } else if (section === "video") {
    keyboard = [
      [{ text: t.video.newDialog }],
      [{ text: t.video.avatars }, { text: t.video.lipSync }],
      [makeMgmtBtn(t.video.management)],
      [{ text: t.common.backToMain }],
    ];
  } else {
    return null;
  }
  return { keyboard, resize_keyboard: true, is_persistent: true };
}

/** Send a section-entry message with the appropriate reply keyboard (mirrors bot menu.ts). */
async function sendSectionMessage(
  userId: bigint,
  section: string,
  t: Translations,
  token: string,
  webappUrl: string | undefined,
): Promise<void> {
  const replyMarkup = buildSectionReplyMarkup(userId, section, t, token, webappUrl);
  if (!replyMarkup) return;

  const text =
    section === "audio"
      ? t.audio.sectionTitle
      : section === "design"
        ? t.design.sectionTitle
        : t.video.sectionTitle;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: String(userId),
      text,
      reply_markup: replyMarkup,
    }),
  }).catch((reason) => logger.warn(reason, `Could not send section switch message`));
}

async function sendModelActivatedNotification(
  userId: bigint,
  section: string,
  modelId: string,
  sectionSwitched: boolean,
): Promise<void> {
  const model = AI_MODELS[modelId];
  if (!model || !config.bot.token) return;

  const [user, allSettings] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { language: true } }),
    userStateService.getModelSettings(userId),
  ]);
  const t = getT((user?.language ?? "en") as Language);
  const modelSettings = allSettings[modelId] ?? {};

  // Section switch (state/section) was already performed synchronously in the route handler.
  // Here we only send the optional section-switch keyboard message if needed.
  if (sectionSwitched) {
    await sendSectionMessage(userId, section, t, config.bot.token, config.bot.webappUrl).catch(
      (reason) => logger.warn(reason, "Could not send section switch message"),
    );
  }

  const defaultDuration =
    section === "video"
      ? ((modelSettings.duration as number | undefined) ??
        model.supportedDurations?.[0] ??
        model.durationRange?.min ??
        5)
      : undefined;

  const costLine = buildActivationCostLine(model, modelSettings, t, defaultDuration);

  const audioHints: Record<string, string> = {
    "tts-openai": t.audio.ttsActivated,
    "tts-el": t.audio.ttsElActivated,
    "tts-cartesia": t.audio.ttsCartesiaActivated,
    "voice-clone": t.audio.voiceCloneActivated,
    suno: t.audio.musicActivated,
    "music-el": t.audio.musicElActivated,
    "sounds-el": t.audio.soundsActivated,
  };
  const videoHints: Record<string, string> = {
    heygen: t.video.hintHeygen,
    higgsfield: t.video.hintHiggsfield,
    "higgsfield-lite": t.video.hintHiggsfield,
    "higgsfield-preview": t.video.hintHiggsfield,
    "d-id": t.video.hintDid,
  };

  const lang = (user?.language ?? "en") as string;
  const { name: modelName, description: modelDesc } = resolveModelDisplay(modelId, lang, model);
  const webappUrl = config.bot.webappUrl;

  // ── Audio section: mirror handleAudioSubSection — single message, no hint split ──
  if (section === "audio") {
    const audioHint = audioHints[modelId] ?? t.audio.activated;
    if (modelId === "voice-clone") {
      // voice-clone: plain label + hint, no inline kb. Раз нет inline —
      // прикрепляем нижнюю persistent клавиатуру со свежим wtoken.
      const bottomKb = buildSectionReplyMarkup(
        userId,
        section,
        t,
        config.bot.token,
        config.bot.webappUrl,
      );
      // parse_mode HTML — у voiceClone есть <blockquote>/<b> теги с советами
      // Cartesia. Без него юзер видит сырую разметку.
      await fetch(`https://api.telegram.org/bot${config.bot.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: String(userId),
          text: `${t.audio.voiceClone}\n\n${audioHint}`,
          parse_mode: "HTML",
          ...(bottomKb ? { reply_markup: bottomKb } : {}),
        }),
      }).catch((reason) => logger.warn(reason, `Could not send activated notification`));
      return;
    }
    // tts-el / tts-cartesia: голосовой ввод как «текст для синтеза» неприменим
    // (это TTS), и оба hint'а содержат HTML-разметку <blockquote>/<b>.
    const ttsTextOnly = modelId === "tts-el" || modelId === "tts-cartesia";
    const voiceInputHint = ttsTextOnly ? "" : `\n${t.voice.inputHint}`;
    const audioText = `${modelName}\n\n${modelDesc}\n\n${audioHint}${voiceInputHint}\n\n${costLine}`;
    const audioReplyMarkup = webappUrl
      ? {
          inline_keyboard: [
            [
              {
                text: t.audio.management,
                web_app: { url: `${webappUrl}?page=management&section=audio` },
              },
            ],
          ],
        }
      : undefined;
    await fetch(`https://api.telegram.org/bot${config.bot.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(userId),
        text: audioText,
        ...(audioReplyMarkup ? { reply_markup: audioReplyMarkup } : {}),
        ...(ttsTextOnly ? { parse_mode: "HTML" } : {}),
      }),
    }).catch((reason) => logger.warn(reason, `Could not send activated notification`));
    return;
  }

  const hint = section === "video" ? (videoHints[modelId] ?? t.video.hintVideoDefault) : undefined;

  const text = `${modelName}\n\n${modelDesc}\n\n${costLine}`;

  // Build the unified inline keyboard: media input slots (if any) + management.
  // Model activation clears media inputs, so all slots start empty.
  const modes = section === "video" || section === "design" ? getResolvedModes(model) : null;
  // Mini-app activation respects the mode the user already picked there.
  // If no mode was chosen yet (edge case), fall back to the picker below.
  const savedModeId =
    modes && (section === "video" || section === "design")
      ? await userStateService.getSelectedMode(userId, modelId)
      : null;
  const activeMode = modes && savedModeId ? resolveActiveMode(model, savedModeId) : null;
  const slotsForKeyboard =
    section === "video" || section === "design"
      ? modes
        ? activeMode && !activeMode.textOnly
          ? getActiveSlots(model, activeMode.id)
          : []
        : (model.mediaInputs ?? [])
      : [];

  const inlineKeyboard: { text: string; callback_data?: string; web_app?: { url: string } }[][] =
    [];
  // Modes-aware models: slot keyboard goes on the mode-activation message below
  // (only when a mode is actually selected). Skip slot rows on the description.
  if (!modes && (section === "video" || section === "design") && slotsForKeyboard.length) {
    // Progressive reveal: show all non-element slots + only the first element slot.
    // Activation clears media inputs, so all slots start empty.
    let firstElementShown = false;
    for (const slot of slotsForKeyboard) {
      if (slot.mode === "reference_element") {
        if (firstElementShown) continue;
        firstElementShown = true;
      }
      const label = (t.mediaInput as Record<string, string>)[slot.labelKey] ?? slot.labelKey;
      const suffix = slot.required ? ` ${t.mediaInput.required}` : ` ${t.mediaInput.optional}`;
      inlineKeyboard.push([
        { text: `${label}${suffix}`, callback_data: `mi:${section}:${slot.slotKey}` },
      ]);
    }
  }
  if (webappUrl) {
    inlineKeyboard.push([
      {
        text: t.common.management,
        web_app: { url: `${webappUrl}?page=management&section=${section}` },
      },
    ]);
  }
  const replyMarkup = inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined;

  // Bottom persistent keyboard со свежим wtoken — для сообщений БЕЗ inline kb,
  // чтобы юзер при следующем клике на «Управление» использовал не протухший token.
  const bottomKb = buildSectionReplyMarkup(
    userId,
    section,
    t,
    config.bot.token,
    config.bot.webappUrl,
  );

  // Send description first (no inline kb — it goes on the final message).
  // If there's a hint, send it after the description with the inline kb.
  // If there's no hint, attach the inline kb to the description.
  // Когда у description нет inline kb (есть hint, либо replyMarkup пустой) —
  // прикрепляем нижнюю persistent kb для refresh wtoken.
  const descriptionMarkup = hint ? bottomKb : (replyMarkup ?? bottomKb);
  await fetch(`https://api.telegram.org/bot${config.bot.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: String(userId),
      text,
      ...(descriptionMarkup ? { reply_markup: descriptionMarkup } : {}),
    }),
  }).catch((reason) => logger.warn(reason, `Could not send activated notification`));

  if (hint) {
    // Hint-сообщение: inline kb если есть, иначе bottom persistent для wtoken-refresh.
    const hintMarkup = replyMarkup ?? bottomKb;
    await fetch(`https://api.telegram.org/bot${config.bot.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(userId),
        text: hint,
        ...(hintMarkup ? { reply_markup: hintMarkup } : {}),
      }),
    }).catch((reason) => logger.warn(reason, `Could not send model hint`));
  }

  // Modes-aware models. Mini-app activation: respect the mode the user picked
  // in the webapp and send the mode-activated message with filtered slots.
  // Fall back to the picker only if no mode was selected yet.
  if (modes && (section === "video" || section === "design")) {
    if (activeMode) {
      const modeLabel = String(
        (t.modelModes as Record<string, string>)[activeMode.labelKey] ?? activeMode.labelKey,
      );
      const modeKb: { text: string; callback_data?: string; web_app?: { url: string } }[][] = [];
      if (!activeMode.textOnly) {
        let firstElementShown = false;
        for (const slot of slotsForKeyboard) {
          if (slot.mode === "reference_element") {
            if (firstElementShown) continue;
            firstElementShown = true;
          }
          const label = (t.mediaInput as Record<string, string>)[slot.labelKey] ?? slot.labelKey;
          const suffix = slot.required ? ` ${t.mediaInput.required}` : ` ${t.mediaInput.optional}`;
          modeKb.push([
            { text: `${label}${suffix}`, callback_data: `mi:${section}:${slot.slotKey}` },
          ]);
        }
      }
      modeKb.push([
        {
          text: t.modelModes.change,
          callback_data: `change_mode:${section}:${modelId}`,
        },
      ]);
      if (webappUrl) {
        modeKb.push([
          {
            text: t.common.management,
            web_app: { url: `${webappUrl}?page=management&section=${section}` },
          },
        ]);
      }
      const modeText = (
        activeMode.textOnly ? t.modelModes.activatedTextOnly : t.modelModes.activated
      ).replace("{mode}", modeLabel);
      await fetch(`https://api.telegram.org/bot${config.bot.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: String(userId),
          text: modeText,
          ...(modeKb.length ? { reply_markup: { inline_keyboard: modeKb } } : {}),
        }),
      }).catch((reason) => logger.warn(reason, `Could not send mode activated`));
    } else {
      const pickerKb: { text: string; callback_data: string }[][] = [];
      let row: { text: string; callback_data: string }[] = [];
      for (const m of modes) {
        const label = String((t.modelModes as Record<string, string>)[m.labelKey] ?? m.labelKey);
        row.push({ text: label, callback_data: `mode:${section}:${modelId}:${m.id}` });
        if (row.length === 2) {
          pickerKb.push(row);
          row = [];
        }
      }
      if (row.length) pickerKb.push(row);
      await fetch(`https://api.telegram.org/bot${config.bot.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: String(userId),
          text: t.modelModes.pickerTitle,
          reply_markup: { inline_keyboard: pickerKb },
        }),
      }).catch((reason) => logger.warn(reason, `Could not send mode picker`));
    }
  }
}

export const stateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["state"]),
  );

  /** GET /state — current bot state with per-section active dialogs */
  fastify.get(
    "/state",
    {
      schema: {
        description: "Get current bot state with per-section active dialogs",
        response: {
          200: {
            type: "object",
            properties: {
              state: { type: "string" },
              section: { type: "string", nullable: true },
              gptModelId: { type: "string", nullable: true },
              gptDialogId: { type: "string", nullable: true },
              designDialogId: { type: "string", nullable: true },
              audioDialogId: { type: "string", nullable: true },
              videoDialogId: { type: "string", nullable: true },
              designModelId: { type: "string", nullable: true },
              audioModelId: { type: "string", nullable: true },
              videoModelId: { type: "string", nullable: true },
              selectedModes: { type: "object" },
            },
          },
        },
      },
    },
    async (request) => {
      const { userId } = request as AuthRequest;
      const state = await userStateService.get(userId);
      const selectedModes = await userStateService.getSelectedModes(userId);

      return {
        state: state?.state ?? "IDLE",
        section: state?.section ?? null,
        gptModelId: state?.gptModelId ?? null,
        gptDialogId: state?.gptDialogId ?? null,
        designDialogId: state?.designDialogId ?? null,
        audioDialogId: state?.audioDialogId ?? null,
        videoDialogId: state?.videoDialogId ?? null,
        designModelId: state?.designModelId ?? null,
        audioModelId: state?.audioModelId ?? null,
        videoModelId: state?.videoModelId ?? null,
        selectedModes,
      };
    },
  );

  /** POST /state/selected-mode — persist user's chosen mode for a model */
  fastify.post<{
    Body: { modelId: string; modeId: string };
  }>("/state/selected-mode", async (request) => {
    const { userId } = request as AuthRequest;
    const { modelId, modeId } = request.body;
    const model = AI_MODELS[modelId];
    if (!model) return { success: false };
    const modes = getResolvedModes(model);
    if (!modes?.some((m) => m.id === modeId)) return { success: false };
    await userStateService.setSelectedMode(userId, modelId, modeId);
    return { success: true };
  });

  /** PATCH /state — update gptModelId, per-section dialogId, or per-section modelId */
  fastify.patch<{
    Body: {
      gptModelId?: string;
      section?: string;
      dialogId?: string | null;
      sectionModelId?: string;
    };
  }>("/state", async (request) => {
    const { userId } = request as AuthRequest;
    const { gptModelId, section, dialogId, sectionModelId } = request.body;

    if (gptModelId !== undefined) {
      await userStateService.setGptModel(userId, gptModelId);
    }
    if (section !== undefined && dialogId !== undefined) {
      await userStateService.setDialogForSection(userId, section as Section, dialogId);
    }
    if (section !== undefined && sectionModelId !== undefined) {
      await userStateService.setModelForSection(
        userId,
        section as "design" | "audio" | "video",
        sectionModelId,
      );
    }

    return { success: true };
  });

  /** POST /state/activate — set model for section and send Telegram notification */
  fastify.post<{
    Body: { section: string; modelId: string };
  }>("/state/activate", async (request) => {
    const { userId } = request as AuthRequest;
    const { section, modelId } = request.body;

    // Persist the chosen model. GPT хранится в отдельном поле `gptModelId` —
    // у `setModelForSection` нет ветки для "gpt" (sectionModelField падает в
    // no-op), поэтому раньше gpt-активация молча не сохраняла модель.
    if (section === "gpt") {
      await userStateService.setGptModel(userId, modelId);
    } else {
      await userStateService.setModelForSection(
        userId,
        section as "design" | "audio" | "video",
        modelId,
      );
    }

    // Voice-clone activated through the management UI → drop any pending
    // HeyGen-return marker, otherwise a clone started here would silently
    // throw the user back into HeyGen instead of staying in audio.
    if (modelId === "voice-clone") {
      await getRedis()
        .del(voiceCloneReturnRedisKey(userId))
        .catch(() => void 0);
    }

    // Synchronously switch the bot state + section so the very next user message
    // is routed to the newly-activated section (avoids a race with the async
    // notification send). sendModelActivatedNotification will only send the
    // optional section-switch keyboard message.
    //
    // Для gpt: GPT_ACTIVE если у юзера есть активный диалог, иначе GPT_SECTION.
    // Без этого state.state оставался прежним (IDLE / *_ACTIVE прошлой секции),
    // и `bot.on('message')` падал в handleNoTool → юзер видел `noToolGpt`
    // несмотря на свежее «модель активирована».
    let newState: Parameters<typeof userStateService.setState>[1] | undefined;
    if (section === "audio") newState = "AUDIO_ACTIVE";
    else if (section === "design") newState = "DESIGN_ACTIVE";
    else if (section === "video") newState = "VIDEO_ACTIVE";
    else if (section === "gpt") {
      const prev = await userStateService.get(userId);
      newState = prev?.gptDialogId ? "GPT_ACTIVE" : "GPT_SECTION";
    }

    // Always overwrite the FSM state, even when the section is unchanged.
    // Skipping the write on same-section leaks transient sub-states like
    // HEYGEN_AVATAR_PHOTO or HIGGSFIELD_SOUL_PHOTO across model activation
    // — e.g. user clicks "Create avatar" in HeyGen (state = HEYGEN_AVATAR_PHOTO,
    // section = video), then activates Kling 3 Pro (still video) without
    // tapping ❌ Cancel. With the old guard the bot stayed in
    // HEYGEN_AVATAR_PHOTO, so the next photo dropped into a Kling media slot
    // got captured by the avatar-creation handler instead.
    let sectionSwitched = false;
    if (newState) {
      const prev = await userStateService.get(userId);
      sectionSwitched = prev?.section !== section;
      await userStateService.setState(userId, newState, section as Section);
    }

    await sendModelActivatedNotification(userId, section, modelId, sectionSwitched);

    return { success: true };
  });
};
