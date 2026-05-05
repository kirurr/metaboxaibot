import type { BotContext } from "../types/context.js";
import {
  dialogService,
  generationService,
  userStateService,
  userAvatarService,
  describeImageForPrompt,
  probeImageMetadata,
  looksEnglish,
} from "@metabox/api/services";
import { buildCostLine } from "../utils/cost-line.js";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";
import { gateLowIqMode } from "../utils/confirm-generation.js";
import { pickDesignPending } from "../utils/pending-messages.js";
import {
  MODELS_BY_SECTION,
  AI_MODELS,
  MODEL_TO_FAMILY,
  MODEL_FAMILIES,
  config,
  generateWebToken,
  UserFacingError,
  resolveUserFacingErrorVariant,
  resolveModelDisplay,
  getResolvedModes,
} from "@metabox/shared";
import { InlineKeyboard } from "grammy";
import { logger } from "../logger.js";
import { transcribeAndReply } from "../utils/voice-transcribe.js";
import { acquireLock } from "../utils/dedup.js";
import {
  setActiveSlot,
  getActiveSlot,
  clearActiveSlot,
  buildMediaInputStatusMenu,
  resolveMediaInputUrls,
  debounceSlotReply,
  buildTgSlotValue,
  TG_DOWNLOAD_LIMIT_BYTES,
  sendSlotPreview,
  validateMediaAgainstSlot,
  pickAutoSlot,
  trackDistribution,
  consumeDistribution,
  buildOverflowMessage,
  buildSlotUploadedMessage,
  buildModePickerMenu,
  getActiveModelSlots,
  findMissingRequiredSlot,
} from "../utils/media-input-state.js";

// ── Model selection keyboard ──────────────────────────────────────────────────

/**
 * Builds the design-section keyboard.
 * Family models are shown as one button per family (uses the saved or default model).
 * Standalone models (no familyId) are shown individually.
 */
export function buildDesignModelKeyboard(savedModelId?: string | null): InlineKeyboard {
  const allModels = MODELS_BY_SECTION["design"] ?? [];
  const kb = new InlineKeyboard();
  const rows: Array<[string, string]> = [];
  const addedFamilies = new Set<string>();

  for (const m of allModels) {
    const familyId = MODEL_TO_FAMILY[m.id];
    if (familyId) {
      if (addedFamilies.has(familyId)) continue;
      addedFamilies.add(familyId);
      const family = MODEL_FAMILIES[familyId]!;
      const memberIds = new Set(family.members.map((fm) => fm.modelId));
      const modelId =
        savedModelId && memberIds.has(savedModelId) ? savedModelId : family.defaultModelId;
      rows.push([family.name, `design_family_${family.id}__${modelId}`]);
    } else {
      rows.push([m.name, `design_model_${m.id}`]);
    }
  }

  for (let i = 0; i < rows.length; i += 2) {
    kb.text(rows[i][0], rows[i][1]);
    if (rows[i + 1]) kb.text(rows[i + 1][0], rows[i + 1][1]);
    kb.row();
  }
  return kb;
}

// ── Model activation (shared logic) ──────────────────────────────────────────

