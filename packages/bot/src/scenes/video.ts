import type { BotContext } from "../types/context.js";
import {
  videoGenerationService,
  generationService,
  userStateService,
  // userUploadsService,
  userAvatarService,
  s3Service,
  checkBalance,
  usdToTokens,
  probeImageMetadata,
  probeHeygenAudioDuration,
} from "@metabox/api/services";
import { probeVideoMetadata } from "@metabox/api/utils/mp4-duration";
import { buildCostLine } from "../utils/cost-line.js";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";
import { gateLowIqMode } from "../utils/confirm-generation.js";
import { AVATAR_MODELS, preGenerateELTts } from "../utils/el-tts.js";
import { pickVideoPending } from "../utils/pending-messages.js";
import { getAvatarQueue } from "@metabox/api/queues";
import {
  MODELS_BY_SECTION,
  FAMILIES_BY_SECTION,
  MODEL_TO_FAMILY,
  AI_MODELS,
  config,
  resolveModelDisplay,
  generateWebToken,
  getResolvedModes,
  getModelDefaultDuration,
} from "@metabox/shared";
import type { Translations } from "@metabox/shared";
import { InlineKeyboard } from "grammy";
import { logger } from "../logger.js";
import {
  transcribeAndReply,
  storeTranscription as storeVoiceText,
} from "../utils/voice-transcribe.js";
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
  getSlotMediaTypes,
  pickAutoSlot,
  trackDistribution,
  consumeDistribution,
  buildOverflowMessage,
  buildSlotUploadedMessage,
  buildModePickerMenu,
  getActiveModelSlots,
  findMissingRequiredSlot,
} from "../utils/media-input-state.js";
import {
  SOUL_MAX_PHOTOS,
  SOUL_MIN_PHOTOS,
  getSoulBuffer,
  addSoulPhoto,
  clearSoulBuffer,
  debounceSoulReply,
} from "../utils/soul-photo-buffer.js";
import { acquireLock, releaseLock } from "../utils/dedup.js";
import { consumeMediaHint, refreshMediaHint } from "../utils/media-hint.js";

/**
 * Для AVATAR_MODELS one-shot фото из чата живёт в `mediaInputs.avatar_photo[0]`,
 * а не в deprecated top-level `imageUrl`. Helper централизует это решение —
 * вызывайте его перед сборкой submitParams в любой точке, где есть chat-photo URL
 * для AVATAR-модели.
 */
function routeAvatarPhoto(
  modelId: string,
  imageUrl: string | undefined,
  mediaInputs: Record<string, string[]> | undefined,
): { imageUrl: string | undefined; mediaInputs: Record<string, string[]> | undefined } {
  if (!imageUrl || !AVATAR_MODELS.has(modelId)) return { imageUrl, mediaInputs };
  return {
    imageUrl: undefined,
    mediaInputs: { ...(mediaInputs ?? {}), avatar_photo: [imageUrl] },
  };
}

// ── Avatar voice choice store (TTL 10 min) ──────────────────────────────────

interface AvatarVoiceEntry {
  uploadedKey: string | null;
  tgUrl: string;
  /** message_id of the voice/audio message — so the result reply targets it. */
  voiceMessageId?: number;
  /** Длительность аудио в секундах — ffprobe на байтах (не metadata) при
   *  загрузке. Прокидывается как `audioDurationSecHint` в cost-preview. */
  durationSec?: number;
  expiresAt: number;
}

const avatarVoiceStore = new Map<string, AvatarVoiceEntry>();

function storeAvatarVoice(
  userId: bigint,
  id: string,
  entry: Omit<AvatarVoiceEntry, "expiresAt">,
): void {
  avatarVoiceStore.set(`${userId}:${id}`, { ...entry, expiresAt: Date.now() + 10 * 60 * 1000 });
}

function getAvatarVoice(userId: bigint, id: string): AvatarVoiceEntry | null {
  const key = `${userId}:${id}`;
  const entry = avatarVoiceStore.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    avatarVoiceStore.delete(key);
    return null;
  }
  return entry;
}

/**
 * Верхняя граница плаусибельного аудио-битрейта для sanity-check. 64 KB/s ≈
 * 512 kbps — покрывает high-quality stereo mp3/opus/m4a с запасом. Реальные
 * аудио-файлы в Telegram редко идут выше 192 kbps = 24 KB/s.
 */
const MAX_PLAUSIBLE_AUDIO_BYTES_PER_SEC = 64 * 1024;

/**
 * Достоверная длительность TG-аудио для cost-preview hint.
 *
 * Переиспользует существующий `probeHeygenAudioDuration` (он же используется
 * для сайта). Добавляет safety-логику:
 *  - Когда ffprobe вернул значение: `max(ceil(ffprobe), metaDuration)`.
 *    ffprobe служит floor'ом против exploit'а с занижением metaDuration;
 *    meta перевешивает когда больше — компенсирует под-репорт ffprobe
 *    (опус voice часто занижается на 0.5-1s vs реальная длительность).
 *  - Когда ffprobe сорвался + voice: trust `metaDuration` (Telegram-server
 *    ставит при записи, юзер подделать не может).
 *  - Когда ffprobe сорвался + audio: sanity-check `metaDuration` против
 *    `fileSize` (defense-in-depth: если файл 5MB но meta=1сек — это явно
 *    подделанные метаданные, реальный 5MB at min audio bitrate >> 1 sec).
 *    Если правдоподобно → trust meta. Иначе → null → per_second mode.
 */
async function probeTelegramAudioDurationSec(
  tgUrl: string,
  isVoiceType: boolean,
  metaDuration: number | undefined,
  fileSize: number | undefined,
): Promise<number | null> {
  const probed = await probeHeygenAudioDuration({}, { voice_audio: [tgUrl] });
  const probedSec = probed && probed > 0 ? Math.ceil(probed) : 0;
  const meta =
    typeof metaDuration === "number" && isFinite(metaDuration) && metaDuration > 0
      ? metaDuration
      : 0;

  if (probedSec > 0) {
    if (meta > 0 && probedSec < meta * 0.5) {
      logger.warn(
        { probedSec, meta },
        "probeTelegramAudioDurationSec: ffprobe disagrees with metaDuration",
      );
    }
    return Math.max(probedSec, meta);
  }

  if (meta <= 0) return null;

  // Probe сорвался. Voice — TG-server ставит meta, доверяем безусловно.
  if (isVoiceType) return meta;

  // Audio — meta под контролем юзера, проверяем через file_size:
  // занижение meta для exploit'а арифметически невозможно если файл реально
  // содержит больше данных. Используем верхнюю границу битрейта чтобы
  // вычислить минимально-возможную длительность для этого размера.
  if (typeof fileSize === "number" && fileSize > 0) {
    const minPlausibleSec = fileSize / MAX_PLAUSIBLE_AUDIO_BYTES_PER_SEC;
    // 50% margin — на накладные расходы контейнера (header'ы и т.п.).
    if (meta < minPlausibleSec * 0.5) {
      logger.warn(
        { meta, fileSize, minPlausibleSec },
        "probeTelegramAudioDurationSec: metaDuration implausibly small vs file_size — rejecting",
      );
      return null;
    }
  }
  return meta;
}

// ── Model selection keyboard ──────────────────────────────────────────────────

/**
 * Builds the video-section keyboard preserving MODELS_BY_SECTION order.
 * Family members are collapsed into one button at the position of the first member.
 */
