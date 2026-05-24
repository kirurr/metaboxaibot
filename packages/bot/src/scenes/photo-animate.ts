import { InlineKeyboard } from "grammy";
import type { BotContext } from "../types/context.js";
import { videoGenerationService, userStateService, s3Service } from "@metabox/api/services";
import { resolveMediaInputUrls } from "../utils/media-input-state.js";
import {
  AI_MODELS,
  config,
  UserFacingError,
  resolveUserFacingErrorVariant,
  pickGenerationFailedMessage,
  PHOTO_ANIMATE_MODEL_ID,
  PHOTO_ANIMATE_BUFFER_MODEL_ID,
  PHOTO_ANIMATE_DURATION_SEC,
  PHOTO_ANIMATE_RESOLUTION,
  PHOTO_ANIMATE_PROMPT,
  PHOTO_ANIMATE_SUPPORTED_ASPECT_RATIOS,
} from "@metabox/shared";
import { logger } from "../logger.js";
import { buildCostLine } from "../utils/cost-line.js";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";

/**
 * Сценарий «🎞️ Оживить фото». Под капотом — KIE Grok Imagine r2v
 * (alias `photo-animate` в каталоге). Юзер ничего не настраивает: грузит фото,
 * подтверждает кнопкой. Сцена:
 *  - детектит aspect ratio исходника по dimensions из uploadNormalizedImage,
 *    снапит к ближайшему из supported set (Grok r2v: 1:1, 2:3, 3:2, 16:9, 9:16);
 *  - форсит resolution 720p и duration 6s через extraModelSettings;
 *  - шлёт фикс-промпт (English, без перевода — Grok тренировался на en).
 * Grok нигде не светится: модель `photo-animate` помечена hiddenFromCarousel и
 * у неё своё имя «🎞️ Оживить фото» — оно же идёт в caption результата.
 */

const PHOTO_ANIMATE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** Слот буфера с S3-key загруженного фото. */
const PHOTO_ANIMATE_SRC_SLOT = "ref_images";
/** Side-channel slot где между шагом загрузки и confirm-callback'ом лежит
 * детектированный aspect_ratio (строка вида "16:9"). Buffer-slot подходит:
 * чистится тем же `clearMediaInputs` что и фото. */
const PHOTO_ANIMATE_AR_SLOT = "aspect_ratio";

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

/**
 * Маппит реальный AR исходника (W/H) к ближайшему из списка supported
 * соотношений Grok Imagine r2v. Сравниваем по относительной разнице (|src-tgt|
 * /tgt) — это правильнее abs-разницы: 9:16 vs 16:9 на одинаковом «расстоянии»
 * 1, но 1:1 (=1.0) и 9:16 (≈0.56) такую же по abs-разнице дают ≈0.44 — а
 * относительная даёт 0.44/0.56 = 0.78, что честнее отражает «насколько далеко».
 */
const SUPPORTED_AR_RATIOS: ReadonlyArray<[string, number]> = [
  ["1:1", 1],
  ["2:3", 2 / 3],
  ["3:2", 3 / 2],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
];

function snapAspectRatio(width: number, height: number): string {
  if (!width || !height) return "1:1";
  const src = width / height;
  let best = SUPPORTED_AR_RATIOS[0][0];
  let bestDiff = Infinity;
  for (const [label, target] of SUPPORTED_AR_RATIOS) {
    const diff = Math.abs(src - target) / target;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = label;
    }
  }
  return best;
}

/** Entry — user tapped «🎞️ Оживить фото» in the Scenarios submenu. */
export async function handlePhotoAnimateEnter(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.clearMediaInputs(ctx.user.id, PHOTO_ANIMATE_BUFFER_MODEL_ID);
  await userStateService.setState(ctx.user.id, "PHOTO_ANIMATE_AWAIT_PHOTO", null);

  const model = AI_MODELS[PHOTO_ANIMATE_MODEL_ID];
  const costLine = model
    ? buildCostLine(
        model,
        { resolution: PHOTO_ANIMATE_RESOLUTION, duration: PHOTO_ANIMATE_DURATION_SEC },
        ctx.t,
      )
    : "";
  const welcome = [
    `<b>${ctx.t.scenarios.photoAnimate}</b>`,
    ctx.t.scenarios.photoAnimateWelcome,
    ctx.t.scenarios.photoAnimateStepPhoto,
    costLine,
  ]
    .filter(Boolean)
    .join("\n\n");
  await ctx.reply(welcome, { parse_mode: "HTML" });
}