export async function activateDesignModel(
  ctx: BotContext,
  modelId: string,
  options: { suppressKeyboard?: boolean; sectionReplyKeyboard?: boolean } = {},
): Promise<void> {
  if (!ctx.user) return;
  await userStateService.setState(ctx.user.id, "DESIGN_ACTIVE", "design");
  await userStateService.setModelForSection(ctx.user.id, "design", modelId);
  // Media-input slots persist per-model; not cleared on activation.
  clearActiveSlot(ctx.user.id);

  const model = AI_MODELS[modelId];
  if (model) {
    const allSettings = await userStateService.getModelSettings(ctx.user.id);
    const modelSettings = allSettings[modelId] ?? {};
    const costLine = buildCostLine(model, modelSettings, ctx.t);
    const webappUrl = config.bot.webappUrl;
    const kb = new InlineKeyboard();

    const modes = getResolvedModes(model);

    if (!options.suppressKeyboard && !modes) {
      // Legacy single-mode behavior — slot keyboard goes on the description message.
      if (model.mediaInputs?.length) {
        const filledInputs = await userStateService.getMediaInputs(ctx.user.id, modelId);
        const { kb: slotsKb } = buildMediaInputStatusMenu(
          model.mediaInputs,
          filledInputs,
          "design",
          ctx.t,
          {
            promptOptional: model.promptOptional,
            promptOptionalRequiresMedia: model.promptOptionalRequiresMedia,
          },
        );
        for (const row of slotsKb.inline_keyboard) {
          kb.row(...row);
        }
      }

      if (webappUrl) {
        kb.webApp(ctx.t.design.management, `${webappUrl}?page=management&section=design`);
      }
    } else if (!options.suppressKeyboard && webappUrl && modes) {
      // For modes-aware models, the slot menu lives on the mode-activation
      // message — only attach the management webapp button to the description.
      kb.webApp(ctx.t.design.management, `${webappUrl}?page=management&section=design`);
    }

    const { name: modelName, description: modelDesc } = resolveModelDisplay(
      modelId,
      ctx.user.language,
      model,
    );
    let replyMarkup: Parameters<typeof ctx.reply>[1] extends infer R
      ? R extends { reply_markup?: infer M }
        ? M | undefined
        : never
      : never = kb.inline_keyboard.length ? kb : undefined;
    // Когда у сообщения нет inline kb — слот reply_markup свободен, привязываем
    // нижнюю persistent-клавиатуру раздела. Это переопределяет/обновляет её
    // у пользователя со СВЕЖИМ wtoken для кнопки «Управление» (web_app).
    // Без этого token'ы протухают через ~24ч и юзер видит "ссылка устарела".
    if (!replyMarkup) {
      const token = webappUrl ? generateWebToken(ctx.user.id, config.bot.token) : "";
      const managementBtn = webappUrl
        ? {
            text: ctx.t.design.management,
            web_app: { url: `${webappUrl}?page=management&section=design&wtoken=${token}` },
          }
        : { text: ctx.t.design.management };
      replyMarkup = {
        keyboard: [
          [{ text: ctx.t.design.chooseModel }],
          [managementBtn],
          [{ text: ctx.t.common.backToMain }],
        ],
        resize_keyboard: true,
        is_persistent: true,
      };
    }
    await ctx.reply(`🎨 ${modelName}\n\n${modelDesc}\n\n${costLine}\n\n${ctx.t.voice.inputHint}`, {
      reply_markup: replyMarkup,
    });

    if (modes && !options.suppressKeyboard) {
      await sendDesignModePicker(ctx, modelId, modes);
    }
  } else {
    await ctx.reply(`${ctx.t.design.modelActivated}\n\n${ctx.t.voice.inputHint}`);
  }
}

/** Send the design mode picker — one button per mode, two per row. */
async function sendDesignModePicker(
  ctx: BotContext,
  modelId: string,
  modes: readonly { id: string; labelKey: string }[],
): Promise<void> {
  const { text, kb } = buildModePickerMenu(modes, "design", modelId, ctx.t);
  await ctx.reply(text, { reply_markup: kb });
}

// ── Model selected via inline callback ───────────────────────────────────────

export async function handleDesignModelSelect(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const modelId = ctx.callbackQuery?.data?.replace("design_model_", "") ?? "";
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => void 0);
  await activateDesignModel(ctx, modelId);
}

/**
 * Family button tapped: data format is `design_family_{familyId}__{modelId}`
 * modelId is the resolved (saved or default) model for this family.
 */
export async function handleDesignFamilySelect(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const data = ctx.callbackQuery?.data ?? "";
  // Extract modelId after the __ separator
  const modelId = data.split("__")[1] ?? "";
  // Verify it actually belongs to a known family (safety check)
  if (!modelId || !AI_MODELS[modelId] || !MODEL_TO_FAMILY[modelId]) {
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => void 0);
  await activateDesignModel(ctx, modelId);
}

// ── Media input status menu helper ──────────────────────────────────────────