export function buildVideoModelKeyboard(savedModelId?: string | null): InlineKeyboard {
  const allModels = MODELS_BY_SECTION["video"] ?? [];
  const families = FAMILIES_BY_SECTION["video"] ?? [];
  const familyById = new Map(families.map((f) => [f.id, f]));
  const kb = new InlineKeyboard();

  const rows: Array<[string, string]> = [];
  const addedFamilies = new Set<string>();

  for (const m of allModels) {
    // Скрытые модели (e.g. grok-imagine-extend) активируются только через
    // спец-кнопки (типа «Продлить»), в карусели их показывать не нужно.
    if (m.hiddenFromCarousel) continue;
    const familyId = MODEL_TO_FAMILY[m.id];
    if (familyId) {
      if (addedFamilies.has(familyId)) continue;
      addedFamilies.add(familyId);
      const family = familyById.get(familyId)!;
      const memberIds = new Set(family.members.map((fm) => fm.modelId));
      const modelId =
        savedModelId && memberIds.has(savedModelId) ? savedModelId : family.defaultModelId;
      rows.push([family.name, `video_family_${family.id}__${modelId}`]);
    } else {
      rows.push([m.name, `video_model_${m.id}`]);
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

export async function activateVideoModel(
  ctx: BotContext,
  modelId: string,
  options: { suppressKeyboard?: boolean; sectionReplyKeyboard?: boolean } = {},
): Promise<void> {
  if (!ctx.user) return;
  await userStateService.setState(ctx.user.id, "VIDEO_ACTIVE", "video");
  await userStateService.setModelForSection(ctx.user.id, "video", modelId);
  // Media-input slots persist per-model; not cleared on activation.
  clearActiveSlot(ctx.user.id);

  const model = AI_MODELS[modelId];
  if (model) {
    const allSettings = await userStateService.getModelSettings(ctx.user.id);
    const modelSettings = allSettings[modelId] ?? {};
    // Единый источник дефолта duration — `getModelDefaultDuration`. До фикса
    // здесь сразу падали на supportedDurations[0]/durationRange.min, что для
    // kling давало 3 (min), хотя UI-слайдер `default: 5`. Теперь cost line
    // в активации модели совпадает с тем что реально пошлёт submit.
    const defaultDuration =
      (modelSettings.duration as number | undefined) ?? getModelDefaultDuration(model) ?? 5;
    const costLine = buildCostLine(model, modelSettings, ctx.t, defaultDuration);
    const webappUrl = config.bot.webappUrl;
    const kb = new InlineKeyboard();

    const modes = getResolvedModes(model);

    if (!options.suppressKeyboard && !modes) {
      // Legacy single-mode behavior — slot keyboard goes on the hint message.
      if (model.mediaInputs?.length) {
        const filledInputs = await userStateService.getMediaInputs(ctx.user.id, modelId);
        const { kb: slotsKb } = buildMediaInputStatusMenu(
          model.mediaInputs,
          filledInputs,
          "video",
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
        kb.webApp(ctx.t.video.management, `${webappUrl}?page=management&section=video`);
      }
    }

    const { name: modelName, description: modelDesc } = resolveModelDisplay(
      modelId,
      ctx.user.language,
      model,
    );
    const inlineKb = kb.inline_keyboard.length ? kb : undefined;
    // Description-сообщение никогда не несёт inline kb (inline уезжает на хинт
    // или mode-activated). Раз reply_markup-слот свободен — всегда привязываем
    // нижнюю persistent-клавиатуру со СВЕЖИМ wtoken для кнопки «Управление»
    // (web_app). Без обновления токены протухают через ~24ч.
    const token =
      webappUrl && ctx.user.telegramId
        ? generateWebToken(ctx.user.telegramId, config.bot.token)
        : "";
    const managementBtn = webappUrl
      ? {
          text: ctx.t.video.management,
          web_app: { url: `${webappUrl}?page=management&section=video&wtoken=${token}` },
        }
      : { text: ctx.t.video.management };
    const sectionReplyMarkup = {
      keyboard: [
        [{ text: ctx.t.video.newDialog }],
        [{ text: ctx.t.video.avatars }, { text: ctx.t.video.lipSync }],
        [managementBtn],
        [{ text: ctx.t.common.backToMain }],
      ],
      resize_keyboard: true,
      is_persistent: true,
    };

    // Бот-only хинт про sibling-режим у grok-imagine family. В webapp этот
    // хинт лишний (там вариант выбирается прямо в карточке через picker),
    // поэтому в model.description его не держим — добавляем здесь только для
    // бот-активации.
    const grokSiblingHint =
      modelId === "grok-imagine"
        ? `\n\n${ctx.t.video.grokSiblingHintT2v}`
        : modelId === "grok-imagine-r2v"
          ? `\n\n${ctx.t.video.grokSiblingHintR2v}`
          : "";

    // Description goes first; attach the persistent section reply keyboard here
    // (если она нужна), inline для кнопок модели уезжает на хинт-сообщение.
    await ctx.reply(`${modelName}\n\n${modelDesc}\n\n${costLine}${grokSiblingHint}`, {
      reply_markup: sectionReplyMarkup,
    });

    // Для modes-aware моделей generic-хинт лишний — он не отражает режим и
    // дублирует информацию в активационном сообщении после выбора режима
    // (см. mode-select.ts handleModeSet → t.modelModes.activated). Хинт со
    // слотами шлём только если модель single-mode.
    if (!modes) {
      let hint = ctx.t.video.hintVideoDefault;
      let appendVoiceHint = true;
      switch (modelId) {
        case "heygen":
          hint = ctx.t.video.hintHeygen;
          appendVoiceHint = false; // avatar hints already mention voice
          break;
        case "d-id":
          hint = ctx.t.video.hintDid;
          appendVoiceHint = false;
          break;
        case "higgsfield-lite":
        case "higgsfield":
        case "higgsfield-preview":
          hint = ctx.t.video.hintHiggsfield;
          break;
        // У grok-imagine t2v нет media-input слотов — generic hint про
        // «🖼 Чтобы добавить изображения... используйте кнопки слотов ниже»
        // вводит в заблуждение (никаких слотов в этой модели нет).
        // grok-imagine-r2v и grok-imagine-extend имеют слоты (ref_images /
        // source_video) — для них generic hint валиден.
        case "grok-imagine":
          hint = ctx.t.video.hintVideoTextOnly;
          break;
      }
      await ctx.reply(appendVoiceHint ? `${hint}\n\n${ctx.t.voice.inputHint}` : hint, {
        reply_markup: inlineKb,
      });
    }

    // For modes-aware models, send a mode picker. The picker click handler
    // (`mode:` callback) will follow up with the mode-activated message and
    // the filtered slot keyboard. If the user already has a saved mode for
    // this model, send the mode-activated message directly instead.
    if (modes && !options.suppressKeyboard) {
      await sendVideoModePicker(ctx, modelId, modes);
    }

    if (!options.suppressKeyboard) {
      await refreshMediaHint(ctx, "video", modelId);
    }
  } else {
    await ctx.reply(ctx.t.video.modelActivated);
  }
}

/** Send the mode picker message — one button per mode, two per row. */
async function sendVideoModePicker(
  ctx: BotContext,
  modelId: string,
  modes: readonly { id: string; labelKey: string }[],
): Promise<void> {
  const { text, kb } = buildModePickerMenu(modes, "video", modelId, ctx.t);
  await ctx.reply(text, { reply_markup: kb });
}

// ── Model selected via inline callback ───────────────────────────────────────

export async function handleVideoModelSelect(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const modelId = ctx.callbackQuery?.data?.replace("video_model_", "") ?? "";
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => void 0);
  await activateVideoModel(ctx, modelId);
}

/**
 * Family button tapped: data format is `video_family_{familyId}__{modelId}`
 */
export async function handleVideoFamilySelect(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const data = ctx.callbackQuery?.data ?? "";
  const modelId = data.split("__")[1] ?? "";
  if (!modelId || !AI_MODELS[modelId] || !MODEL_TO_FAMILY[modelId]) {
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => void 0);
  await activateVideoModel(ctx, modelId);
}

// ── Media input status menu helper ──────────────────────────────────────────

/** Sends an updated media-input status menu showing filled/empty slots. */
export async function sendVideoMediaInputStatus(
  ctx: BotContext,
  options: { edit?: boolean; prependText?: string; statusText?: string } = {},
): Promise<void> {
  if (!ctx.user) return;
  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.videoModelId ?? "kling";
  const model = AI_MODELS[modelId];
  if (!model?.mediaInputs?.length) return;

  const activeSlots = await getActiveModelSlots(ctx.user.id, modelId);
  if (!activeSlots.length) return;
  const filledInputs = await userStateService.getMediaInputs(ctx.user.id, modelId);
  const { text, kb } = buildMediaInputStatusMenu(activeSlots, filledInputs, "video", ctx.t, {
    promptOptional: model.promptOptional,
    promptOptionalRequiresMedia: model.promptOptionalRequiresMedia,
  });
  const webappUrl = config.bot.webappUrl;
  if (webappUrl) {
    kb.webApp(ctx.t.video.management, `${webappUrl}?page=management&section=video`);
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
  await refreshMediaHint(ctx, "video", modelId);
}

// ── Media input slot callback (mi:video:{slotKey}) ──────────────────────────

/** Sends the upload-prompt message with hint and cancel button for a video slot. */
async function sendVideoSlotUploadPrompt(
  ctx: BotContext,
  slot: NonNullable<(typeof AI_MODELS)[string]["mediaInputs"]>[number],
  modelId: string,
): Promise<void> {
  setActiveSlot(ctx.user!.id, {
    slotKey: slot.slotKey,
    modelId,
    maxImages: slot.maxImages ?? 1,
    section: "video",
  });

  const maxImages = slot.maxImages ?? 1;
  let msg: string;
  if (slot.mode === "reference_element") {
    const label = ctx.t.mediaInput[slot.labelKey as keyof typeof ctx.t.mediaInput] ?? slot.labelKey;
    msg = ctx.t.mediaInput.uploadPromptElement.replace("{slot}", String(label));
  } else if (slot.mode === "motion_video") {
    msg = ctx.t.mediaInput.uploadPromptVideoMotionVideo;
  } else if (slot.mode === "first_clip") {
    msg = ctx.t.mediaInput.uploadPromptVideoFirstClip;
  } else if (maxImages > 1) {
    if (slot.labelKey === "referenceVideos") {
      msg = ctx.t.mediaInput.uploadPromptVideoRefVideos.replace("{max}", String(maxImages));
    } else if (slot.labelKey === "referenceAudios") {
      msg = ctx.t.mediaInput.uploadPromptVideoRefAudios.replace("{max}", String(maxImages));
    } else {
      msg = ctx.t.mediaInput.uploadPromptVideoRefImages.replace("{max}", String(maxImages));
    }
  } else if (slot.labelKey === "lastFrame") {
    msg = ctx.t.mediaInput.uploadPromptVideoLastFrame;
  } else if (slot.labelKey === "motionImage") {
    msg = ctx.t.mediaInput.uploadPromptVideoMotionImage;
  } else if (slot.labelKey === "drivingAudio") {
    msg = ctx.t.mediaInput.uploadPromptVideoDrivingAudio;
  } else if (slot.labelKey === "reference") {
    msg = ctx.t.mediaInput.uploadPromptDesignRef;
  } else {
    msg = ctx.t.mediaInput.uploadPromptVideoFirstFrame;
  }
  const kb = new InlineKeyboard().text(ctx.t.mediaInput.cancel, `mi_cancel:video`);
  const isWan = modelId === "wan";
  const isKlingMotion = modelId === "kling-motion" || modelId === "kling-motion-pro";
  const hint =
    isKlingMotion && slot.mode === "reference_element"
      ? ctx.t.mediaInput.motionElementHint
      : isKlingMotion && slot.mode === "first_frame"
        ? ctx.t.mediaInput.motionImageSlotHint
        : isKlingMotion && slot.mode === "motion_video"
          ? ctx.t.mediaInput.motionVideoSlotHint
          : isKlingMotion
            ? null
            : slot.mode === "reference_element"
              ? ctx.t.mediaInput.refElementHint
              : slot.mode === "reference_image"
                ? ctx.t.mediaInput.referenceImagesHint
                : slot.mode === "reference_video"
                  ? ctx.t.mediaInput.referenceVideosHint
                  : slot.mode === "reference_audio"
                    ? ctx.t.mediaInput.referenceAudiosHint
                    : slot.mode === "driving_audio"
                      ? ctx.t.mediaInput.drivingAudioHint
                      : slot.mode === "first_clip"
                        ? ctx.t.mediaInput.firstClipHint
                        : isWan && slot.mode === "first_frame"
                          ? ctx.t.mediaInput.firstFrameWanHint
                          : isWan && slot.mode === "last_frame"
                            ? ctx.t.mediaInput.lastFrameWanHint
                            : null;
  if (hint) await ctx.reply(hint);
  await ctx.reply(msg, { reply_markup: kb });
}

export async function handleVideoMediaInput(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const data = ctx.callbackQuery?.data ?? "";
  const slotKey = data.replace("mi:video:", "");
  await ctx.answerCallbackQuery();

  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.videoModelId ?? "kling";
  const activeSlots = await getActiveModelSlots(ctx.user.id, modelId);
  const slot = activeSlots.find((s) => s.slotKey === slotKey);
  if (!slot) return;

  const filled = await userStateService.getMediaInputs(ctx.user.id, modelId);
  const existing = filled[slotKey] ?? [];
  const maxImages = slot.maxImages ?? 1;

  if (existing.length) {
    // Drop the menu message we tapped, send preview, then either resume upload or re-show menu.
    await ctx.deleteMessage().catch(() => void 0);
    await sendSlotPreview(ctx, slot, existing);
    if (existing.length < maxImages) {
      await sendVideoSlotUploadPrompt(ctx, slot, modelId);
    } else {
      await sendVideoMediaInputStatus(ctx);
    }
    return;
  }

  // Empty slot → strip keyboard from the menu (keep text in history) and enter upload mode.
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => void 0);
  await sendVideoSlotUploadPrompt(ctx, slot, modelId);
}

/** Callback for mi_cancel:video — cancel active upload slot. */
export async function handleVideoMediaInputCancel(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await ctx.answerCallbackQuery();
  clearActiveSlot(ctx.user.id);
  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.videoModelId ?? "kling";
  const model = AI_MODELS[modelId];
  if (model?.mediaInputs?.length) {
    await sendVideoMediaInputStatus(ctx, {
      edit: true,
      statusText: ctx.t.mediaInput.uploadCancelled,
    });
  } else {
    await ctx.editMessageText(ctx.t.mediaInput.uploadCancelled).catch(() => void 0);
  }
}

/** Callback for mi_done:{slotKey} — user finished uploading multi-image slot. */
export async function handleVideoMediaInputDone(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await ctx.answerCallbackQuery();
  clearActiveSlot(ctx.user.id);
  await sendVideoMediaInputStatus(ctx, { edit: true });
}

/** Callback for mi_generate:video — start generation without a text prompt (promptOptional models). */
export async function handleVideoGenerateNoPrompt(ctx: BotContext): Promise<void> {
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
  await executeVideoPrompt(ctx, "", sourceMessageId);
}

/** Callback for mi_remove:video:{slotKey} — clear a filled slot. */
export async function handleVideoMediaInputRemove(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const data = ctx.callbackQuery?.data ?? "";
  const slotKey = data.replace("mi_remove:video:", "");
  await ctx.answerCallbackQuery();

  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.videoModelId ?? "kling";

  // For element slots: shift subsequent elements down after removal.
  const elemMatch = slotKey.match(/^ref_element_(\d+)$/);
  if (elemMatch) {
    const removed = parseInt(elemMatch[1], 10);
    const current = await userStateService.getMediaInputs(ctx.user.id, modelId);
    // Clear the removed slot and shift higher-numbered elements down.
    for (let i = removed; i <= 5; i++) {
      const nextKey = `ref_element_${i + 1}`;
      const curKey = `ref_element_${i}`;
      const nextVal = current[nextKey];
      if (nextVal?.length) {
        await userStateService.clearMediaInputSlot(ctx.user.id, modelId, curKey);
        for (const url of nextVal) {
          await userStateService.addMediaInput(ctx.user.id, modelId, curKey, url);
        }
      } else {
        await userStateService.clearMediaInputSlot(ctx.user.id, modelId, curKey);
        break;
      }
    }
  } else {
    await userStateService.clearMediaInputSlot(ctx.user.id, modelId, slotKey);
  }
  await sendVideoMediaInputStatus(ctx, { edit: true });
}

// ── Incoming prompt in VIDEO_ACTIVE state ─────────────────────────────────────

function ruPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function applyValidationParams(
  msg: string,
  params?: Record<string, string | number>,
  lang?: string,
): string {
  if (!params) return msg;
  const enriched: Record<string, string | number> = { ...params };
  if (lang === "ru" && params.max !== undefined) {
    const max = Number(params.max);
    enriched.elementWord = ruPlural(max, "элемент", "элемента", "элементов");
    enriched.imageWord = ruPlural(
      max,
      "референсное изображение",
      "референсных изображения",
      "референсных изображений",
    );
  }
  return Object.entries(enriched).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), msg);
}

/**
 * Executes a text prompt in the active video session.
 * Used by handleVideoMessage (text) and the voice-prompt callback.
 */
export async function executeVideoPrompt(
  ctx: BotContext,
  prompt: string,
  sourceMessageId?: string,
  promptMessageId?: number,
  options: { skipModeGate?: boolean } = {},
): Promise<void> {
  if (!ctx.user) return;
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Dedup сначала: если у юзера уже летит активная генерация с этого же
  // sourceMessageId — выходим тихо, без побочных эффектов (включая picker
  // ниже). Без этого дубль-тап мог бы отправить picker сверху "уже
  // генерируется" уведомления.
  if (sourceMessageId) {
    const active = await generationService.hasActiveJobForSource(ctx.user.id, sourceMessageId);
    if (active) return;
  }

  // Mode gate здесь, а не в `handleVideoMessage` — этот же entry point
  // используют voice-prompt callback (`handlers/voice-prompt.handler.ts`) и
  // album/caption flows из `handleVideoPhoto`/`handleVideoVideo`. Без gate в
  // executeVideoPrompt voice-prompt у multi-mode модели без textOnly режима
  // молча падал бы на required-slot validation.
  //
  // `skipModeGate` передают caption-flow'ы из handleVideoPhoto/handleVideoVideo
  // — там media gate уже отработал и гарантирует что mode выбран; повторный
  // gate здесь дал бы 2 лишних DB-read'а на каждое captioned-фото в альбоме.
  if (!options.skipModeGate && !(await ensureVideoModeSelected(ctx, "text"))) return;

  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.videoModelId ?? "kling";

  const videoSettings = await userStateService.getVideoSettings(ctx.user.id);
  const modelSettings = videoSettings[modelId];

  // Slot-based media inputs (per-model; cleared for this model after generation start)
  const mediaInputs = await userStateService.getMediaInputs(ctx.user.id, modelId);
  const hasMediaInputs = Object.keys(mediaInputs).length > 0;
  clearActiveSlot(ctx.user.id);

  // Check required slots before proceeding (filtered to active mode)
  const activeSlots = await getActiveModelSlots(ctx.user.id, modelId);
  if (activeSlots.length) {
    const missing = findMissingRequiredSlot(modelId, activeSlots, mediaInputs);
    if (missing) {
      const label =
        ctx.t.mediaInput[missing.labelKey as keyof typeof ctx.t.mediaInput] ?? missing.labelKey;
      await sendVideoMediaInputStatus(ctx, {
        prependText: ctx.t.mediaInput.slotRequired.replace("{slot}", String(label)),
      });
      return;
    }
  }

  // Resolve full model settings before any state mutations so validation sees
  // the complete picture (voice provider, avatar id, etc.).
  const allModelSettings = await userStateService.getModelSettings(ctx.user.id);
  const fullModelSettings = allModelSettings[modelId] ?? {};

  // Validate before consuming any state — user keeps media inputs if rejected.
  // Peek at one-shot refs via the state row already fetched above (no extra DB call).
  const validationError = videoGenerationService.validateVideoRequest(
    {
      modelId,
      prompt,
      imageUrl: state?.videoRefImageUrl ?? undefined,
      aspectRatio: modelSettings?.aspectRatio,
      duration: (fullModelSettings.duration as number | undefined) ?? modelSettings?.duration,
      modelSettings: fullModelSettings,
      mediaInputs,
      userId: ctx.user.id,
    },
    { hasVoiceFile: !!state?.videoRefVoiceUrl },
  );
  if (validationError) {
    await ctx.reply(
      applyValidationParams(
        ctx.t.video[validationError.key as keyof typeof ctx.t.video] as string,
        validationError.params,
        ctx.user.language,
      ),
    );
    return;
  }

  // Snapshot raw state values for low-iq Cancel-restore (captured BEFORE the
  // existing clear/getAndClear calls — values are exactly what was about to be wiped).
  const snapshotMediaInputs = hasMediaInputs ? { ...mediaInputs } : undefined;

  // Clear media inputs for this model (consumed on generation start)
  if (hasMediaInputs) await userStateService.clearMediaInputs(ctx.user.id, modelId);
  await consumeMediaHint(ctx, "video");

  // For D-ID/HeyGen: pick up any previously saved reference photo (one-shot, legacy path)
  const scratchpadImageUrl =
    (await userStateService.getAndClearVideoRefImageUrl(ctx.user.id)) ?? undefined;
  // For D-ID: pick up any previously saved driver video URL (one-shot)
  const driverUrl = (await userStateService.getAndClearVideoRefDriverUrl(ctx.user.id)) ?? undefined;
  // For HeyGen/D-ID: pick up any previously saved raw voice recording (one-shot)
  const rawVoiceS3Key =
    (await userStateService.getAndClearVideoRefVoiceUrl(ctx.user.id)) ?? undefined;

  // Collect raw mediaInputs (UserState slot values + one-shot voice S3 key) and
  // resolve once — `resolveSlotValue` handles `tg:`-fileIds and bare S3 keys
  // uniformly, returning fresh URLs.
  const pendingMediaInputs: Record<string, string[]> = hasMediaInputs ? { ...mediaInputs } : {};
  if (rawVoiceS3Key) {
    pendingMediaInputs.voice_audio = [rawVoiceS3Key];
    // Scratchpad override — другое аудио чем то, для которого мы стэшили
    // длительность в slot-upload. Чистим, чтобы не подсунуть hint от чужого файла.
    await userStateService.clearVideoVoiceDurationSec(ctx.user.id);
  }
  const hasAnyPending = Object.keys(pendingMediaInputs).length > 0;
  const resolvedMediaInputs = hasAnyPending
    ? await resolveMediaInputUrls(pendingMediaInputs)
    : undefined;

  // AVATAR_MODELS: route scratchpad chat photo (already an http URL) into the
  // avatar_photo slot.
  const routed = routeAvatarPhoto(modelId, scratchpadImageUrl, resolvedMediaInputs);
  const imageUrl = routed.imageUrl;

  // Hint: достоверная длительность загруженного юзером voice'а. Использую
  // ТОЛЬКО если в submit'е реально есть voice_audio — иначе stale значение
  // в БД (от прошлой загрузки) применилось бы к submit'у без аудио.
  const hasVoiceAudioForSubmit = !!routed.mediaInputs?.voice_audio?.[0];
  const audioDurationSecHint = hasVoiceAudioForSubmit
    ? ((await userStateService.getVideoVoiceDurationSec(ctx.user.id)) ?? undefined)
    : undefined;

  // Build submitParams without EL TTS — preGen is deferred until after the gate
  // so that cancelling the confirmation costs the user $0 in EL spend.
  const submitParamsBase = {
    userId: ctx.user.id,
    modelId,
    prompt,
    imageUrl,
    mediaInputs: routed.mediaInputs,
    telegramChatId: chatId,
    sendOriginalLabel: ctx.t.common.sendOriginal,
    aspectRatio: modelSettings?.aspectRatio,
    duration: modelSettings?.duration,
    extraModelSettings: driverUrl ? { driver_url: driverUrl } : undefined,
    sourceMessageId,
    promptMessageId,
    ...(audioDurationSecHint !== undefined ? { audioDurationSecHint } : {}),
  };

  if (
    await gateLowIqMode({
      ctx,
      kind: "video",
      modelId,
      prompt,
      submitParams: submitParamsBase,
      restoreSnapshot: {
        ...(snapshotMediaInputs ? { mediaInputs: snapshotMediaInputs } : {}),
        ...(scratchpadImageUrl ? { videoRefImageUrl: scratchpadImageUrl } : {}),
        ...(driverUrl ? { videoRefDriverUrl: driverUrl } : {}),
        ...(rawVoiceS3Key ? { videoRefVoiceUrl: rawVoiceS3Key } : {}),
      },
    })
  ) {
    return;
  }

  // Confirm-off path: do EL TTS pre-gen now (if applicable), then submit.
  const pendingMsg = await ctx.reply(pickVideoPending(ctx));

  try {
    let elTtsS3Key: string | null = null;
    // Skip TTS pre-gen if voice was already provided via the voice_audio slot
    // (raw scratchpad voice is also routed there above, so this gate covers
    // both UI-filled slot and chat voice messages).
    const voiceAlreadyProvided = !!submitParamsBase.mediaInputs?.voice_audio?.[0];
    if (AVATAR_MODELS.has(modelId) && !voiceAlreadyProvided) {
      const voiceProvider = fullModelSettings.voice_provider as string | undefined;
      if (!voiceProvider || voiceProvider === "elevenlabs" || voiceProvider === "cartesia") {
        await ctx.api
          .editMessageText(chatId, pendingMsg.message_id, ctx.t.video.elVoiceGenerating)
          .catch(() => void 0);
        elTtsS3Key = await preGenerateELTts(
          ctx.user.id,
          modelId,
          prompt,
          fullModelSettings,
          rawVoiceS3Key,
        );
        await ctx.api
          .editMessageText(chatId, pendingMsg.message_id, pickVideoPending(ctx))
          .catch(() => void 0);
      }
    }

    // HeyGen native voice (Jenny и т.п.): EL TTS не отрабатывает, voice_audio
    // пуст. Дальнейший `videoGenerationService.submitVideo` сам синтезирует
    // через HeyGen Starfish (см. heygen-tts.service.ts), чтобы probe увидел
    // реальную длительность и checkBalance не пропустил юзера в минус.
    const submitParams = elTtsS3Key
      ? {
          ...submitParamsBase,
          mediaInputs: await resolveMediaInputUrls({
            ...(submitParamsBase.mediaInputs ?? {}),
            voice_audio: [elTtsS3Key],
          }),
        }
      : submitParamsBase;

    await videoGenerationService.submitVideo(submitParams);

    await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);
    await ctx.reply(pickVideoPending(ctx));
  } catch (err: unknown) {
    await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);
    if (err instanceof Error && err.message === "NO_SUBSCRIPTION") {
      await replyNoSubscription(ctx);
    } else if (err instanceof Error && err.message === "INSUFFICIENT_TOKENS") {
      await replyInsufficientTokens(ctx);
    } else {
      logger.error(err, "Video message error");
      await ctx.reply(ctx.t.video.generationFailed);
    }
  }
}

