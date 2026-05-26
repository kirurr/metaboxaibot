import type { BotContext } from "../types/context.js";
import {
  generationService,
  userStateService,
  s3Service,
  translatePromptIfNeeded,
  ImageDecodeError,
} from "@metabox/api/services";
import {
  AI_MODELS,
  config,
  UserFacingError,
  resolveUserFacingErrorVariant,
  pickGenerationFailedMessage,
  PHOTO_CREATE_MODEL_ID,
  PHOTO_CREATE_BUFFER_MODEL_ID,
  PHOTO_CREATE_PROMPT_MAX_CHARS,
  PHOTO_CREATE_RESOLUTION,
  PHOTO_CREATE_AR_OPTIONS,
  PHOTO_CREATE_RES_OPTIONS,
  snapPhotoCreateAr,
} from "@metabox/shared";
import { InlineKeyboard } from "grammy";
import { logger } from "../logger.js";
import { buildCostLine } from "../utils/cost-line.js";
import { resolveMediaInputUrls } from "../utils/media-input-state.js";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";
import { isImageDocument } from "./upscale.js";

/**
 * Сценарий «📸 Создать фотографию». Под капотом — `nano-banana-pro`.
 * Четыре шага:
 *  1) фото-референс,
 *  2) текстовое описание (auto-translate ru→en silent),
 *  3) выбор aspect_ratio из инлайн-клавиатуры (Авто / 1:1 / 16:9 / 9:16 / 4:3 / 3:4),
 *  4) выбор resolution из инлайн-клавиатуры (2K / 4K).
 * «Авто» snap'ится к ближайшему из supported по размеру исходника. Модель
 * замаскирована: displayName = «📸 Создать фотографию», без refine-кнопки.
 */

const PHOTO_CREATE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** Slot keys в `UserState.mediaInputs` для переноса данных между шагами. */
const PHOTO_CREATE_SRC_SLOT = "src";
const PHOTO_CREATE_W_SLOT = "w";
const PHOTO_CREATE_H_SLOT = "h";
const PHOTO_CREATE_PROMPT_SLOT = "prompt";
const PHOTO_CREATE_AR_SLOT = "ar";

const PHOTO_CREATE_EXTRA_SETTINGS: Record<string, string> = {
  resolution: PHOTO_CREATE_RESOLUTION,
};

/**
 * In-memory dedup of Telegram media groups (albums) — берём только первое
 * фото альбома, остальные siblings игнорируем (ключ `${userId}:${groupId}`).
 */
const processedMediaGroups = new Set<string>();

function rememberMediaGroup(key: string): void {
  processedMediaGroups.add(key);
  if (processedMediaGroups.size > 1000) {
    const iter = processedMediaGroups.values();
    for (let i = 0; i < 100; i++) {
      const v = iter.next().value;
      if (v) processedMediaGroups.delete(v);
    }
  }
}

/** Inline-клавиатура выбора AR: 2 кнопки в ряд. */
function buildArKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < PHOTO_CREATE_AR_OPTIONS.length; i += 2) {
    const left = PHOTO_CREATE_AR_OPTIONS[i];
    const right = PHOTO_CREATE_AR_OPTIONS[i + 1];
    kb.text(left.label, `photo_create:ar:${left.value}`);
    if (right) kb.text(right.label, `photo_create:ar:${right.value}`);
    kb.row();
  }
  return kb;
}

/** Inline-клавиатура выбора resolution: 2K / 4K в один ряд. */
function buildResKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const opt of PHOTO_CREATE_RES_OPTIONS) {
    kb.text(opt.label, `photo_create:res:${opt.value}`);
  }
  return kb;
}

/** Entry — user tapped «📸 Создать фотографию» in the Scenarios submenu. */
export async function handlePhotoCreateEnter(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.clearMediaInputs(ctx.user.id, PHOTO_CREATE_BUFFER_MODEL_ID);
  await userStateService.setState(ctx.user.id, "PHOTO_CREATE_AWAIT_PHOTO", null);

  const model = AI_MODELS[PHOTO_CREATE_MODEL_ID];
  const costLine = model ? buildCostLine(model, PHOTO_CREATE_EXTRA_SETTINGS, ctx.t) : "";
  const welcome = [
    `<b>${ctx.t.scenarios.photoCreate}</b>`,
    ctx.t.scenarios.photoCreateWelcome,
    ctx.t.scenarios.photoCreateStepPhoto,
    costLine,
  ]
    .filter(Boolean)
    .join("\n\n");
  await ctx.reply(welcome, { parse_mode: "HTML" });
}