/** Sends an updated media-input status menu showing filled/empty slots. */
export async function sendDesignMediaInputStatus(
  ctx: BotContext,
  options: { edit?: boolean; prependText?: string; statusText?: string } = {},
): Promise<void> {
  if (!ctx.user) return;
  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.designModelId ?? "dall-e-3";
  const model = AI_MODELS[modelId];
  const activeModeSlots = await getActiveModelSlots(ctx.user.id, modelId);
  if (!activeModeSlots.length) return;

  const filledInputs = await userStateService.getMediaInputs(ctx.user.id, modelId);
  const { text, kb } = buildMediaInputStatusMenu(activeModeSlots, filledInputs, "design", ctx.t, {
    promptOptional: model?.promptOptional,
    promptOptionalRequiresMedia: model?.promptOptionalRequiresMedia,
  });
  const webappUrl = config.bot.webappUrl;
  if (webappUrl) {
    kb.webApp(ctx.t.design.management, `${webappUrl}?page=management&section=design`);
  }
  const statusBody =
    options.statusText ?? (text || (options.prependText ? "" : ctx.t.mediaInput.doneUploading));
  const body = options.prependText
    ? statusBody
      ? `${options.prependText}\n\n${statusBody}`
      : options.prependText
    : statusBody;
  if (options.edit) {
    await ctx.editMessageText(body, { reply_markup: kb }).catch(() => void 0);
  } else {
    await ctx.reply(body, { reply_markup: kb });
  }
}

// ── Media input slot callback (mi:design:{slotKey}) ─────────────────────────

/** Sends the upload-prompt message with cancel button for a design slot. */
async function sendDesignSlotUploadPrompt(
  ctx: BotContext,
  slot: NonNullable<(typeof AI_MODELS)[string]["mediaInputs"]>[number],
  modelId: string,
): Promise<void> {
  setActiveSlot(ctx.user!.id, {
    slotKey: slot.slotKey,
    modelId,
    maxImages: slot.maxImages ?? 1,
    section: "design",
  });

  const maxImages = slot.maxImages ?? 1;
  let msg: string;
  if (maxImages > 1) {
    msg =
      slot.labelKey === "styleReference"
        ? ctx.t.mediaInput.uploadPromptDesignStyleRef.replace("{max}", String(maxImages))
        : ctx.t.mediaInput.uploadPromptDesignMulti.replace("{max}", String(maxImages));
  } else if (slot.labelKey === "reference") {
    msg = ctx.t.mediaInput.uploadPromptDesignRef;
  } else {
    msg = ctx.t.mediaInput.uploadPromptDesignEdit;
  }
  const kb = new InlineKeyboard().text(ctx.t.mediaInput.cancel, `mi_cancel:design`);
  await ctx.reply(msg, { reply_markup: kb });
}

export async function handleDesignMediaInput(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const data = ctx.callbackQuery?.data ?? "";
  const slotKey = data.replace("mi:design:", "");
  await ctx.answerCallbackQuery();

  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.designModelId ?? "dall-e-3";
  const activeModeSlots = await getActiveModelSlots(ctx.user.id, modelId);
  const slot = activeModeSlots.find((s) => s.slotKey === slotKey);
  if (!slot) return;

  const filled = await userStateService.getMediaInputs(ctx.user.id, modelId);
  const existing = filled[slotKey] ?? [];
  const maxImages = slot.maxImages ?? 1;

  if (existing.length) {
    // Drop the menu message we tapped, send preview, then either resume upload or re-show menu.
    await ctx.deleteMessage().catch(() => void 0);
    await sendSlotPreview(ctx, slot, existing);
    if (existing.length < maxImages) {
      await sendDesignSlotUploadPrompt(ctx, slot, modelId);
    } else {
      await sendDesignMediaInputStatus(ctx);
    }
    return;
  }

  // Empty slot → strip keyboard from the menu (keep text in history) and enter upload mode.
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => void 0);
  await sendDesignSlotUploadPrompt(ctx, slot, modelId);
}

/** Callback for mi_cancel:design — cancel active upload slot. */
export async function handleDesignMediaInputCancel(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await ctx.answerCallbackQuery();
  clearActiveSlot(ctx.user.id);
  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.designModelId ?? "dall-e-3";
  const activeModeSlots = await getActiveModelSlots(ctx.user.id, modelId);
  if (activeModeSlots.length) {
    await sendDesignMediaInputStatus(ctx, {
      edit: true,
      statusText: ctx.t.mediaInput.uploadCancelled,
    });
  } else {
    await ctx.editMessageText(ctx.t.mediaInput.uploadCancelled).catch(() => void 0);
  }
}

/** Callback for mi_done:{slotKey} — user finished uploading multi-image slot. */
export async function handleDesignMediaInputDone(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await ctx.answerCallbackQuery();
  clearActiveSlot(ctx.user.id);
  await sendDesignMediaInputStatus(ctx, { edit: true });
}

/**
 * Callback for mi_generate:design — start generation without a text prompt.
 * For Higgsfield Soul: describes the uploaded reference image via cheap vision LLM
 * and uses that description as the prompt (token cost deducted from user).
 */