export async function handleVideoMessage(ctx: BotContext): Promise<void> {
  if (!ctx.user || !ctx.message?.text) return;
  // Mode gate выполняется внутри executeVideoPrompt — единая точка для всех
  // text entry'ев (текстовое сообщение, voice-prompt callback, generate-no-prompt).
  await executeVideoPrompt(ctx, ctx.message.text, undefined, ctx.message.message_id);
}

/**
 * Гарантирует, что у юзера выбран mode для активной multi-mode video-модели.
 * Возвращает `true` — продолжаем хендлер; `false` — мы уже отправили алерт
 * и picker, дальше идти не надо.
 *
 * No-op (возврат `true`) когда: модель не активирована, модель single-mode,
 * либо мод уже выбран явно.
 *
 * Multi-mode + не выбран мод:
 * - `inputKind = "text"`: если в модели есть `textOnly`-режим — тихо
 *   выставляем его (юзер допишет промпт и пойдёт в `executeVideoPrompt`).
 *   Если textOnly режима нет — алерт+picker (модели без text-only генерации
 *   физически не могут принять одинокий текстовый промпт без media-слотов).
 * - `inputKind = "media"`: всегда алерт+picker, файл не сохраняем. Слоты
 *   живут внутри мода — без выбранного мода непонятно куда класть.
 *
 * Race с `handleModeSet` (юзер тапнул picker в те же миллисекунды что
 * отправил текст): re-read прямо перед write сжимает окно до микросекунд.
 * Полностью устранить без DB CAS нельзя, но в этом окне DB-write от
 * handleModeSet почти всегда успевает закоммититься первым; если нет —
 * следующий тап перепишет.
 */