/** Handles a photo (compressed or image-document) in PHOTO_CREATE_AWAIT_PHOTO. */
export async function handlePhotoCreatePhoto(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  const mediaGroupId = ctx.message?.media_group_id;
  const mediaGroupKey = mediaGroupId ? `${ctx.user.id}:${mediaGroupId}` : null;
  if (mediaGroupKey && processedMediaGroups.has(mediaGroupKey)) return;

  let fileId: string | undefined;
  let fileSize: number | undefined;
  if (ctx.message?.photo) {
    const largest = ctx.message.photo.at(-1);
    fileId = largest?.file_id;
    fileSize = largest?.file_size;
  } else if (ctx.message?.document && isImageDocument(ctx.message.document)) {
    fileId = ctx.message.document.file_id;
    fileSize = ctx.message.document.file_size;
  }
  if (!fileId) {
    await ctx.reply(ctx.t.scenarios.photoCreateNotPhoto);
    return;
  }
  if (fileSize !== undefined && fileSize > PHOTO_CREATE_IMAGE_MAX_BYTES) {
    await ctx.reply(ctx.t.scenarios.photoCreatePhotoTooLarge);
    return;
  }

  const userId = ctx.user.id;
  // Album dedup регистрируем ДО upload'а — иначе на decode-failure первого фото
  // юзер получит N одинаковых сообщений по числу siblings.
  if (mediaGroupKey) rememberMediaGroup(mediaGroupKey);
  const file = await ctx.api.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
  const s3Key = `photo_create/${userId.toString()}/${Date.now()}.jpg`;
  let normalized;
  try {
    normalized = await s3Service.uploadNormalizedImage(s3Key, tgUrl);
  } catch (err) {
    if (err instanceof ImageDecodeError) {
      await ctx.reply(ctx.t.scenarios.imageDecodeFailed);
    } else {
      logger.error(err, "Photo create: upload normalize failed");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.photoCreate, "design"));
    }
    return;
  }

  await userStateService.addMediaInput(
    userId,
    PHOTO_CREATE_BUFFER_MODEL_ID,
    PHOTO_CREATE_SRC_SLOT,
    normalized.key,
    true,
  );
  await userStateService.addMediaInput(
    userId,
    PHOTO_CREATE_BUFFER_MODEL_ID,
    PHOTO_CREATE_W_SLOT,
    String(normalized.width),
    true,
  );
  await userStateService.addMediaInput(
    userId,
    PHOTO_CREATE_BUFFER_MODEL_ID,
    PHOTO_CREATE_H_SLOT,
    String(normalized.height),
    true,
  );
  if (mediaGroupKey) {
    await ctx.reply(ctx.t.scenarios.photoCreateAlbumNotice);
  }

  await userStateService.setState(userId, "PHOTO_CREATE_AWAIT_PROMPT", null);
  await ctx.reply(ctx.t.scenarios.photoCreateStepPrompt, { parse_mode: "HTML" });
}

