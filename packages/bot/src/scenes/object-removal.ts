import type { BotContext } from "../types/context.js";
import {
  generationService,
  userStateService,
  s3Service,
  translatePromptIfNeeded,
} from "@metabox/api/services";
import {
  AI_MODELS,
  config,
  UserFacingError,
  resolveUserFacingErrorVariant,
  pickGenerationFailedMessage,
  OBJECT_REMOVAL_MODEL_ID,
  OBJECT_REMOVAL_BUFFER_MODEL_ID,
  OBJECT_REMOVAL_PROMPT_MAX_CHARS,
} from "@metabox/shared";
import { logger } from "../logger.js";
import { buildCostLine } from "../utils/cost-line.js";
import { resolveMediaInputUrls } from "../utils/media-input-state.js";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";
import { isImageDocument } from "./upscale.js";

/**
 * Сценарий «Убрать объект с фото». Под капотом — KIE `gpt-image-2-image-to-image`
 * @ 2K. Два шага: 1) фото, 2) одна фраза «что убрать». Юзерский ввод оборачивается
 * в фикс-шаблон и переводится на английский через `translatePromptIfNeeded`
 * (auto_translate_prompt: true). gpt-image-2 нигде не светится — юзер видит
 * только «🪄 Убрать объект».
 */

/**
 * Telegram-лимит на `getFile` — 20 МБ. Превалидация даёт понятный отказ юзеру
 * до начала аплоада в S3 / KIE. Реальный потолок gpt-image-2-i2i эмпирически
 * не замеряли (KIE его не публикует) — оставляем планку на уровне TG, дальше
 * KIE/OpenAI отбьют сами с generic-ошибкой.
 */
const OBJECT_REMOVAL_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** Слот буфера, в котором между шагами лежит S3-key загруженного фото. */
const OBJECT_REMOVAL_SLOT = "src";

/**
 * Фикс-настройки для gpt-image-2 i2i.
 *
 * `resolution:"1K"` + `aspect_ratio:"auto"` — единственная комбинация у KIE,
 * при которой формат выхода в точности совпадает с форматом входа (для 2K/4K
 * нужен явный aspect_ratio из enum {1:1, 9:16, 16:9, 4:3, 3:4} — любой не
 * совпавший с реальным даёт crop или distortion). Сохранение пропорций
 * приоритетнее, чем 2K — поэтому 1K.
 */
const OBJECT_REMOVAL_SETTINGS: Record<string, string | boolean> = {
  resolution: "1K",
  aspect_ratio: "auto",
};

/**
 * Шаблон, в который оборачивается юзерский ввод (после автоперевода на английский).
 * Подсказывает gpt-image-2 что нужно именно убрать объект и аккуратно дорисовать
 * фон, а не перерисовать всё фото.
 */
function buildPromptTemplate(userText: string): string {
  return `Remove the following from the image: ${userText}. Keep everything else exactly as it was — same composition, same subjects, same colors, same lighting. Inpaint the background where the removed object was, photorealistic and seamless.`;
}

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

/** Entry — user tapped «🪄 Убрать объект» in the Scenarios submenu. */
export async function handleObjectRemovalEnter(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.clearMediaInputs(ctx.user.id, OBJECT_REMOVAL_BUFFER_MODEL_ID);
  await userStateService.setState(ctx.user.id, "OBJECT_REMOVAL_AWAIT_PHOTO", null);

  const model = AI_MODELS[OBJECT_REMOVAL_MODEL_ID];
  const costLine = model ? buildCostLine(model, OBJECT_REMOVAL_SETTINGS, ctx.t) : "";
  const welcome = [
    `<b>${ctx.t.scenarios.objectRemoval}</b>`,
    ctx.t.scenarios.objectRemovalWelcome,
    ctx.t.scenarios.objectRemovalStepPhoto,
    costLine,
  ]
    .filter(Boolean)
    .join("\n\n");
  await ctx.reply(welcome, { parse_mode: "HTML" });
}

/** Handles a photo (compressed or image-document) in OBJECT_REMOVAL_AWAIT_PHOTO. */
export async function handleObjectRemovalPhoto(ctx: BotContext): Promise<void> {
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
    await ctx.reply(ctx.t.scenarios.objectRemovalNotPhoto);
    return;
  }
  if (fileSize !== undefined && fileSize > OBJECT_REMOVAL_IMAGE_MAX_BYTES) {
    await ctx.reply(ctx.t.scenarios.objectRemovalPhotoTooLarge);
    return;
  }

  const userId = ctx.user.id;
  const file = await ctx.api.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
  // Перекодируем вход в JPEG (uploadNormalizedImage заодно грузит в S3) —
  // провайдеры отбивают HEIC / CMYK / 16-bit и т.п.
  const s3Key = `object_removal/${userId.toString()}/${Date.now()}.jpg`;
  const normalized = await s3Service.uploadNormalizedImage(s3Key, tgUrl).catch(() => null);
  if (!normalized) {
    await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.objectRemoval, "design"));
    return;
  }

  await userStateService.addMediaInput(
    userId,
    OBJECT_REMOVAL_BUFFER_MODEL_ID,
    OBJECT_REMOVAL_SLOT,
    normalized.key,
    true,
  );
  if (mediaGroupKey) {
    rememberMediaGroup(mediaGroupKey);
    await ctx.reply(ctx.t.scenarios.objectRemovalAlbumNotice);
  }

  await userStateService.setState(userId, "OBJECT_REMOVAL_AWAIT_PROMPT", null);
  await ctx.reply(ctx.t.scenarios.objectRemovalStepPrompt, { parse_mode: "HTML" });
}