async function ensureVideoModeSelected(
  ctx: BotContext,
  inputKind: "text" | "media",
): Promise<boolean> {
  // `false` означает «алерт+picker отправлены, дальше не идти». Когда нет
  // ctx.user — ничего не отправили, поэтому возвращаем `true` (no-op, иди
  // как обычно). Все текущие вызывающие сами проверяют ctx.user перед
  // обращением, так что эта ветка по факту недостижима — но семантика
  // должна быть корректной для будущих вызовов без guard'а.
  if (!ctx.user) return true;
  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.videoModelId;
  if (!modelId) return true;
  const model = AI_MODELS[modelId];
  const modes = model ? getResolvedModes(model) : null;
  if (!modes) return true;
  const saved = await userStateService.getSelectedMode(ctx.user.id, modelId);
  if (saved) return true;

  if (inputKind === "text") {
    const textOnly = modes.find((m) => m.textOnly);
    if (textOnly) {
      const fresh = await userStateService.getSelectedMode(ctx.user.id, modelId);
      if (fresh) return true;
      await userStateService.setSelectedMode(ctx.user.id, modelId, textOnly.id);
      return true;
    }
  }

  // Dedup picker'а: при загрузке альбома (10-30 фоток подряд) старый код слал
  // picker на каждую. Acquire Redis-lock на 15с — только первый вызов в окне
  // фактически рендерит picker, остальные тихо возвращают false (upload
  // блокируется, но без спама). 15с покрывает типичную загрузку большого
  // альбома (~10-15с). Если юзер за это время выбрал mod — gate выйдет рано
  // по `saved !== null`, lock не трогаем; так что увеличение TTL не вредит
  // legitimate flow. Fail-open: если Redis недоступен, рендерим picker (лучше
  // спам чем потерянный алерт).
  const pickerLockKey = `mode-picker-shown:${ctx.user.id}:video`;
  const acquired = await acquireLock(pickerLockKey, 15).catch(() => true);
  if (acquired) {
    await ctx.reply(ctx.t.modelModes.pickModeFirstForMedia);
    await sendVideoModePicker(ctx, modelId, modes);
  }
  return false;
}

// ── New video dialog ──────────────────────────────────────────────────────────

export async function handleNewVideoDialog(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.setState(ctx.user.id, "VIDEO_SECTION", "video");
  const state = await userStateService.get(ctx.user.id);
  await ctx.reply(ctx.t.video.sectionTitle, {
    reply_markup: buildVideoModelKeyboard(state?.videoModelId),
  });
}

// ── Avatars (HeyGen) ──────────────────────────────────────────────────────────

export async function handleVideoAvatars(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.setState(ctx.user.id, "VIDEO_ACTIVE", "video");
  await userStateService.setModelForSection(ctx.user.id, "video", "heygen");

  const model = AI_MODELS["heygen"];
  if (model) {
    const allSettings = await userStateService.getModelSettings(ctx.user.id);
    const modelSettings = allSettings["heygen"] ?? {};
    const costLine = buildCostLine(model, modelSettings, ctx.t);
    const webappUrl = config.bot.webappUrl;
    const kb = webappUrl
      ? new InlineKeyboard().webApp(
          ctx.t.video.management,
          `${webappUrl}?page=management&section=video`,
        )
      : undefined;
    const { name: heygenName, description: heygenDesc } = resolveModelDisplay(
      "heygen",
      ctx.user.language,
      model,
    );
    await ctx.reply(`👾 ${heygenName}\n\n${heygenDesc}\n\n${costLine}`, {
      reply_markup: kb,
    });
    await ctx.reply(ctx.t.video.hintHeygen);
  }
}

// ── Lip Sync (D-ID) ───────────────────────────────────────────────────────────

export async function handleVideoLipSync(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.setState(ctx.user.id, "VIDEO_ACTIVE", "video");
  await userStateService.setModelForSection(ctx.user.id, "video", "d-id");

  const model = AI_MODELS["d-id"];
  if (model) {
    const allSettings = await userStateService.getModelSettings(ctx.user.id);
    const modelSettings = allSettings["d-id"] ?? {};
    const costLine = buildCostLine(model, modelSettings, ctx.t);
    const webappUrl = config.bot.webappUrl;
    const kb = webappUrl
      ? new InlineKeyboard().webApp(
          ctx.t.video.management,
          `${webappUrl}?page=management&section=video`,
        )
      : undefined;
    const { name: didName, description: didDesc } = resolveModelDisplay(
      "d-id",
      ctx.user.language,
      model,
    );
    await ctx.reply(`🔄 ${didName}\n\n${didDesc}\n\n${costLine}`, {
      reply_markup: kb,
    });
    await ctx.reply(ctx.t.video.hintDid);
  }
}

// ── Photo handler in VIDEO_ACTIVE state ───────────────────────────────────────
// HeyGen: saves as avatar_photo UserUpload + auto-selects in modelSettings
// D-ID: saves as one-shot reference image URL

/**
 * Media-group (album) dedup — see design.ts for rationale.
 */
type VideoMediaGroupEntry = { timer: ReturnType<typeof setTimeout>; processed: boolean };
const videoMediaGroupBuffer = new Map<string, VideoMediaGroupEntry>();

/** Доля площади, начиная с которой считаем кроп «сильным» и предупреждаем юзера. */
const KLING_HEAVY_CROP_THRESHOLD = 0.25;

function parseAspectRatio(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d+):(\d+)$/.exec(s);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return null;
  return w / h;
}

/**
 * Для Kling-семейства при включённом тогле «Автокроп фото под формат»
 * (`crop_to_aspect: true`) — если соотношение сторон загруженного фото
 * сильно отличается от выбранного `aspect_ratio`, возвращает локализованное
 * предупреждение со сжатой ~процентной долей обрезаемой площади. Иначе null.
 *
 * Метрика: `1 - min(actual,target)/max(actual,target)` — доля «лишнего» из
 * меньшей стороны после center-crop'а. Порог 25% покрывает явные mismatch'и
 * (1:1 → 16:9 ≈ 44%, 9:16 → 16:9 ≈ 68%) и не дёргает на близких пропорциях
 * (16:10 → 16:9 ≈ 10%).
 */
async function buildKlingHeavyCropWarning(
  userId: bigint,
  modelId: string,
  widthPx: number | undefined,
  heightPx: number | undefined,
  t: Translations,
): Promise<string | null> {
  if (!widthPx || !heightPx) return null;
  const model = AI_MODELS[modelId];
  if (model?.familyId !== "kling") return null;
  const allSettings = await userStateService.getModelSettings(userId);
  const ms = allSettings[modelId] ?? {};
  if (ms.crop_to_aspect !== true) return null;
  const aspectStr = (ms.aspect_ratio as string | undefined) ?? "16:9";
  const targetAspect = parseAspectRatio(aspectStr);
  if (!targetAspect) return null;
  const actualAspect = widthPx / heightPx;
  const cropped = 1 - Math.min(actualAspect, targetAspect) / Math.max(actualAspect, targetAspect);
  if (cropped < KLING_HEAVY_CROP_THRESHOLD) return null;
  return t.mediaInput.klingHeavyCropWarning
    .replace("{percent}", String(Math.round(cropped * 100)))
    .replace("{aspect}", aspectStr);
}