/** Handles user text describing target photo (state PHOTO_CREATE_AWAIT_PROMPT). */
export async function handlePhotoCreatePrompt(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  const userText = ctx.message?.text?.trim() ?? "";
  if (!userText) {
    await ctx.reply(ctx.t.scenarios.photoCreatePromptEmpty);
    return;
  }
  if (userText.length > PHOTO_CREATE_PROMPT_MAX_CHARS) {
    await ctx.reply(
      ctx.t.scenarios.photoCreatePromptTooLong
        .replace("{current}", String(userText.length))
        .replace("{max}", String(PHOTO_CREATE_PROMPT_MAX_CHARS)),
    );
    return;
  }

  const userId = ctx.user.id;
  const slots = await userStateService.getMediaInputs(userId, PHOTO_CREATE_BUFFER_MODEL_ID);
  const srcKey = slots[PHOTO_CREATE_SRC_SLOT]?.[0];
  if (!srcKey) {
    await userStateService.setState(userId, "PHOTO_CREATE_AWAIT_PHOTO", null);
    await ctx.reply(
      `${ctx.t.scenarios.photoCreateBufferLost}\n\n${ctx.t.scenarios.photoCreateStepPhoto}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // Если промпт уже был в буфере — это перезапись на шаге AWAIT_AR (юзер
  // прислал новый текст вместо тапа по кнопке). Отдаём отдельную строку-
  // подтверждение, чтобы юзер видел что промпт принят, а не повтор «Шаг 2 из 3».
  const isUpdate = !!slots[PHOTO_CREATE_PROMPT_SLOT]?.[0];
  await userStateService.addMediaInput(
    userId,
    PHOTO_CREATE_BUFFER_MODEL_ID,
    PHOTO_CREATE_PROMPT_SLOT,
    userText,
    true,
  );

  await userStateService.setState(userId, "PHOTO_CREATE_AWAIT_AR", null);
  await ctx.reply(
    isUpdate ? ctx.t.scenarios.photoCreatePromptUpdated : ctx.t.scenarios.photoCreateStepAr,
    {
      parse_mode: "HTML",
      reply_markup: buildArKeyboard(),
    },
  );
}

/**
 * Handles `photo_create:ar:<value>` callback. Резолвит AR ("auto" → snap из
 * w/h исходника), складывает результат в буфер и показывает клавиатуру выбора
 * resolution. Сабмит — в `handlePhotoCreateResSelect`.
 */
export async function handlePhotoCreateArSelect(ctx: BotContext): Promise<void> {
  if (!ctx.user || !ctx.callbackQuery?.data) return;
  const parts = ctx.callbackQuery.data.split(":");
  const value = parts.slice(2).join(":");
  if (parts[0] !== "photo_create" || parts[1] !== "ar" || !value) {
    await ctx.answerCallbackQuery();
    return;
  }
  const option = PHOTO_CREATE_AR_OPTIONS.find((o) => o.value === value);
  if (!option) {
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.answerCallbackQuery();
  // Гасим клавиатуру выбора, чтобы юзер не отправил тот же AR ещё раз.
  await ctx.editMessageReplyMarkup().catch(() => void 0);

  const userId = ctx.user.id;
  const slots = await userStateService.getMediaInputs(userId, PHOTO_CREATE_BUFFER_MODEL_ID);
  const srcKey = slots[PHOTO_CREATE_SRC_SLOT]?.[0];
  const userText = slots[PHOTO_CREATE_PROMPT_SLOT]?.[0];
  if (!srcKey || !userText) {
    await userStateService.clearMediaInputs(userId, PHOTO_CREATE_BUFFER_MODEL_ID);
    await userStateService.setState(userId, "PHOTO_CREATE_AWAIT_PHOTO", null);
    await ctx.reply(
      `${ctx.t.scenarios.photoCreateBufferLost}\n\n${ctx.t.scenarios.photoCreateStepPhoto}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const aspectRatio =
    option.value === "auto"
      ? snapPhotoCreateAr(
          Number(slots[PHOTO_CREATE_W_SLOT]?.[0]) || 0,
          Number(slots[PHOTO_CREATE_H_SLOT]?.[0]) || 0,
        )
      : option.value;

  await userStateService.addMediaInput(
    userId,
    PHOTO_CREATE_BUFFER_MODEL_ID,
    PHOTO_CREATE_AR_SLOT,
    aspectRatio,
    true,
  );
  await userStateService.setState(userId, "PHOTO_CREATE_AWAIT_RES", null);
  await ctx.reply(ctx.t.scenarios.photoCreateStepRes, {
    parse_mode: "HTML",
    reply_markup: buildResKeyboard(),
  });
}

/**
 * Handles `photo_create:res:<value>` callback. Достаёт фото+промпт+AR из
 * буфера, переводит промпт (silent), сабмитит nano-banana-pro с выбранными
 * aspect_ratio + resolution.
 */
export async function handlePhotoCreateResSelect(ctx: BotContext): Promise<void> {
  if (!ctx.user || !ctx.callbackQuery?.data) return;
  const parts = ctx.callbackQuery.data.split(":");
  const value = parts.slice(2).join(":");
  if (parts[0] !== "photo_create" || parts[1] !== "res" || !value) {
    await ctx.answerCallbackQuery();
    return;
  }
  const option = PHOTO_CREATE_RES_OPTIONS.find((o) => o.value === value);
  if (!option) {
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.answerCallbackQuery();
  // Гасим клавиатуру выбора, чтобы юзер не запустил повторный сабмит.
  await ctx.editMessageReplyMarkup().catch(() => void 0);

  const userId = ctx.user.id;
  const slots = await userStateService.getMediaInputs(userId, PHOTO_CREATE_BUFFER_MODEL_ID);
  const srcKey = slots[PHOTO_CREATE_SRC_SLOT]?.[0];
  const userText = slots[PHOTO_CREATE_PROMPT_SLOT]?.[0];
  const aspectRatio = slots[PHOTO_CREATE_AR_SLOT]?.[0];
  if (!srcKey || !userText || !aspectRatio) {
    await userStateService.clearMediaInputs(userId, PHOTO_CREATE_BUFFER_MODEL_ID);
    await userStateService.setState(userId, "PHOTO_CREATE_AWAIT_PHOTO", null);
    await ctx.reply(
      `${ctx.t.scenarios.photoCreateBufferLost}\n\n${ctx.t.scenarios.photoCreateStepPhoto}`,
      { parse_mode: "HTML" },
    );
    return;
  }
  const resolution = option.value;

  const telegramId = ctx.user.telegramId;
  const chatId = ctx.chat?.id ?? (telegramId ? Number(telegramId) : undefined);
  if (chatId === undefined) return;

  let translatedPrompt: string;
  try {
    translatedPrompt = await translatePromptIfNeeded(
      userText,
      { auto_translate_prompt: true },
      userId,
      PHOTO_CREATE_MODEL_ID,
      // Silent — юзер не должен видеть отдельную строку «autotranslate». Цена
      // мизерная, поглощается сценарием.
      { silent: true },
    );
  } catch (err) {
    logger.warn({ err }, "Photo create: prompt translation failed, falling back to original");
    translatedPrompt = userText;
  }

  let resolved: Record<string, string[]>;
  try {
    resolved = await resolveMediaInputUrls(
      { edit: [srcKey] },
      { userId, modelId: PHOTO_CREATE_BUFFER_MODEL_ID },
    );
  } catch (err) {
    if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Photo create: failed to resolve media URL");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.photoCreate, "design"));
    }
    await userStateService.clearMediaInputs(userId, PHOTO_CREATE_BUFFER_MODEL_ID);
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
    return;
  }

  await ctx.reply(ctx.t.scenarios.photoCreateGenerating);

  let submitOk = false;
  try {
    await generationService.submitImage({
      userId,
      modelId: PHOTO_CREATE_MODEL_ID,
      prompt: translatedPrompt,
      mediaInputs: resolved,
      extraModelSettings: {
        ...PHOTO_CREATE_EXTRA_SETTINGS,
        aspect_ratio: aspectRatio,
        resolution,
      },
      telegramChatId: chatId,
      sendOriginalLabel: ctx.t.common.sendOriginal,
      // Маскируем модель: подпись «📸 Создать фотографию», без refine
      // (юзер не выбирал модель явно — это пресет-сценарий).
      displayNameOverride: ctx.t.scenarios.photoCreate,
      hidePromptInCaption: true,
      hideRefineButton: true,
    });
    submitOk = true;
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "NO_SUBSCRIPTION") {
      await replyNoSubscription(ctx);
    } else if (err instanceof Error && err.message === "INSUFFICIENT_TOKENS") {
      await replyInsufficientTokens(ctx);
    } else if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Photo create submit failed");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.photoCreate, "design"));
    }
  }

  // На успехе оставляем юзера в AWAIT_PHOTO — следующий присланный кадр стартует
  // новый flow. На ошибке возвращаемся в Сценарии.
  await userStateService.clearMediaInputs(userId, PHOTO_CREATE_BUFFER_MODEL_ID);
  await userStateService.setState(
    userId,
    submitOk ? "PHOTO_CREATE_AWAIT_PHOTO" : "SCENARIOS_SECTION",
    null,
  );
}