export async function handleDesignGenerateNoPrompt(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  const sourceMessageId = chatId && messageId ? `${chatId}:${messageId}` : undefined;

  if (sourceMessageId) {
    try {
      const acquired = await acquireLock(`dedup:gen:btn:${ctx.user.id}:${sourceMessageId}`, 120);
      if (!acquired) {
        await ctx.answerCallbackQuery({ text: ctx.t.errors.alreadyGenerating });
        return;
      }
    } catch {
      // fail-open: proceed if Redis unavailable
    }
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => void 0);

  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.designModelId ?? "dall-e-3";
  const filled = await userStateService.getMediaInputs(ctx.user.id, modelId);
  const firstFilled = Object.values(filled).find((v) => v?.length);

  if (!firstFilled?.length) {
    await executeDesignPrompt(ctx, "", sourceMessageId);
    return;
  }

  const resolved = await resolveMediaInputUrls({ ref: [firstFilled[0]] }).catch(() => null);
  const refUrl = resolved?.ref?.[0];
  if (!refUrl) {
    await ctx.reply(ctx.t.errors.soulDescribeFailed);
    return;
  }

  const pendingMsg = await ctx.reply(ctx.t.errors.soulDescribingReference);
  let description: string;
  try {
    description = await describeImageForPrompt(ctx.user.id, refUrl, modelId);
  } catch (err) {
    logger.error(err, "describeImageForPrompt failed");
    await ctx.api.deleteMessage(ctx.chat!.id, pendingMsg.message_id).catch(() => void 0);
    await ctx.reply(ctx.t.errors.soulDescribeFailed);
    return;
  }
  await ctx.api.deleteMessage(ctx.chat!.id, pendingMsg.message_id).catch(() => void 0);
  await executeDesignPrompt(ctx, description, sourceMessageId);
}

/** Callback for mi_remove:design:{slotKey} — clear a filled slot. */
export async function handleDesignMediaInputRemove(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const data = ctx.callbackQuery?.data ?? "";
  const slotKey = data.replace("mi_remove:design:", "");
  await ctx.answerCallbackQuery();
  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.designModelId ?? "dall-e-3";
  await userStateService.clearMediaInputSlot(ctx.user.id, modelId, slotKey);
  await sendDesignMediaInputStatus(ctx, { edit: true });
}

// ── Incoming prompt in DESIGN_ACTIVE state ────────────────────────────────────

/**
 * Executes a text prompt in the active design session.
 * Used by handleDesignMessage (text) and the voice-prompt callback.
 */