export async function handleVideoPhoto(ctx: BotContext): Promise<void> {
  const isPhoto = !!ctx.message?.photo;
  const isImageDoc =
    !!ctx.message?.document && ctx.message.document.mime_type?.startsWith("image/");
  if (!ctx.user || (!isPhoto && !isImageDoc)) return;

  if (!(await ensureVideoModeSelected(ctx, "media"))) return;

  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.videoModelId ?? "kling";
  const model = AI_MODELS[modelId];

  // Auto-slot mode (no active slot, model has slots, not an avatar model) wants
  // every sibling in an album to be distributed across slots. Active-slot mode
  // also processes every sibling. Only the legacy "single ref / caption →
  // immediate generate" paths need album dedup.
  const activeSlotForDedup = getActiveSlot(ctx.user.id);
  const isActiveSlotMode = activeSlotForDedup?.section === "video";
  // Slots filtered by the user's selected mode — the auto-distribution path
  // and required-slot lookups must respect mode boundaries.
  const activeModeSlots = await getActiveModelSlots(ctx.user.id, modelId);
  const isAutoSlotMode =
    !isActiveSlotMode && activeModeSlots.length > 0 && !AVATAR_MODELS.has(modelId);
  const mediaGroupId = ctx.message?.media_group_id;
  if (mediaGroupId && !isActiveSlotMode && !isAutoSlotMode) {
    const key = `${ctx.user.id}__${mediaGroupId}`;
    const hasCaption = !!ctx.message?.caption?.trim();
    const existing = videoMediaGroupBuffer.get(key);
    if (existing?.processed) return;
    if (existing) clearTimeout(existing.timer);
    if (hasCaption) {
      videoMediaGroupBuffer.set(key, {
        processed: true,
        timer: setTimeout(() => videoMediaGroupBuffer.delete(key), 10_000),
      });
    } else {
      videoMediaGroupBuffer.set(key, {
        processed: false,
        timer: setTimeout(() => videoMediaGroupBuffer.delete(key), 10_000),
      });
      return;
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
  const promptMessageId = ctx.message.message_id;
  const tgSlotValue = buildTgSlotValue(tgKind, fileId);

  // Lazily resolve the live download URL only for paths that need bytes now
  // (caption+photo, HeyGen avatar legacy, no-caption-no-slot legacy below).
  let cachedTgUrl: string | null = null;
  const getLiveTgUrl = async (): Promise<string> => {
    if (cachedTgUrl) return cachedTgUrl;
    const file = await ctx.api.getFile(fileId);
    cachedTgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
    return cachedTgUrl;
  };

  // ── Slot-based upload (new path) ──────────────────────────────────────────
  const activeSlot = getActiveSlot(ctx.user.id);
  if (activeSlot && activeSlot.section === "video") {
    const slotModelId = activeSlot.modelId;
    const slotsForModel =
      slotModelId === modelId
        ? activeModeSlots
        : await getActiveModelSlots(ctx.user.id, slotModelId);
    const slot = slotsForModel.find((s) => s.slotKey === activeSlot.slotKey);

    // Slot media-type gate: если активный слот принимает только видео/аудио
    // (например `ref_videos`), фото туда класть нельзя — иначе провайдер потом
    // упадёт мид-генерации (Evolink "Failed to detect video duration..." на
    // .jpg URL'е). Раньше этот гейт работал только в auto-slot ветке через
    // pickAutoSlot, а активный слот валидил только размеры.
    if (slot && !getSlotMediaTypes(slot).includes("image")) {
      const types = getSlotMediaTypes(slot);
      const errKey = types.includes("video") ? "mediaSlotVideosOnly" : "mediaSlotAudiosOnly";
      await ctx.reply(ctx.t.errors[errKey]);
      return;
    }

    // Hoist'нуты outside `if (slot?.constraints)` чтобы потом передать в
    // buildKlingHeavyCropWarning после успешного addMediaInput.
    let imageWidthPx: number | undefined = photoSize?.width;
    let imageHeightPx: number | undefined = photoSize?.height;
    if (slot?.constraints) {
      let fileSizeBytes: number | undefined = fileSize || undefined;
      if (isImageDoc) {
        try {
          const probeUrl = await getLiveTgUrl();
          const meta = await probeImageMetadata(probeUrl);
          imageWidthPx = meta.width;
          imageHeightPx = meta.height;
          fileSizeBytes = meta.fileSizeBytes;
        } catch (err) {
          logger.warn({ err }, "probeImageMetadata failed for document");
          await ctx.reply(ctx.t.errors.mediaSlotReadMetadataFailed);
          return;
        }
      }
      const violation = validateMediaAgainstSlot(
        slot,
        { widthPx: imageWidthPx, heightPx: imageHeightPx, fileSizeBytes },
        ctx.t,
      );
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
    // (replace) and multi-image (cyclic) slots.
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

    // Kling «Автокроп фото под формат» + сильный mismatch соотношения —
    // предупреждаем юзера в шапке стандартного «готово» сообщения, что фото
    // будет существенно обрезано. Если condition'ы не сходятся → null,
    // ничего не дописываем.
    const klingCropWarning = await buildKlingHeavyCropWarning(
      userId,
      slotModelId,
      imageWidthPx,
      imageHeightPx,
      ctx.t,
    );

    debounceSlotReply(userId, mediaGroupId, async () => {
      await consumeMediaHint(ctx, "video");
      const freshInputs = await userStateService.getMediaInputs(userId, slotModelId);
      const freshCount = freshInputs[activeSlot.slotKey]?.length ?? 0;

      if (activeSlot.maxImages === 1 || freshCount >= activeSlot.maxImages) {
        clearActiveSlot(userId);
        await sendVideoMediaInputStatus(
          ctx,
          klingCropWarning ? { prependText: klingCropWarning } : {},
        );
      } else {
        const baseMsg = ctx.t.mediaInput.imageSaved
          .replace("{slot}", String(label))
          .replace("{n}", String(freshCount))
          .replace("{max}", String(activeSlot.maxImages));
        const msg = klingCropWarning ? `${klingCropWarning}\n\n${baseMsg}` : baseMsg;
        const kb = new InlineKeyboard().text(
          ctx.t.mediaInput.doneUploading,
          `mi_done:${activeSlot.slotKey}`,
        );
        await ctx.reply(msg, { reply_markup: kb });
      }

      if (caption) {
        // skipModeGate: media gate выше уже отработал, повтор — лишние DB-read'ы.
        await executeVideoPrompt(ctx, caption, undefined, promptMessageId, {
          skipModeGate: true,
        });
      }
    });
    return;
  }

  // ── Auto-slot distribution: distribute sibling photos across slots in
  // definition order; siblings that don't fit anywhere become overflow. After
  // the album debounce settles we send a single status reply (with overflow
  // notice prepended when applicable). If the album carried a caption and all
  // required slots end up filled, we trigger generation with the caption as
  // the prompt — same as if the user had typed it after the upload finished.
  if (isAutoSlotMode && model) {
    const userId = ctx.user.id;
    const current = await userStateService.getMediaInputs(userId, modelId);
    const targetSlot = pickAutoSlot(activeModeSlots, current, "image");
    if (targetSlot) {
      // Constraint validation на upload'е (зеркалит active-slot путь выше).
      // Без этого юзер получает provider-error мид-генерации (типа
      // KIE 422 "Image dimensions must be at least 300 pixels").
      // Hoist'нуты outside constraints-check чтобы передать в Kling crop-warn.
      let imageWidthPx: number | undefined = photoSize?.width;
      let imageHeightPx: number | undefined = photoSize?.height;
      if (targetSlot.constraints) {
        let fileSizeBytes: number | undefined = fileSize || undefined;
        if (isImageDoc) {
          try {
            const probeUrl = await getLiveTgUrl();
            const meta = await probeImageMetadata(probeUrl);
            imageWidthPx = meta.width;
            imageHeightPx = meta.height;
            fileSizeBytes = meta.fileSizeBytes;
          } catch (err) {
            logger.warn({ err }, "probeImageMetadata failed in auto-slot");
            await ctx.reply(ctx.t.errors.mediaSlotReadMetadataFailed);
            return;
          }
        }
        const violation = validateMediaAgainstSlot(
          targetSlot,
          { widthPx: imageWidthPx, heightPx: imageHeightPx, fileSizeBytes },
          ctx.t,
        );
        if (violation) {
          await ctx.reply(violation);
          return;
        }
      }
      await userStateService.addMediaInput(userId, modelId, targetSlot.slotKey, tgSlotValue);
      const klingCropWarning = await buildKlingHeavyCropWarning(
        userId,
        modelId,
        imageWidthPx,
        imageHeightPx,
        ctx.t,
      );
      debounceSlotReply(
        userId,
        mediaGroupId,
        async () => {
          const fresh = await userStateService.getMediaInputs(userId, modelId);
          const count = fresh[targetSlot.slotKey]?.length ?? 0;
          if (count === 0) return;
          const baseMsg = buildSlotUploadedMessage(targetSlot, count, ctx.t);
          await ctx.reply(klingCropWarning ? `${klingCropWarning}\n\n${baseMsg}` : baseMsg);
        },
        targetSlot.slotKey,
      );
    }
    trackDistribution(userId, mediaGroupId, {
      overflow: !targetSlot,
      caption: caption || undefined,
      modelId,
      section: "video",
    });
    debounceSlotReply(userId, mediaGroupId, async () => {
      const tracked = consumeDistribution(userId, mediaGroupId);
      // Re-read active mode внутри debounced callback: outer-scope `activeModeSlots`
      // захвачен в момент входа в handler, а debounce-окно ~500мс — за это время
      // юзер мог переключить режим через mode picker, и старые слоты стали
      // stale. Перечитываем только если действительно нужен (есть overflow или
      // caption для запуска генерации) — иначе лишний DB-read, плюс если он
      // бросит на пустом tracked debounceSlotReply проглотит exception и
      // sendVideoMediaInputStatus не отработает.
      const needsFreshSlots = !!tracked && (tracked.overflowCount > 0 || !!tracked.caption);
      const freshSlots = needsFreshSlots ? await getActiveModelSlots(userId, modelId) : null;
      // freshSlots может быть [] если юзер перещёл в t2v (textOnly) mid-debounce
      // — buildOverflowMessage вернёт "", а ctx.reply("") бросит Telegram 400.
      // Проверяем длину, не саму truthy-ность массива.
      if (tracked && tracked.overflowCount > 0 && freshSlots && freshSlots.length > 0) {
        await ctx.reply(buildOverflowMessage(model, ctx.t, freshSlots));
      }
      await sendVideoMediaInputStatus(ctx);
      if (tracked?.caption && freshSlots) {
        const finalInputs = await userStateService.getMediaInputs(userId, modelId);
        const missingRequired = findMissingRequiredSlot(modelId, freshSlots, finalInputs);
        if (!missingRequired) {
          // skipModeGate: media gate в handleVideoPhoto уже отработал.
          await executeVideoPrompt(ctx, tracked.caption, undefined, promptMessageId, {
            skipModeGate: true,
          });
        }
      }
    });
    return;
  }

  // Below paths (caption+photo legacy, HeyGen, no-caption legacy) need the live URL.
  const tgUrl = await getLiveTgUrl();

  // ── Photo with caption → generate immediately ─────────────────────────────
  if (caption) {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const supportsImages = model?.supportsImages ?? false;

    // If model has media input slots, save the photo to the first slot
    let mediaInputs: Record<string, string[]> | undefined;
    const photoCaptionSlots = await getActiveModelSlots(ctx.user.id, modelId);
    if (supportsImages && photoCaptionSlots.length) {
      const firstSlot = photoCaptionSlots[0];
      if (firstSlot.constraints) {
        let widthPx = photoSize?.width;
        let heightPx = photoSize?.height;
        if (isImageDoc) {
          try {
            const meta = await probeImageMetadata(tgUrl);
            widthPx = meta.width;
            heightPx = meta.height;
          } catch (err) {
            // Зеркалит active-slot/auto-slot ветки: без probe размеры неизвестны,
            // а validateMediaAgainstSlot пропускает undefined (undefined < minWidth
            // === false) — undersized-картинка уходила бы к провайдеру (KIE 422
            // "image dimensions must be at least 300 pixels"). Reject, не continue.
            logger.warn({ err }, "probeImageMetadata failed in caption+photo path");
            await ctx.reply(ctx.t.errors.mediaSlotReadMetadataFailed);
            return;
          }
        }
        const violation = validateMediaAgainstSlot(
          firstSlot,
          { widthPx, heightPx, fileSizeBytes: fileSize },
          ctx.t,
        );
        if (violation) {
          await ctx.reply(violation);
          return;
        }
      }
      mediaInputs = { [firstSlot.slotKey]: [tgUrl] };
    }

    const videoSettings = await userStateService.getVideoSettings(ctx.user.id);
    const modelSettings = videoSettings[modelId];

    const allModelSettings = await userStateService.getModelSettings(ctx.user.id);
    const fullModelSettings = allModelSettings[modelId] ?? {};
    const validationError = videoGenerationService.validateVideoRequest(
      {
        modelId,
        prompt: caption,
        imageUrl: supportsImages ? tgUrl : undefined,
        aspectRatio: modelSettings?.aspectRatio,
        duration: modelSettings?.duration,
        modelSettings: fullModelSettings,
        mediaInputs,
        userId: ctx.user.id,
      },
      { hasVoiceFile: false },
    );
    if (validationError) {
      await ctx.reply(
        applyValidationParams(
          ctx.t.video[validationError.key as keyof typeof ctx.t.video] as string,
          validationError.params,
          ctx.user.language,
        ),
      );
      return;
    }

    if (!supportsImages) {
      await ctx.reply(ctx.t.video.imageIgnoredUnsupported).catch(() => void 0);
    }

    // Build submitParams without EL TTS — preGen is deferred until after the gate.
    const routed = routeAvatarPhoto(modelId, supportsImages ? tgUrl : undefined, mediaInputs);
    // См. executeVideoPrompt — DB hint для cost-preview, только если slot-voice реально в submit'е.
    const hasVoiceAudioForSubmit = !!routed.mediaInputs?.voice_audio?.[0];
    const audioDurationSecHint = hasVoiceAudioForSubmit
      ? ((await userStateService.getVideoVoiceDurationSec(ctx.user.id)) ?? undefined)
      : undefined;
    const submitParamsBase = {
      userId: ctx.user.id,
      modelId,
      prompt: caption,
      imageUrl: routed.imageUrl,
      mediaInputs: routed.mediaInputs,
      telegramChatId: chatId,
      sendOriginalLabel: ctx.t.common.sendOriginal,
      aspectRatio: modelSettings?.aspectRatio,
      duration: modelSettings?.duration,
      promptMessageId,
      ...(audioDurationSecHint !== undefined ? { audioDurationSecHint } : {}),
    };

    if (
      await gateLowIqMode({
        ctx,
        kind: "video",
        modelId,
        prompt: caption,
        submitParams: submitParamsBase,
      })
    ) {
      return;
    }

    const pendingMsg = await ctx.reply(pickVideoPending(ctx));

    try {
      let elTtsS3Key: string | null = null;
      if (AVATAR_MODELS.has(modelId)) {
        const voiceProvider = fullModelSettings.voice_provider as string | undefined;
        if (!voiceProvider || voiceProvider === "elevenlabs" || voiceProvider === "cartesia") {
          await ctx.api
            .editMessageText(chatId, pendingMsg.message_id, ctx.t.video.elVoiceGenerating)
            .catch(() => void 0);
          elTtsS3Key = await preGenerateELTts(
            ctx.user.id,
            modelId,
            caption,
            fullModelSettings,
            undefined,
          );
          await ctx.api
            .editMessageText(chatId, pendingMsg.message_id, pickVideoPending(ctx))
            .catch(() => void 0);
        }
      }

      // HeyGen native voice добивается уже внутри submitVideo (см.
      // executeVideoPrompt выше / heygen-tts.service.ts).
      const submitParams = elTtsS3Key
        ? {
            ...submitParamsBase,
            mediaInputs: await resolveMediaInputUrls({
              ...(submitParamsBase.mediaInputs ?? {}),
              voice_audio: [elTtsS3Key],
            }),
          }
        : submitParamsBase;

      await videoGenerationService.submitVideo(submitParams);

      await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);
      await ctx.reply(pickVideoPending(ctx));
    } catch (err: unknown) {
      await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);
      if (err instanceof Error && err.message === "INSUFFICIENT_TOKENS") {
        await replyInsufficientTokens(ctx);
      } else {
        logger.error(err, "Video photo+caption error");
        await ctx.reply(ctx.t.video.generationFailed);
      }
    }
    return;
  }

  // No caption, no slots — legacy path: save as one-shot reference for next text message
  await userStateService.setVideoRefImageUrl(ctx.user.id, tgUrl);
  await ctx.reply(ctx.t.video.videoPhotoSaved);
}

// ── Video handler in VIDEO_ACTIVE state (D-ID driver_url) ─────────────────────

export async function handleVideoVideo(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const isVideoMsg = !!ctx.message?.video;
  const isVideoDoc = !!ctx.message?.document?.mime_type?.startsWith("video/");
  if (!isVideoMsg && !isVideoDoc) return;
  if (!(await ensureVideoModeSelected(ctx, "media"))) return;
  const state = await userStateService.get(ctx.user.id);
  const modelId = state?.videoModelId;
  if (!modelId) return;
  const model = AI_MODELS[modelId];

  const videoMsg = isVideoMsg ? ctx.message!.video! : null;
  const videoDoc = isVideoDoc ? ctx.message!.document! : null;
  const fileId = (videoMsg?.file_id ?? videoDoc!.file_id) as string;
  const fileSize = videoMsg?.file_size ?? videoDoc?.file_size ?? 0;
  const tgKind: "video" | "doc" = videoMsg ? "video" : "doc";
  if (fileSize > TG_DOWNLOAD_LIMIT_BYTES) {
    await ctx.reply(ctx.t.errors.fileTooLargeForBotApi);
    return;
  }
  const tgSlotValue = buildTgSlotValue(tgKind, fileId);
  const activeModeSlots = await getActiveModelSlots(ctx.user.id, modelId);

  // Active reference_element slot: videos are exclusive (replace any images).
  const activeSlot = getActiveSlot(ctx.user.id);
  if (activeSlot && activeSlot.section === "video") {
    const slotModelId = activeSlot.modelId;
    const slotsForModel =
      slotModelId === modelId
        ? activeModeSlots
        : await getActiveModelSlots(ctx.user.id, slotModelId);
    const slot = slotsForModel.find((s) => s.slotKey === activeSlot.slotKey);

    // Slot media-type gate: видео-файл нельзя класть в image-only слот
    // (например `ref_images`) или audio-only слот.
    if (slot && !getSlotMediaTypes(slot).includes("video")) {
      const types = getSlotMediaTypes(slot);
      const errKey = types.includes("image") ? "mediaSlotImagesOnly" : "mediaSlotAudiosOnly";
      await ctx.reply(ctx.t.errors[errKey]);
      return;
    }

    if (slot?.constraints) {
      let durationSec: number | undefined = videoMsg?.duration;
      let widthPx: number | undefined = videoMsg?.width;
      let heightPx: number | undefined = videoMsg?.height;
      let fileSizeBytes: number | undefined = fileSize || undefined;
      if (isVideoDoc) {
        try {
          const file = await ctx.api.getFile(fileId);
          const probeUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
          const meta = await probeVideoMetadata(probeUrl);
          if (meta.durationSec !== null) durationSec = meta.durationSec;
          if (meta.width !== null) widthPx = meta.width;
          if (meta.height !== null) heightPx = meta.height;
          fileSizeBytes = meta.fileSizeBytes;
        } catch (err) {
          logger.warn({ err }, "probeVideoMetadata failed for document");
          await ctx.reply(ctx.t.errors.mediaSlotReadMetadataFailed);
          return;
        }
      }
      const violation = validateMediaAgainstSlot(
        slot,
        { durationSec, widthPx, heightPx, fileSizeBytes },
        ctx.t,
      );
      if (violation) {
        await ctx.reply(violation);
        return;
      }
    }
    const userId = ctx.user.id;
    const mediaGroupId = ctx.message?.media_group_id;
    if (slot?.mode === "reference_element") {
      if (slot.imagesOnly) {
        await ctx.reply(ctx.t.errors.mediaSlotImagesOnly);
        return;
      }
      await userStateService.clearMediaInputSlot(userId, slotModelId, activeSlot.slotKey);
      await userStateService.addMediaInput(userId, slotModelId, activeSlot.slotKey, tgSlotValue);
      debounceSlotReply(userId, mediaGroupId, async () => {
        await consumeMediaHint(ctx, "video");
        clearActiveSlot(userId);
        await sendVideoMediaInputStatus(ctx);
      });
      return;
    }
    if (slot?.mode === "first_clip" || slot?.mode === "motion_video") {
      await userStateService.clearMediaInputSlot(userId, slotModelId, activeSlot.slotKey);
      await userStateService.addMediaInput(userId, slotModelId, activeSlot.slotKey, tgSlotValue);
      debounceSlotReply(userId, mediaGroupId, async () => {
        await consumeMediaHint(ctx, "video");
        clearActiveSlot(userId);
        await sendVideoMediaInputStatus(ctx);
      });
      return;
    }
    if (slot?.mode === "reference_video") {
      const current = await userStateService.getMediaInputs(userId, slotModelId);
      const existing = current[activeSlot.slotKey] ?? [];
      // Full → FIFO-evict oldest. Don't `clearMediaInputSlot` — that would
      // wipe every prior reference instead of cycling one out.
      const isFull = existing.length >= activeSlot.maxImages;
      await userStateService.addMediaInput(
        userId,
        slotModelId,
        activeSlot.slotKey,
        tgSlotValue,
        isFull,
      );
      debounceSlotReply(userId, mediaGroupId, async () => {
        await consumeMediaHint(ctx, "video");
        const freshInputs = await userStateService.getMediaInputs(userId, slotModelId);
        const freshCount = freshInputs[activeSlot.slotKey]?.length ?? 0;
        if (freshCount >= activeSlot.maxImages) {
          clearActiveSlot(userId);
          await sendVideoMediaInputStatus(ctx);
        } else {
          const kb = new InlineKeyboard().text(
            ctx.t.mediaInput.doneUploading,
            `mi_done:${activeSlot.slotKey}`,
          );
          const label =
            ctx.t.mediaInput[slot.labelKey as keyof typeof ctx.t.mediaInput] ?? slot.labelKey;
          const m = ctx.t.mediaInput.imageSaved
            .replace("{slot}", String(label))
            .replace("{n}", String(freshCount))
            .replace("{max}", String(activeSlot.maxImages));
          await ctx.reply(m, { reply_markup: kb });
        }
      });
      return;
    }
  }

  // ── Auto-slot distribution for videos ─────────────────────────────────────
  // Same mechanic as handleVideoPhoto, but only video-accepting slots are
  // candidates. Lets the user mix photos + videos in one album: each is
  // routed to the first slot that accepts its type.
  if (!activeSlot && activeModeSlots.length > 0 && !AVATAR_MODELS.has(modelId)) {
    const userId = ctx.user.id;
    const mediaGroupId = ctx.message?.media_group_id;
    const caption = ctx.message?.caption?.trim();
    const promptMessageId = ctx.message?.message_id;
    const current = await userStateService.getMediaInputs(userId, modelId);
    const targetSlot = pickAutoSlot(activeModeSlots, current, "video");
    if (targetSlot) {
      if (targetSlot.constraints) {
        let durationSec: number | undefined = videoMsg?.duration;
        let fileSizeBytes: number | undefined = fileSize || undefined;
        if (isVideoDoc) {
          try {
            const file = await ctx.api.getFile(fileId);
            const probeUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
            const meta = await probeVideoMetadata(probeUrl);
            if (meta.durationSec !== null) durationSec = meta.durationSec;
            fileSizeBytes = meta.fileSizeBytes;
          } catch (err) {
            logger.warn({ err }, "probeVideoMetadata failed in auto-slot");
            await ctx.reply(ctx.t.errors.mediaSlotReadMetadataFailed);
            return;
          }
        }
        const violation = validateMediaAgainstSlot(
          targetSlot,
          { durationSec, fileSizeBytes },
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
      section: "video",
    });
    debounceSlotReply(userId, mediaGroupId, async () => {
      const tracked = consumeDistribution(userId, mediaGroupId);
      // Re-read active mode внутри debounced callback: outer-scope `activeModeSlots`
      // захвачен в момент входа в handler, а debounce-окно ~500мс — за это время
      // юзер мог переключить режим через mode picker, и старые слоты стали
      // stale. Перечитываем только если действительно нужен (есть overflow или
      // caption для запуска генерации) — иначе лишний DB-read, плюс если он
      // бросит на пустом tracked debounceSlotReply проглотит exception и
      // sendVideoMediaInputStatus не отработает.
      const needsFreshSlots = !!tracked && (tracked.overflowCount > 0 || !!tracked.caption);
      const freshSlots = needsFreshSlots ? await getActiveModelSlots(userId, modelId) : null;
      // freshSlots может быть [] если юзер перещёл в t2v (textOnly) mid-debounce
      // — buildOverflowMessage вернёт "", а ctx.reply("") бросит Telegram 400.
      // Проверяем длину, не саму truthy-ность массива.
      if (tracked && tracked.overflowCount > 0 && freshSlots && freshSlots.length > 0) {
        await ctx.reply(buildOverflowMessage(model, ctx.t, freshSlots));
      }
      await sendVideoMediaInputStatus(ctx);
      if (tracked?.caption && freshSlots) {
        const finalInputs = await userStateService.getMediaInputs(userId, modelId);
        const missingRequired = findMissingRequiredSlot(modelId, freshSlots, finalInputs);
        if (!missingRequired) {
          // skipModeGate: media gate в handleVideoVideo уже отработал.
          await executeVideoPrompt(ctx, tracked.caption, undefined, promptMessageId, {
            skipModeGate: true,
          });
        }
      }
    });
    return;
  }

  if (!model?.supportsVideo) return;
  const file = await ctx.api.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
  await userStateService.setVideoRefDriverUrl(ctx.user.id, fileUrl);
  await ctx.reply(ctx.t.video.videoDriverSaved);
}

// ── HEYGEN_AVATAR_PHOTO state: capture photo, persist to S3, enqueue worker ──

export async function handleAvatarPhotoCapture(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  // Accept either a compressed photo or an image-document upload.
  let fileId: string | undefined;
  let mimeHint: string | undefined;
  if (ctx.message?.photo) {
    fileId = ctx.message.photo.at(-1)?.file_id;
  } else if (ctx.message?.document?.mime_type?.startsWith("image/")) {
    fileId = ctx.message.document.file_id;
    mimeHint = ctx.message.document.mime_type;
  }
  if (!fileId) return;

  const file = await ctx.api.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;

  const userId = ctx.user.id;
  const telegramId = ctx.user.telegramId;
  // chat_id для Telegram API. Если по какой-то причине ctx.chat пуст —
  // fallback на telegramId юзера. Никогда не подставляем internal id.
  const chatId = ctx.chat?.id ?? (telegramId ? Number(telegramId) : undefined);
  if (chatId === undefined) return;

  // Fetch original image to (a) detect content-type and (b) build a thumbnail.
  const imgRes = await fetch(tgUrl);
  if (!imgRes.ok) throw new Error(`Failed to fetch avatar photo from Telegram: ${imgRes.status}`);
  const imageBuffer = Buffer.from(await imgRes.arrayBuffer());
  const contentType =
    mimeHint ??
    (imgRes.headers.get("content-type")?.startsWith("image/")
      ? imgRes.headers.get("content-type")!
      : "image/jpeg");

  // Persist original to S3 so the worker can fetch it via presigned URL.
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const s3Key = `avatar_photo/${userId.toString()}/${file.file_id}.${ext}`;
  const uploadedKey = await s3Service.uploadBuffer(s3Key, imageBuffer, contentType);
  if (!uploadedKey) throw new Error("Failed to upload avatar source to S3");

  // Thumbnail (best-effort, used as preview).
  let previewUrl: string | undefined;
  const thumbBuffer = await s3Service.generateThumbnail(imageBuffer, contentType).catch(() => null);
  if (thumbBuffer) {
    const thumbKey = `avatar_photo/${userId.toString()}/${file.file_id}_thumb.webp`;
    const uploadedThumbKey = await s3Service
      .uploadBuffer(thumbKey, thumbBuffer, "image/webp")
      .catch(() => null);
    if (uploadedThumbKey) previewUrl = uploadedThumbKey;
  }

  // Create UserAvatar in `creating` state — worker will fill in externalId + providerKeyId.
  const avatar = await userAvatarService.create(userId, {
    provider: "heygen",
    name: ctx.t.video.myAvatarDefaultName,
    externalId: undefined,
    status: "creating",
    previewUrl,
  });

  await getAvatarQueue().add(
    "create",
    {
      userAvatarId: avatar.id,
      userId: userId.toString(),
      provider: "heygen",
      action: "create",
      s3Key: uploadedKey,
      telegramChatId: chatId,
    },
    {
      jobId: avatar.id,
      removeOnComplete: true,
      // Симметрично generation-jobs: transient blip к провайдеру не должен убить
      // создание аватара после первого же сбоя.
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    },
  );

  // Show the section reply keyboard immediately; ready message arrives async from worker.
  const webappUrl = config.bot.webappUrl;
  const token = webappUrl && telegramId ? generateWebToken(telegramId, config.bot.token) : "";
  const managementBtn = webappUrl
    ? {
        text: ctx.t.video.management,
        web_app: { url: `${webappUrl}?page=management&section=video&wtoken=${token}` },
      }
    : { text: ctx.t.video.management };

  await ctx.reply(ctx.t.video.avatarCreationStarted, {
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

  // Auto-activate HeyGen so the user can immediately submit a prompt.
  const currentState = await userStateService.get(userId);
  if (currentState?.videoModelId === "heygen" || currentState?.state !== "VIDEO_ACTIVE") {
    await activateVideoModel(ctx, "heygen");
  }
}

export async function handleHeygenAvatarCancel(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.setState(ctx.user.id, "VIDEO_ACTIVE", "video");
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(ctx.t.video.avatarCreationCancelled).catch(() => void 0);
}

// ── Voice/audio handler in VIDEO_ACTIVE state ────────────────────────────────
// Non-avatar models: transcribe speech → offer as text prompt.
// Avatar models (HeyGen, D-ID): offer choice — use as lip-sync audio OR transcribe.

export async function handleVideoVoice(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const audioMsg = ctx.message?.voice ?? ctx.message?.audio;
  if (!audioMsg) return;

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const userId = ctx.user.id;
  const state = await userStateService.get(userId);
  const modelId = state?.videoModelId ?? "kling";

  // Active reference_audio slot: capture audio URL into slot.
  const activeSlot = getActiveSlot(userId);
  if (activeSlot && activeSlot.section === "video") {
    const slotModelId = activeSlot.modelId;
    const slotsForVoice = await getActiveModelSlots(userId, slotModelId);
    const slot = slotsForVoice.find((s) => s.slotKey === activeSlot.slotKey);
    if (slot?.mode === "driving_audio" || slot?.mode === "reference_audio") {
      const audioSize = audioMsg.file_size ?? 0;
      if (audioSize > TG_DOWNLOAD_LIMIT_BYTES) {
        await ctx.reply(ctx.t.errors.fileTooLargeForBotApi);
        return;
      }
      const tgKind = ctx.message?.voice ? "voice" : "audio";
      const tgSlotValue = buildTgSlotValue(tgKind, audioMsg.file_id);
      if (slot.mode === "driving_audio") {
        await userStateService.clearMediaInputSlot(userId, slotModelId, activeSlot.slotKey);
        await userStateService.addMediaInput(userId, slotModelId, activeSlot.slotKey, tgSlotValue);
        // Замеряем длительность для cost-preview hint (см. probeTelegramAudioDurationSec).
        // Только для моделей с per-second биллингом по входному аудио (HeyGen).
        //
        // ВАЖНО: чистим DB ПЕРЕД probe — иначе если getFile / probe сорвётся
        // (транзиентный TG fail), старая duration осталась бы в DB и применилась
        // бы к НОВОМУ файлу на сабмите → exploit vector (можно подменить voice
        // на длинный, заранее залив короткий с известной duration).
        if (slotModelId === "heygen") {
          await userStateService.clearVideoVoiceDurationSec(userId);
          const tgFile = await ctx.api.getFile(audioMsg.file_id).catch(() => null);
          if (tgFile?.file_path) {
            const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${tgFile.file_path}`;
            const durSec = await probeTelegramAudioDurationSec(
              tgUrl,
              !!ctx.message?.voice,
              audioMsg.duration,
              audioMsg.file_size,
            );
            if (durSec) {
              await userStateService.setVideoVoiceDurationSec(userId, durSec);
            }
          }
        }
        clearActiveSlot(userId);
        await consumeMediaHint(ctx, "video");
        await sendVideoMediaInputStatus(ctx);
        return;
      }
      const current = await userStateService.getMediaInputs(userId, slotModelId);
      const existing = current[activeSlot.slotKey] ?? [];
      // Full → FIFO-evict oldest. Don't `clearMediaInputSlot` — that would
      // wipe every prior reference audio instead of cycling one out.
      const isFull = existing.length >= activeSlot.maxImages;
      await userStateService.addMediaInput(
        userId,
        slotModelId,
        activeSlot.slotKey,
        tgSlotValue,
        isFull,
      );
      await consumeMediaHint(ctx, "video");
      const updatedCount = Math.min(existing.length + 1, activeSlot.maxImages);
      if (updatedCount >= activeSlot.maxImages) {
        clearActiveSlot(userId);
        await sendVideoMediaInputStatus(ctx);
      } else {
        const kb = new InlineKeyboard().text(
          ctx.t.mediaInput.doneUploading,
          `mi_done:${activeSlot.slotKey}`,
        );
        const label =
          ctx.t.mediaInput[slot.labelKey as keyof typeof ctx.t.mediaInput] ?? slot.labelKey;
        const m = ctx.t.mediaInput.imageSaved
          .replace("{slot}", String(label))
          .replace("{n}", String(updatedCount))
          .replace("{max}", String(activeSlot.maxImages));
        await ctx.reply(m, { reply_markup: kb });
      }
      return;
    }
  }

  if (!AVATAR_MODELS.has(modelId)) {
    // Non-avatar model: transcribe voice → offer as prompt
    await transcribeAndReply(ctx, "video");
    return;
  }

  // Avatar model: upload to S3, then show choice buttons
  const file = await ctx.api.getFile(audioMsg.file_id);
  const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;

  const isVoice = !!ctx.message?.voice;
  const contentType = isVoice ? "audio/ogg" : (ctx.message?.audio?.mime_type ?? "audio/mpeg");
  const ext = isVoice ? "ogg" : (file.file_path?.split(".").pop() ?? "mp3");

  const s3Key = `voice/${userId.toString()}/${file.file_id}.${ext}`;
  const uploadedKey = await s3Service.uploadFromUrl(s3Key, tgUrl, contentType).catch(() => null);

  // Достоверная длительность для cost-preview hint (см. probeTelegramAudioDurationSec).
  const durationSec = await probeTelegramAudioDurationSec(
    tgUrl,
    isVoice,
    audioMsg.duration,
    audioMsg.file_size,
  );

  // Generate an ID and store voice data for both callback paths
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  storeAvatarVoice(userId, id, {
    uploadedKey,
    tgUrl,
    voiceMessageId: ctx.message?.message_id,
    ...(durationSec ? { durationSec } : {}),
  });

  const kb = new InlineKeyboard()
    .text(ctx.t.voice.avatarChoiceUseAudio, `va:${id}`)
    .row()
    .text(ctx.t.voice.avatarChoiceTranscribe, `vt:${id}`);

  await ctx.reply(ctx.t.video.videoVoiceSaved, { reply_markup: kb });
}

/**
 * Callback: user chose to use voice as raw audio for avatar lip-sync.
 * Continues the previous avatar voice flow.
 */
export async function handleVideoAvatarVoiceCallback(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;

  const id = ctx.callbackQuery?.data?.slice(3); // "va:{id}" → id
  if (!id) return;

  const entry = getAvatarVoice(ctx.user.id, id);
  if (!entry) {
    await ctx.reply(ctx.t.voice.expired);
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Remove choice message
  await ctx.deleteMessage().catch(() => void 0);

  const userId = ctx.user.id;
  const state = await userStateService.get(userId);
  const modelId = state?.videoModelId ?? "kling";

  const allModelSettings = await userStateService.getModelSettings(userId);
  const fullModelSettings = allModelSettings[modelId] ?? {};
  const videoSettings = await userStateService.getVideoSettings(userId);
  const modelSettings = videoSettings[modelId];
  const scratchpadImageUrl =
    (await userStateService.getAndClearVideoRefImageUrl(userId)) ?? undefined;

  const validationError = videoGenerationService.validateVideoRequest(
    {
      modelId,
      prompt: "",
      imageUrl: scratchpadImageUrl,
      aspectRatio: modelSettings?.aspectRatio,
      duration: modelSettings?.duration,
      modelSettings: fullModelSettings,
      userId,
    },
    { hasVoiceFile: true },
  );
  if (validationError) {
    await ctx.reply(
      applyValidationParams(
        ctx.t.video[validationError.key as keyof typeof ctx.t.video] as string,
        validationError.params,
        ctx.user.language,
      ),
    );
    return;
  }

  const routed = routeAvatarPhoto(modelId, scratchpadImageUrl, undefined);
  // Mirrors the previous `entry.uploadedKey ? ... : entry.tgUrl` truthy gate —
  // empty string (rare) falls through to tgUrl, matching pre-migration semantics.
  const voiceValue = entry.uploadedKey || entry.tgUrl;
  const submitParams = {
    userId,
    modelId,
    prompt: "",
    imageUrl: routed.imageUrl,
    mediaInputs: await resolveMediaInputUrls({
      ...(routed.mediaInputs ?? {}),
      voice_audio: [voiceValue],
    }),
    telegramChatId: chatId,
    sendOriginalLabel: ctx.t.common.sendOriginal,
    aspectRatio: modelSettings?.aspectRatio,
    duration: modelSettings?.duration,
    promptMessageId: entry.voiceMessageId,
    // Достоверная длительность от ffprobe-at-upload (или TG-server для voice'ов).
    ...(entry.durationSec !== undefined ? { audioDurationSecHint: entry.durationSec } : {}),
  };

  if (
    await gateLowIqMode({
      ctx,
      kind: "video",
      modelId,
      prompt: "",
      submitParams,
      promptDisplay: ctx.t.confirmGeneration.voicePrompt,
      restoreSnapshot: {
        ...(scratchpadImageUrl ? { videoRefImageUrl: scratchpadImageUrl } : {}),
      },
    })
  ) {
    return;
  }

  const pendingMsg = await ctx.reply(ctx.t.video.videoVoiceQueuing);

  try {
    await videoGenerationService.submitVideo(submitParams);

    await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);
    await ctx.reply(pickVideoPending(ctx));
  } catch (err: unknown) {
    await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);
    if (err instanceof Error && err.message === "NO_SUBSCRIPTION") {
      await replyNoSubscription(ctx);
    } else if (err instanceof Error && err.message === "INSUFFICIENT_TOKENS") {
      await replyInsufficientTokens(ctx);
    } else {
      logger.error(err, "Video avatar voice error");
      await ctx.reply(ctx.t.video.generationFailed);
    }
  }
}

// ── HIGGSFIELD_SOUL_PHOTO state: collect photos for Soul character creation ──

/** Cost of Soul character creation in USD */
const SOUL_COST_USD = 2.5;

/**
 * Receives a photo (compressed or document) while in HIGGSFIELD_SOUL_PHOTO state.
 * Stores the Telegram file_id (no TTL) in the persistent Soul buffer so the user
 * can pause mid-upload without losing progress. S3 upload is deferred until submit.
 * Uses debounceSoulReply to send only one reply per media group (album).
 */
export async function handleSoulPhotoCapture(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  let fileId: string | undefined;
  let tgKind: "photo" | "doc" | undefined;
  if (ctx.message?.photo) {
    fileId = ctx.message.photo.at(-1)?.file_id;
    tgKind = "photo";
  } else if (ctx.message?.document?.mime_type?.startsWith("image/")) {
    fileId = ctx.message.document.file_id;
    tgKind = "doc";
  }
  if (!fileId || !tgKind) return;

  const userId = ctx.user.id;

  const fileEntry = buildTgSlotValue(tgKind, fileId);
  const count = await addSoulPhoto(userId, fileEntry);

  // Debounce reply for media groups (albums) — only send one message per group
  debounceSoulReply(userId, ctx.message?.media_group_id, async () => {
    // Re-read count after debounce (more photos may have arrived)
    const currentBuf = await getSoulBuffer(userId);
    const n = currentBuf?.fileIds.length ?? count;

    const text = ctx.t.video.soulPhotoCount
      .replace("{n}", String(n))
      .replace("{max}", String(SOUL_MAX_PHOTOS));

    const kb = new InlineKeyboard();
    if (n >= SOUL_MIN_PHOTOS) {
      kb.text(ctx.t.video.soulCreateButton.replace("{n}", String(n)), "soul_create_submit").row();
    }
    kb.text(ctx.t.video.soulCancelButton, "soul_create_cancel");

    await ctx.reply(text, { reply_markup: kb });
  });
}

/**
 * Callback: user taps "Create character" after uploading photos.
 * Validates min photos, checks balance, deducts $2.50, resolves Telegram file_ids
 * into S3 keys, creates UserAvatar + queue job.
 */
export async function handleSoulCreateSubmit(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await ctx.answerCallbackQuery();

  const userId = ctx.user.id;
  const telegramId = ctx.user.telegramId;
  try {
    if (!(await acquireLock(`dedup:soul:${userId}`, 120))) return;
  } catch {
    // Redis unavailable — proceed without dedup rather than blocking the user
  }

  try {
    const buf = await clearSoulBuffer(userId);

    if (!buf || buf.fileIds.length < SOUL_MIN_PHOTOS) {
      const n = buf?.fileIds.length ?? 0;
      await ctx
        .editMessageText(
          ctx.t.video.soulMinPhotos
            .replace("{min}", String(SOUL_MIN_PHOTOS))
            .replace("{n}", String(n)),
        )
        .catch(() => void 0);
      await userStateService.setState(userId, "DESIGN_ACTIVE", "design");
      return;
    }

    // Check balance ($2.50)
    const costTokens = usdToTokens(SOUL_COST_USD);
    try {
      await checkBalance(userId, costTokens);
    } catch {
      await ctx.editMessageText(ctx.t.errors.insufficientTokens).catch(() => void 0);
      await userStateService.setState(userId, "DESIGN_ACTIVE", "design");
      return;
    }

    // Show progress message while we download + upload photos
    await ctx.editMessageText(ctx.t.video.soulCreating).catch(() => void 0);

    // Resolve Telegram file_ids → S3 keys. Deferred from capture time so the user
    // can take their time uploading without TTL pressure.
    const s3Keys: string[] = [];
    for (const entry of buf.fileIds) {
      const rest = entry.startsWith("tg:") ? entry.slice(3) : entry;
      const idx = rest.indexOf(":");
      const fileId = idx === -1 ? rest : rest.slice(idx + 1);
      if (!fileId) continue;
      try {
        const file = await ctx.api.getFile(fileId);
        const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
        const s3Key = `soul_photos/${userId.toString()}/${Date.now()}_${file.file_id}.jpg`;
        const uploaded = await s3Service.uploadFromUrl(s3Key, tgUrl, "image/jpeg");
        if (uploaded) s3Keys.push(uploaded);
      } catch (err) {
        logger.warn({ userId, fileId, err }, "Soul photo S3 upload failed, skipping");
      }
    }

    if (s3Keys.length < SOUL_MIN_PHOTOS) {
      await ctx.reply(
        ctx.t.video.soulMinPhotos
          .replace("{min}", String(SOUL_MIN_PHOTOS))
          .replace("{n}", String(s3Keys.length)),
      );
      await userStateService.setState(userId, "DESIGN_ACTIVE", "design");
      return;
    }

    // Списание токенов происходит ПОСЛЕ успешного создания персонажа
    // (в avatar.processor.ts на стадии poll status="ready"). Здесь только
    // checkBalance как гейт — если баланс не пройдёт, возврата фото не делаем.

    // Create UserAvatar record
    const avatar = await userAvatarService.create(userId, {
      provider: "higgsfield_soul",
      name: ctx.t.video.myAvatarDefaultName,
      externalId: undefined,
      status: "creating",
      previewUrl: undefined,
    });

    // Enqueue avatar creation job
    await getAvatarQueue().add(
      "create",
      {
        userAvatarId: avatar.id,
        userId: userId.toString(),
        provider: "higgsfield_soul",
        action: "create",
        telegramChatId: ctx.chat?.id ?? (telegramId ? Number(telegramId) : 0),
        s3Keys,
        characterName: ctx.t.video.myAvatarDefaultName,
      },
      {
        jobId: avatar.id,
        removeOnComplete: true,
        // Симметрично generation-jobs: transient blip к провайдеру не должен
        // убить создание аватара после первого же сбоя.
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    );

    // Restore FSM to DESIGN_ACTIVE
    await userStateService.setState(userId, "DESIGN_ACTIVE", "design");
  } finally {
    await releaseLock(`dedup:soul:${userId}`);
  }
}

/**
 * Callback: user cancels Soul character creation.
 * Clears buffer, restores FSM to DESIGN_ACTIVE.
 */
export async function handleSoulCreateCancel(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await ctx.answerCallbackQuery();

  await clearSoulBuffer(ctx.user.id);
  await userStateService.setState(ctx.user.id, "DESIGN_ACTIVE", "design");
  await ctx.editMessageText(ctx.t.video.soulCancelled).catch(() => void 0);
}

/**
 * Callback: user chose to transcribe voice instead of using as avatar audio.
 */
export async function handleVideoTranscribeCallback(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!ctx.user) return;

  const id = ctx.callbackQuery?.data?.slice(3); // "vt:{id}" → id
  if (!id) return;

  // Remove choice buttons
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => void 0);

  // We need to get the original audio to transcribe it. The avatar voice store
  // has the S3 key / TG URL. Download and transcribe.
  const entry = getAvatarVoice(ctx.user.id, id);
  if (!entry) {
    await ctx.reply(ctx.t.voice.expired);
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const pendingMsg = await ctx.reply(ctx.t.voice.transcribing);

  try {
    const url = entry.uploadedKey
      ? await (async () => {
          const { getFileUrl } = await import("@metabox/api/services/s3");
          return (await getFileUrl(entry.uploadedKey!)) ?? entry.tgUrl;
        })()
      : entry.tgUrl;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const { transcribeAudio } = await import("@metabox/api/services/transcription");
    const lang = ctx.user!.language === "ru" ? "ru" : undefined;
    const text = await transcribeAudio(buffer, "audio/ogg", lang);

    await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);

    if (!text.trim()) {
      await ctx.reply(ctx.t.voice.failed);
      return;
    }

    // Store and show transcription with "Use as prompt" button
    const { randomBytes } = await import("crypto");
    const vpId = randomBytes(6).toString("hex");
    storeVoiceText(ctx.user!.id, vpId, text, entry.voiceMessageId);

    const { escapeMarkdownV2 } = await import("../utils/voice-transcribe.js");
    const header = escapeMarkdownV2(ctx.t.voice.transcriptionResult);
    const hint = escapeMarkdownV2(ctx.t.voice.transcriptionHint);
    const md2Text = `${header}\n\n\`\`\`\n${text}\n\`\`\`\n\n${hint}`;

    const kb = new InlineKeyboard().text(ctx.t.voice.useAsPrompt, `vp:video:${vpId}`);
    await ctx.reply(md2Text, { parse_mode: "MarkdownV2", reply_markup: kb });
  } catch (err) {
    logger.error(err, "handleVideoTranscribeCallback: failed");
    await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);
    await ctx.reply(ctx.t.voice.failed);
  }
}

// ── Grok Imagine: Extend video flow ─────────────────────────────────────────

/**
 * Кнопка «Продлить» под результатом Grok-видео. Callback data:
 * `video_extend_{outputId}`.
 *
 * Активирует скрытую модель `grok-imagine-extend`, прикрепляет исходное видео
 * в slot `source_video` (хранится как сырой s3-ключ — бот при submit'е резолвит
 * через `resolveMediaInputUrls` → presigned URL для FAL).
 *
 * После активации юзер просто шлёт текстовый промпт — стандартный
 * `executeVideoPrompt` flow возьмёт `videoModelId="grok-imagine-extend"`,
 * сгенерит extension через FAL endpoint `xai/grok-imagine-video/extend-video`.
 *
 * НЕ показывается под результатом самого extend'а (там output >15s типично,
 * FAL не примет повторно как input).
 */
export async function handleVideoExtendEntry(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const outputId = (ctx.callbackQuery?.data ?? "").replace("video_extend_", "");
  await ctx.answerCallbackQuery();

  const output = await generationService.getOutputById(outputId);
  if (!output?.s3Key) {
    await ctx.reply(ctx.t.video.extendNotAvailable);
    return;
  }

  // Защита от попыток продлить не-Grok видео (теоретически кнопка не должна
  // отображаться под другими моделями, но защищаемся на случай старых
  // callback-данных в чате). `grok-imagine-extend` тоже разрешён —
  // итеративное продление пока output укладывается в FAL-лимит 2-15s
  // (длину чекает воркер при прикреплении кнопки).
  const allowedSourceModels = new Set(["grok-imagine", "grok-imagine-r2v", "grok-imagine-extend"]);
  if (!allowedSourceModels.has(output.modelId)) {
    await ctx.reply(ctx.t.video.extendNotAvailable);
    return;
  }

  const EXTEND_MODEL_ID = "grok-imagine-extend";
  // Сбрасываем активный upload-slot (вдруг юзер был mid-upload в другую
  // модель), затем переключаем state на extend-режим.
  clearActiveSlot(ctx.user.id);
  await userStateService.setState(ctx.user.id, "VIDEO_ACTIVE", "video");
  await userStateService.setModelForSection(ctx.user.id, "video", EXTEND_MODEL_ID);
  // Очищаем все слоты у extend-модели и кладём ровно один — source_video с
  // s3-ключом исходного результата. resolveMediaInputUrls на submit'е
  // подпишет URL для FAL.
  await userStateService.clearMediaInputs(ctx.user.id, EXTEND_MODEL_ID);
  await userStateService.addMediaInput(ctx.user.id, EXTEND_MODEL_ID, "source_video", output.s3Key);

  await ctx.reply(ctx.t.video.extendActivated);
}