/** Handles a photo (compressed or image-document) in PHOTO_ANIMATE_AWAIT_PHOTO. */
export async function handlePhotoAnimatePhoto(ctx: BotContext): Promise<void> {
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
  } else if (ctx.message?.document?.mime_type?.startsWith("image/")) {
    fileId = ctx.message.document.file_id;
    fileSize = ctx.message.document.file_size;
  }
  if (!fileId) {
    await ctx.reply(ctx.t.scenarios.photoAnimateNotPhoto);
    return;
  }
  if (fileSize !== undefined && fileSize > PHOTO_ANIMATE_IMAGE_MAX_BYTES) {
    await ctx.reply(ctx.t.scenarios.photoAnimatePhotoTooLarge);
    return;
  }

  const userId = ctx.user.id;
  const file = await ctx.api.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
  const s3Key = `photo_animate/${userId.toString()}/${Date.now()}.jpg`;
  const normalized = await s3Service.uploadNormalizedImage(s3Key, tgUrl).catch(() => null);
  if (!normalized) {
    await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.photoAnimate, "video"));
    return;
  }

  const aspectRatio = snapAspectRatio(normalized.width, normalized.height);

  await userStateService.addMediaInput(
    userId,
    PHOTO_ANIMATE_BUFFER_MODEL_ID,
    PHOTO_ANIMATE_SRC_SLOT,
    normalized.key,
    true,
  );
  await userStateService.addMediaInput(
    userId,
    PHOTO_ANIMATE_BUFFER_MODEL_ID,
    PHOTO_ANIMATE_AR_SLOT,
    aspectRatio,
    true,
  );
  if (mediaGroupKey) {
    rememberMediaGroup(mediaGroupKey);
    await ctx.reply(ctx.t.scenarios.photoAnimateAlbumNotice);
  }

  await userStateService.setState(userId, "PHOTO_ANIMATE_AWAIT_CONFIRM", null);

  const model = AI_MODELS[PHOTO_ANIMATE_MODEL_ID];
  const costLine = model
    ? buildCostLine(
        model,
        { resolution: PHOTO_ANIMATE_RESOLUTION, duration: PHOTO_ANIMATE_DURATION_SEC },
        ctx.t,
      )
    : "";
  const text = costLine
    ? `${ctx.t.scenarios.photoAnimateReady}\n\n${costLine}`
    : ctx.t.scenarios.photoAnimateReady;
  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text(ctx.t.scenarios.photoAnimateStartButton, "photo_animate:go")
      .row()
      .text(ctx.t.scenarios.photoAnimateCancelButton, "photo_animate:cancel"),
  });
}

/** Handles inline `photo_animate:go|cancel` callback. */
export async function handlePhotoAnimateCallback(ctx: BotContext): Promise<void> {
  if (!ctx.user || !ctx.callbackQuery?.data) return;
  const action = ctx.callbackQuery.data.split(":")[1];
  await ctx.answerCallbackQuery();
  // Гасим клавиатуру, чтобы юзер не нажал кнопку второй раз пока submit идёт.
  await ctx.editMessageReplyMarkup().catch(() => void 0);

  const userId = ctx.user.id;

  if (action === "cancel") {
    await userStateService.clearMediaInputs(userId, PHOTO_ANIMATE_BUFFER_MODEL_ID);
    await userStateService.setState(userId, "PHOTO_ANIMATE_AWAIT_PHOTO", null);
    await ctx.reply(ctx.t.scenarios.photoAnimateCancelled);
    return;
  }
  if (action !== "go") return;

  const slots = await userStateService.getMediaInputs(userId, PHOTO_ANIMATE_BUFFER_MODEL_ID);
  const srcKey = slots[PHOTO_ANIMATE_SRC_SLOT]?.[0];
  const storedAr = slots[PHOTO_ANIMATE_AR_SLOT]?.[0];
  if (!srcKey) {
    // Буфер потерян (выход в меню / сервис рестартанул) — просим прислать фото
    // заново.
    await userStateService.setState(userId, "PHOTO_ANIMATE_AWAIT_PHOTO", null);
    await ctx.reply(
      `${ctx.t.scenarios.photoAnimateBufferLost}\n\n${ctx.t.scenarios.photoAnimateStepPhoto}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const telegramId = ctx.user.telegramId;
  const chatId = ctx.chat?.id ?? (telegramId ? Number(telegramId) : undefined);
  if (chatId === undefined) return;

  let resolved: Record<string, string[]>;
  try {
    resolved = await resolveMediaInputUrls(
      { [PHOTO_ANIMATE_SRC_SLOT]: [srcKey] },
      { userId, modelId: PHOTO_ANIMATE_BUFFER_MODEL_ID },
    );
  } catch (err) {
    if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Photo animate: failed to resolve media URL");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.photoAnimate, "video"));
    }
    await userStateService.clearMediaInputs(userId, PHOTO_ANIMATE_BUFFER_MODEL_ID);
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
    return;
  }

  // AR из буфера сохранён в момент upload'а (до возможного S3-fetch'а в
  // resolveMediaInputUrls) — поэтому даже если presigned-URL переподписался
  // под другим именем, AR актуален и снапнут корректно. Defensive fallback
  // на 1:1 — лучше квадрат чем ошибка в адаптере.
  const aspectRatio =
    storedAr && PHOTO_ANIMATE_SUPPORTED_ASPECT_RATIOS.includes(storedAr) ? storedAr : "1:1";

  await ctx.reply(ctx.t.scenarios.photoAnimateGenerating);

  let submitOk = false;
  try {
    await videoGenerationService.submitVideo({
      userId,
      modelId: PHOTO_ANIMATE_MODEL_ID,
      prompt: PHOTO_ANIMATE_PROMPT,
      mediaInputs: resolved,
      aspectRatio,
      duration: PHOTO_ANIMATE_DURATION_SEC,
      extraModelSettings: {
        resolution: PHOTO_ANIMATE_RESOLUTION,
        duration: PHOTO_ANIMATE_DURATION_SEC,
        aspect_ratio: aspectRatio,
      },
      telegramChatId: chatId,
      sendOriginalLabel: ctx.t.common.sendOriginal,
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
      logger.error(err, "Photo animate submit failed");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.photoAnimate, "video"));
    }
  }

  // На успехе чистим буфер и оставляем юзера в ожидании НОВОГО фото —
  // следующий присланный кадр стартует новый flow. На ошибке возвращаемся
  // в Сценарии.
  await userStateService.clearMediaInputs(userId, PHOTO_ANIMATE_BUFFER_MODEL_ID);
  await userStateService.setState(
    userId,
    submitOk ? "PHOTO_ANIMATE_AWAIT_PHOTO" : "SCENARIOS_SECTION",
    null,
  );
}