export async function executeDesignPrompt(
  ctx: BotContext,
  prompt: string,
  sourceMessageId?: string,
): Promise<void> {
  if (!ctx.user) return;
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  if (sourceMessageId) {
    const active = await generationService.hasActiveJobForSource(ctx.user.id, sourceMessageId);
    if (active) return;
  }

  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.designModelId ?? "dall-e-3";

  // Auto-create dialog if none exists for this design session
  let dialogId = state?.designDialogId ?? null;
  if (!dialogId) {
    const dialog = await dialogService.create({
      userId: ctx.user.id,
      section: "design",
      modelId,
    });
    await userStateService.setDialogForSection(ctx.user.id, "design", dialog.id);
    dialogId = dialog.id;
  }

  // Slot-based media inputs (per-model; cleared for this model after generation start)
  const mediaInputs = await userStateService.getMediaInputs(ctx.user.id, modelId);
  const hasMediaInputs = Object.keys(mediaInputs).length > 0;
  clearActiveSlot(ctx.user.id);

  // Check required slots before proceeding
  const promptActiveModeSlots = await getActiveModelSlots(ctx.user.id, modelId);
  if (promptActiveModeSlots.length) {
    const missing = findMissingRequiredSlot(modelId, promptActiveModeSlots, mediaInputs);
    if (missing) {
      const label =
        ctx.t.mediaInput[missing.labelKey as keyof typeof ctx.t.mediaInput] ?? missing.labelKey;
      await sendDesignMediaInputStatus(ctx, {
        prependText: ctx.t.mediaInput.slotRequired.replace("{slot}", String(label)),
      });
      return;
    }
  }

  // English-only models: validate prompt language before enqueuing
  const model = AI_MODELS[modelId];
  if (prompt && model?.settings?.some((s) => s.key === "auto_translate_prompt")) {
    const allSettings = await userStateService.getModelSettings(ctx.user.id);
    if (allSettings[modelId]?.auto_translate_prompt !== true && !looksEnglish(prompt)) {
      await ctx.reply(ctx.t.errors.promptNotEnglish);
      return;
    }
  }

  // Higgsfield Soul pre-flight: must have a created+selected character avatar.
  if (modelId === "higgsfield-soul") {
    const allSettings = await userStateService.getModelSettings(ctx.user.id);
    const customRefId = allSettings[modelId]?.custom_reference_id as string | null | undefined;
    const validation = await userAvatarService.validateSoulAvatar(ctx.user.id, customRefId);
    if (validation) {
      await ctx.reply(ctx.t.errors[validation]);
      return;
    }
  }

  // Snapshot raw state values for low-iq Cancel-restore (captured BEFORE the
  // existing clear/getAndClear calls so the user gets exactly what they had).
  const snapshotMediaInputs = hasMediaInputs ? { ...mediaInputs } : undefined;
  const snapshotDesignRefMessageId = state?.designRefMessageId ?? undefined;

  // Clear media inputs for this model (consumed on generation start)
  if (hasMediaInputs) await userStateService.clearMediaInputs(ctx.user.id, modelId);

  // Resolve reference image (one-shot, legacy path)
  const refMessageId = state?.designRefMessageId ?? null;
  let sourceImageUrl: string | undefined;
  if (refMessageId) {
    const msg = await dialogService.getMessageById(refMessageId);
    sourceImageUrl = msg?.mediaUrl ?? undefined;
    await userStateService.setDesignRefMessage(ctx.user.id, null);
  }

  // Read saved aspect ratio for this model
  const imageSettings = await userStateService.getImageSettings(ctx.user.id);
  const aspectRatio = imageSettings[modelId]?.aspectRatio;

  const submitParams = {
    userId: ctx.user.id,
    modelId,
    prompt,
    sourceImageUrl,
    // Cleanup: при детекте протухших ссылок (удалённый s3-output, Telegram
    // file expired) `resolveMediaInputUrls` сразу выкинет их из user-state'а
    // — следующий retry пользователь увидит слот без поломанной записи.
    mediaInputs: hasMediaInputs
      ? await resolveMediaInputUrls(mediaInputs, { userId: ctx.user.id, modelId })
      : undefined,
    telegramChatId: chatId,
    dialogId,
    sendOriginalLabel: ctx.t.common.sendOriginal,
    aspectRatio,
    sourceMessageId,
  };
  if (
    await gateLowIqMode({
      ctx,
      kind: "image",
      modelId,
      prompt,
      submitParams,
      restoreSnapshot: {
        ...(snapshotMediaInputs ? { mediaInputs: snapshotMediaInputs } : {}),
        ...(snapshotDesignRefMessageId ? { designRefMessageId: snapshotDesignRefMessageId } : {}),
      },
    })
  ) {
    return;
  }

  const pendingMsg = await ctx.reply(pickDesignPending(ctx));

  try {
    await generationService.submitImage(submitParams);
  } catch (err: unknown) {
    await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);
    if (err instanceof Error && err.message === "NO_SUBSCRIPTION") {
      await replyNoSubscription(ctx);
    } else if (err instanceof Error && err.message === "INSUFFICIENT_TOKENS") {
      await replyInsufficientTokens(ctx);
    } else if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Design message error");
      await ctx.reply(ctx.t.design.generationFailed);
    }
  }
}

export async function handleDesignMessage(ctx: BotContext): Promise<void> {
  if (!ctx.user || !ctx.message?.text) return;
  await executeDesignPrompt(ctx, ctx.message.text);
}

export async function handleDesignVoice(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await transcribeAndReply(ctx, "design");
}

// ── Incoming photo or image document in DESIGN_ACTIVE state — set as reference ─

/**
 * Media-group (album) dedup: Telegram delivers each photo of an album as a
 * separate update sharing the same `media_group_id`. Only one of them carries
 * the caption. We only generate once per group — using the first photo that
 * arrives with a caption (or simply the first photo if none has one).
 */
type DesignMediaGroupEntry = {
  timer: ReturnType<typeof setTimeout>;
  processed: boolean;
};
const designMediaGroupBuffer = new Map<string, DesignMediaGroupEntry>();