/** Handles user text describing what to remove (state OBJECT_REMOVAL_AWAIT_PROMPT). */
export async function handleObjectRemovalPrompt(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  const userText = ctx.message?.text?.trim() ?? "";
  if (!userText) {
    await ctx.reply(ctx.t.scenarios.objectRemovalPromptEmpty);
    return;
  }
  if (userText.length > OBJECT_REMOVAL_PROMPT_MAX_CHARS) {
    await ctx.reply(
      ctx.t.scenarios.objectRemovalPromptTooLong
        .replace("{current}", String(userText.length))
        .replace("{max}", String(OBJECT_REMOVAL_PROMPT_MAX_CHARS)),
    );
    return;
  }

  const userId = ctx.user.id;
  const slots = await userStateService.getMediaInputs(userId, OBJECT_REMOVAL_BUFFER_MODEL_ID);
  const srcKey = slots[OBJECT_REMOVAL_SLOT]?.[0];
  if (!srcKey) {
    // Буфер потерян (выход в меню / сервис рестартанул) — просим прислать фото
    // заново, с явным контекстом «фото не найдено», чтобы юзер не подумал что
    // его текст игнорируется.
    await userStateService.setState(userId, "OBJECT_REMOVAL_AWAIT_PHOTO", null);
    await ctx.reply(
      `${ctx.t.scenarios.objectRemovalBufferLost}\n\n${ctx.t.scenarios.objectRemovalStepPhoto}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const telegramId = ctx.user.telegramId;
  const chatId = ctx.chat?.id ?? (telegramId ? Number(telegramId) : undefined);
  if (chatId === undefined) return;

  // 1) Переводим юзерский ввод на английский если нужно (looksEnglish внутри
  //    скипает no-op). 2) Оборачиваем в шаблон «Remove the following…».
  //    Порядок важен: переводим только ВВОД юзера, не шаблон — шаблон уже на
  //    английском и при перегоне через LLM терял бы точность инструкции.
  let translatedUserText: string;
  try {
    translatedUserText = await translatePromptIfNeeded(
      userText,
      { auto_translate_prompt: true },
      userId,
      OBJECT_REMOVAL_MODEL_ID,
      // Перевод — внутренняя кухня сценария, юзер не должен видеть отдельную
      // строку «autotranslate» в истории и не платит за это отдельно. Цена
      // мизерная (gpt-5-nano на 400-char-промпт ≈ $0.0001) — поглощается
      // сценарием, в base price object-removal ($0.03) уже c запасом покрыта.
      { silent: true },
    );
  } catch (err) {
    logger.warn({ err }, "Object removal: prompt translation failed, falling back to original");
    translatedUserText = userText;
  }
  const finalPrompt = buildPromptTemplate(translatedUserText);

  let resolved: Record<string, string[]>;
  try {
    resolved = await resolveMediaInputUrls(
      { edit: [srcKey] },
      { userId, modelId: OBJECT_REMOVAL_BUFFER_MODEL_ID },
    );
  } catch (err) {
    if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Object removal: failed to resolve media URL");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.objectRemoval, "design"));
    }
    await userStateService.clearMediaInputs(userId, OBJECT_REMOVAL_BUFFER_MODEL_ID);
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
    return;
  }

  await ctx.reply(ctx.t.scenarios.objectRemovalGenerating);

  let submitOk = false;
  try {
    await generationService.submitImage({
      userId,
      modelId: OBJECT_REMOVAL_MODEL_ID,
      prompt: finalPrompt,
      mediaInputs: resolved,
      extraModelSettings: OBJECT_REMOVAL_SETTINGS,
      telegramChatId: chatId,
      sendOriginalLabel: ctx.t.common.sendOriginal,
      promptMessageId: ctx.message?.message_id,
      // Сценарий маскирует реальную модель: в подписи «🪄 Убрать объект»,
      // без кнопки «Доработать» (юзер не выбирал модель).
      displayNameOverride: ctx.t.scenarios.objectRemoval,
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
      logger.error(err, "Object removal submit failed");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.objectRemoval, "design"));
    }
  }

  // На успехе чистим буфер и оставляем юзера в ожидании НОВОГО фото — следующий
  // присланный кадр стартует новый flow. На ошибке возвращаемся в Сценарии.
  await userStateService.clearMediaInputs(userId, OBJECT_REMOVAL_BUFFER_MODEL_ID);
  await userStateService.setState(
    userId,
    submitOk ? "OBJECT_REMOVAL_AWAIT_PHOTO" : "SCENARIOS_SECTION",
    null,
  );
}
