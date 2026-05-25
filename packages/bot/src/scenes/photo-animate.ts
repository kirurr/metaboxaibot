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
  PHOTO_ANIMATE_DURATION_SEC,
  PHOTO_ANIMATE_RESOLUTION,
} from "@metabox/shared";
import { logger } from "../logger.js";
import { buildCostLine } from "../utils/cost-line.js";
import { isImageDocument } from "./upscale.js";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";

/**
 * Сценарий «🎞️ Оживить фото». Под капотом — KIE Grok Imagine r2v
 * (alias `photo-animate` в каталоге). Юзер ничего не настраивает: грузит фото —
 * сразу запускается генерация. Сцена:
 *  - детектит aspect ratio исходника по dimensions из uploadNormalizedImage,
 *    снапит к ближайшему из supported set (Grok r2v: 1:1, 2:3, 3:2, 16:9, 9:16);
 *  - форсит resolution 720p и duration 6s через extraModelSettings;
 *  - шлёт фикс-промпт (English, без перевода — Grok тренировался на en).
 * Grok нигде не светится: модель `photo-animate` помечена hiddenFromCarousel и
 * у неё своё имя «🎞️ Оживить фото» — оно же идёт в caption результата.
 */

const PHOTO_ANIMATE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

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

/**
 * Принимает фото (compressed или image-document) в PHOTO_ANIMATE_AWAIT_PHOTO,
 * нормализует через s3, детектит aspect ratio и сразу же сабмитит генерацию —
 * без промежуточной кнопки подтверждения (одинаковый флоу с object-removal/
 * bg-removal/photo-upscale: загрузка = намерение).
 */
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
  } else if (ctx.message?.document && isImageDocument(ctx.message.document)) {
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

  if (mediaGroupKey) {
    rememberMediaGroup(mediaGroupKey);
    await ctx.reply(ctx.t.scenarios.photoAnimateAlbumNotice);
  }

  const aspectRatio = snapAspectRatio(normalized.width, normalized.height);

  const telegramId = ctx.user.telegramId;
  const chatId = ctx.chat?.id ?? (telegramId ? Number(telegramId) : undefined);
  if (chatId === undefined) return;

  let resolved: Record<string, string[]>;
  try {
    resolved = await resolveMediaInputUrls({ ref_images: [normalized.key] });
  } catch (err) {
    if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Photo animate: failed to resolve media URL");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.photoAnimate, "video"));
    }
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
    return;
  }

  await ctx.reply(ctx.t.scenarios.photoAnimateGenerating);

  let submitOk = false;
  try {
    await videoGenerationService.submitVideo({
      userId,
      modelId: PHOTO_ANIMATE_MODEL_ID,
      // prompt пустой по дизайну: реальный фикс-промпт инжектится в адаптере
      // (kie.adapter / fal.adapter) при modelId === "photo-animate". Так
      // англоязычная instruction не попадает в БД, web/webapp gallery, TG
      // caption и историю транзакций — нигде не светится.
      prompt: "",
      mediaInputs: resolved,
      aspectRatio,
      duration: PHOTO_ANIMATE_DURATION_SEC,
      extraModelSettings: {
        resolution: PHOTO_ANIMATE_RESOLUTION,
        aspect_ratio: aspectRatio,
      },
      telegramChatId: chatId,
      sendOriginalLabel: ctx.t.common.sendOriginal,
      // Defense-in-depth: даже при empty prompt, флаг гарантирует что worker
      // не покажет blockquote — на случай если кто-то перепутает payloads.
      hidePromptInCaption: true,
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

  // На успехе оставляем юзера в AWAIT_PHOTO — следующий присланный кадр
  // стартует новый flow. На ошибке возвращаемся в Сценарии.
  await userStateService.setState(
    userId,
    submitOk ? "PHOTO_ANIMATE_AWAIT_PHOTO" : "SCENARIOS_SECTION",
    null,
  );
}