export async function handleDesignPhoto(ctx: BotContext): Promise<void> {
  const isPhoto = !!ctx.message?.photo;
  const isImageDoc =
    !!ctx.message?.document && ctx.message.document.mime_type?.startsWith("image/");
  if (!ctx.user || (!isPhoto && !isImageDoc)) return;

  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.designModelId ?? "dall-e-3";
  const model = AI_MODELS[modelId];
  const activeModeSlots = await getActiveModelSlots(ctx.user.id, modelId);

  // Auto-slot mode wants every album sibling to be distributed across slots.
  // Active-slot mode also processes every sibling. Only the legacy dialog-ref
  // and caption-immediate-generate paths need album dedup.
  const activeSlotForDedup = getActiveSlot(ctx.user.id);
  const isActiveSlotMode = activeSlotForDedup?.section === "design";
  const isAutoSlotMode = !isActiveSlotMode && activeModeSlots.length > 0;
  const mediaGroupId = ctx.message?.media_group_id;
  if (mediaGroupId && !isActiveSlotMode && !isAutoSlotMode) {
    const key = `${ctx.user.id}__${mediaGroupId}`;
    const hasCaption = !!ctx.message?.caption?.trim();
    const existing = designMediaGroupBuffer.get(key);

    if (existing?.processed) {
      // Another photo from the same album already triggered the generation — ignore.
      return;
    }

    if (existing) {
      clearTimeout(existing.timer);
    }

    if (hasCaption) {
      // This is the captioned photo — mark the group as processed and fall through.
      designMediaGroupBuffer.set(key, {
        processed: true,
        timer: setTimeout(() => designMediaGroupBuffer.delete(key), 10_000),
      });
    } else {
      // No caption yet — buffer briefly. If nothing else arrives, we'll treat this
      // as a plain reference. If a captioned sibling arrives, it will take over.
      designMediaGroupBuffer.set(key, {
        processed: false,
        timer: setTimeout(() => designMediaGroupBuffer.delete(key), 10_000),
      });
      return; // skip non-captioned siblings entirely
    }
  }

  // Resolve file_id + size from message — without calling getFile.
  // file_id is durable (no TTL) and stored in slots as `tg:{kind}:{id}`.
  const photoSize = isPhoto ? ctx.message!.photo!.at(-1)! : null;
  const docFile = isImageDoc ? ctx.message!.document! : null;
  const fileId = (photoSize?.file_id ?? docFile!.file_id) as string;
  const fileSize = photoSize?.file_size ?? docFile?.file_size ?? 0;
  const tgKind: "photo" | "doc" = photoSize ? "photo" : "doc";

  // Bot API can't download files >20 MB at all → reject early.
  if (fileSize > TG_DOWNLOAD_LIMIT_BYTES) {
    await ctx.reply(ctx.t.errors.fileTooLargeForBotApi);
    return;
  }

  const caption = ctx.message.caption?.trim();
  const tgSlotValue = buildTgSlotValue(tgKind, fileId);

  // Lazily resolve the live download URL only when a path actually needs the
  // bytes during this request (caption+photo legacy flow below).
  let cachedTgUrl: string | null = null;
  const getLiveTgUrl = async (): Promise<string> => {
    if (cachedTgUrl) return cachedTgUrl;
    const file = await ctx.api.getFile(fileId);
    cachedTgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
    return cachedTgUrl;
  };

  // ── Slot-based upload (new path) ──────────────────────────────────────────
  const activeSlot = getActiveSlot(ctx.user.id);
  if (activeSlot && activeSlot.section === "design") {
    const slotModelId = activeSlot.modelId;
    const slotsForModel =
      slotModelId === modelId
        ? activeModeSlots
        : await getActiveModelSlots(ctx.user.id, slotModelId);
    const slot = slotsForModel.find((s) => s.slotKey === activeSlot.slotKey);

    if (slot?.constraints) {
      let widthPx = photoSize?.width;
      let heightPx = photoSize?.height;
      let fileSizeBytes: number | undefined = fileSize || undefined;
      if (isImageDoc) {
        try {
          const probeUrl = await getLiveTgUrl();
          const meta = await probeImageMetadata(probeUrl);
          widthPx = meta.width;
          heightPx = meta.height;
          fileSizeBytes = meta.fileSizeBytes;
        } catch (err) {
          logger.warn({ err }, "probeImageMetadata failed for document");
          await ctx.reply(ctx.t.errors.mediaSlotReadMetadataFailed);
          return;
        }
      }
      const violation = validateMediaAgainstSlot(slot, { widthPx, heightPx, fileSizeBytes }, ctx.t);
      if (violation) {
        await ctx.reply(violation);
        return;
      }
    }

    const current = await userStateService.getMediaInputs(ctx.user.id, slotModelId);
    const existing = current[activeSlot.slotKey] ?? [];
    const userId = ctx.user.id;
    // Manual slot pick: when the slot is already full, FIFO-evict the oldest
    // entry and append the new one. Works uniformly for single-image
    // (replace) and multi-image (cyclic) slots — the user just chose this
    // exact slot, dropping their input silently feels broken.
    const isFull = existing.length >= activeSlot.maxImages;
    await userStateService.addMediaInput(
      userId,
      slotModelId,
      activeSlot.slotKey,
      tgSlotValue,
      isFull,
    );

    const label = slot
      ? (ctx.t.mediaInput[slot.labelKey as keyof typeof ctx.t.mediaInput] ?? slot.labelKey)
      : activeSlot.slotKey;

    debounceSlotReply(userId, mediaGroupId, async () => {
      const freshInputs = await userStateService.getMediaInputs(userId, slotModelId);
      const freshCount = freshInputs[activeSlot.slotKey]?.length ?? 0;

      if (activeSlot.maxImages === 1 || freshCount >= activeSlot.maxImages) {
        clearActiveSlot(userId);
        await sendDesignMediaInputStatus(ctx);
      } else {
        const msg = ctx.t.mediaInput.imageSaved
          .replace("{slot}", String(label))
          .replace("{n}", String(freshCount))
          .replace("{max}", String(activeSlot.maxImages));
        const kb = new InlineKeyboard().text(
          ctx.t.mediaInput.doneUploading,
          `mi_done:${activeSlot.slotKey}`,
        );
        await ctx.reply(msg, { reply_markup: kb });
      }

      if (caption) {
        await executeDesignPrompt(ctx, caption);
      }
    });
    return;
  }

  // ── Auto-slot distribution: distribute album siblings across slots in
  // definition order; siblings that don't fit anywhere are reported as
  // overflow. After the album debounce settles, send a single status reply
  // (with overflow notice prepended). If the album carried a caption and all
  // required slots end up filled, trigger generation with the caption — same
  // as if the user had typed it after the upload finished.
  if (isAutoSlotMode && model) {
    const userId = ctx.user.id;
    const current = await userStateService.getMediaInputs(userId, modelId);
    const targetSlot = pickAutoSlot(activeModeSlots, current, "image");
    if (targetSlot) {
      // Constraint validation на upload'е (зеркалит active-slot путь выше).
      // Без этого юзер получает provider-error мид-генерации.
      if (targetSlot.constraints) {
        let widthPx = photoSize?.width;
        let heightPx = photoSize?.height;
        let fileSizeBytes: number | undefined = fileSize || undefined;
        if (isImageDoc) {
          try {
            const probeUrl = await getLiveTgUrl();
            const meta = await probeImageMetadata(probeUrl);
            widthPx = meta.width;
            heightPx = meta.height;
            fileSizeBytes = meta.fileSizeBytes;
          } catch (err) {
            logger.warn({ err }, "probeImageMetadata failed in auto-slot");
            await ctx.reply(ctx.t.errors.mediaSlotReadMetadataFailed);
            return;
          }
        }
        const violation = validateMediaAgainstSlot(
          targetSlot,
          { widthPx, heightPx, fileSizeBytes },
          ctx.t,
        );
        if (violation) {
          await ctx.reply(violation);
          return;
        }
      }
      await userStateService.addMediaInput(userId, modelId, targetSlot.slotKey, tgSlotValue);
      debounceSlotReply(
        userId,
        mediaGroupId,
        async () => {
          const fresh = await userStateService.getMediaInputs(userId, modelId);
          const count = fresh[targetSlot.slotKey]?.length ?? 0;
          if (count === 0) return;
          await ctx.reply(buildSlotUploadedMessage(targetSlot, count, ctx.t));
        },
        targetSlot.slotKey,
      );
    }
    trackDistribution(userId, mediaGroupId, {
      overflow: !targetSlot,
      caption: caption || undefined,
      modelId,
      section: "design",
    });
    debounceSlotReply(userId, mediaGroupId, async () => {
      const tracked = consumeDistribution(userId, mediaGroupId);
      const overflowText =
        tracked && tracked.overflowCount > 0 ? buildOverflowMessage(model, ctx.t) : "";
      await sendDesignMediaInputStatus(ctx, { prependText: overflowText });
      if (tracked?.caption) {
        const finalInputs = await userStateService.getMediaInputs(userId, modelId);
        const missingRequired = activeModeSlots.find(
          (s) => s.required && !finalInputs[s.slotKey]?.length,
        );
        if (!missingRequired) {
          await executeDesignPrompt(ctx, tracked.caption);
        }
      }
    });
    return;
  }

  // Below paths (legacy dialog reference + caption+photo) need the live URL.
  const fileUrl = await getLiveTgUrl();

  // ── Legacy path: dialog-based reference ───────────────────────────────────
  // Auto-create dialog if none exists
  let dialogId = state?.designDialogId ?? null;
  if (!dialogId) {
    const dialog = await dialogService.create({
      userId: ctx.user.id,
      section: "design",
      modelId,
    });
    await userStateService.setDialogForSection(ctx.user.id, "design", dialog.id);
    dialogId = dialog.id;
  }

  // Save as a user message with mediaUrl
  const dialogMsg = await dialogService.saveMessage(
    dialogId,
    "user",
    ctx.t.design.photoAsReference,
    {
      mediaUrl: fileUrl,
      mediaType: "image",
    },
  );

  // If photo came with a caption, treat it as a prompt and generate immediately
  if (caption) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    // English-only models: validate prompt language before enqueuing
    if (model?.settings?.some((s) => s.key === "auto_translate_prompt")) {
      const allSettings = await userStateService.getModelSettings(ctx.user.id);
      if (allSettings[modelId]?.auto_translate_prompt !== true && !looksEnglish(caption)) {
        await ctx.reply(ctx.t.errors.promptNotEnglish);
        return;
      }
    }

    // If model has media input slots, save the photo to the first slot
    let mediaInputs: Record<string, string[]> | undefined;
    if (activeModeSlots.length) {
      const firstSlot = activeModeSlots[0];
      mediaInputs = { [firstSlot.slotKey]: [fileUrl] };
    }

    const imageSettings = await userStateService.getImageSettings(ctx.user.id);
    const aspectRatio = imageSettings[modelId]?.aspectRatio;

    const submitParams = {
      userId: ctx.user.id,
      modelId,
      prompt: caption,
      sourceImageUrl: fileUrl,
      mediaInputs,
      telegramChatId: chatId,
      dialogId,
      sendOriginalLabel: ctx.t.common.sendOriginal,
      aspectRatio,
    };
    if (
      await gateLowIqMode({
        ctx,
        kind: "image",
        modelId,
        prompt: caption,
        submitParams,
      })
    ) {
      return;
    }

    const pendingMsg = await ctx.reply(pickDesignPending(ctx));

    try {
      await generationService.submitImage(submitParams);
    } catch (err: unknown) {
      await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);
      if (err instanceof Error && err.message === "INSUFFICIENT_TOKENS") {
        await replyInsufficientTokens(ctx);
      } else if (err instanceof UserFacingError) {
        await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
      } else {
        logger.error(err, "Design photo+caption error");
        await ctx.reply(ctx.t.design.generationFailed);
      }
    }
    return;
  }

  // No caption — save as ref and ask user to type a prompt
  await userStateService.setDesignRefMessage(ctx.user.id, dialogMsg.id);
  await ctx.reply(ctx.t.design.photoSaved);
}

// ── Management — opens Mini App ───────────────────────────────────────────────

export async function handleDesignManagement(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const webappUrl = config.bot.webappUrl;
  if (!webappUrl) {
    await ctx.reply(ctx.t.errors.unexpected);
    return;
  }
  const token = generateWebToken(ctx.user.id, config.bot.token);
  const kb = new InlineKeyboard().webApp(
    ctx.t.design.management,
    `${webappUrl}?page=management&section=design&wtoken=${token}`,
  );
  await ctx.reply(ctx.t.design.management, { reply_markup: kb });
}

// ── New design dialog ─────────────────────────────────────────────────────────

export async function handleNewDesignDialog(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.setState(ctx.user.id, "DESIGN_SECTION", "design");
  const state = await userStateService.get(ctx.user.id);
  await ctx.reply(ctx.t.design.sectionTooltip, {
    reply_markup: buildDesignModelKeyboard(state?.designModelId),
  });
}
