import type { BotContext } from "../types/context.js";
import { generationService, userStateService, s3Service } from "@metabox/api/services";
import { AI_MODELS, config } from "@metabox/shared";
import { logger } from "../logger.js";
import { buildCostLine } from "../utils/cost-line.js";
import { resolveMediaInputUrls } from "../utils/media-input-state.js";
import { replyNoSubscription, replyInsufficientTokens } from "../utils/reply-error.js";
import {
  UserFacingError,
  resolveUserFacingErrorVariant,
  pickGenerationFailedMessage,
  FACE_SWAP_BUFFER_MODEL_ID,
} from "@metabox/shared";

const FACE_SWAP_MODEL_ID = "nano-banana-pro";
const FACE_SWAP_SLOT_REFERENCE = "reference";
const FACE_SWAP_SLOT_FACE = "face";

/** Telegram Bot API hard cap on `getFile` downloads. */
const TG_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * In-memory dedup of Telegram media groups (albums). Each photo in an album
 * arrives as a separate update sharing `media_group_id`. We only consume the
 * first photo per group; siblings are silently ignored so the user doesn't
 * burn through reference/face slots from a single album upload.
 */
const processedMediaGroups = new Set<string>();

/**
 * Hardcoded prompt for face swap. IMAGE_1 = reference photo (scene / pose /
 * lighting), IMAGE_2 = user's face (identity only). The slot order matters:
 * `mediaInputs.edit[0]` is the reference, `edit[1]` is the face — see the
 * submit call below. Kept in English to match other hardcoded provider prompts.
 */
const FACE_SWAP_PROMPT = `TASK: Surgical face swap. Replace ONLY the facial features of the person in IMAGE_1 (scene) with the face identity from IMAGE_2 (reference). This is NOT a re-imagining — 95% of the output must be pixel-identical to IMAGE_1.

KEEP 100% IDENTICAL FROM IMAGE_1:
- Background, environment, color grading, image grain, noise level
- Head size, head shape, skull proportions, head position, head angle
- Neck, shoulders, body, arms, hands, fingers, torso
- All clothing, towels, fabric, exactly as shown
- All headwear and accessories: hats, caps, hoods, glasses, sunglasses, earrings, headphones, headbands, jewelry, watches — including any text, logos, colors, and positioning
- All objects held by or near the person: cups, phones, cigarettes, pens, microphones, food
- Hair visible OUTSIDE any headwear
- Skin condition on body and neck: sweat, wet skin, redness, tan lines, texture
- Camera angle, framing, depth of field, focal length, photographic style

LIGHTING & SHADOWS — MUST MATCH IMAGE_1 EXACTLY:
- Main light source: identify its direction, angle, distance, and color temperature in IMAGE_1, then apply IDENTICALLY to the new face
- Light intensity and contrast: hard light (sharp shadows) or soft light (diffused) — match precisely
- Shadow placement on the face: under the nose, under the chin, on the neck, in the eye sockets, beside the nose, under the lower lip — recreate every shadow exactly where it appears in IMAGE_1
- Highlight placement: forehead, nose bridge, cheekbones, chin, upper lip — match the position, size, and intensity of every highlight from IMAGE_1
- Light wrap and rim light: any backlight, side light, or edge glow visible on the head/ears/jaw in IMAGE_1 must be reproduced on the new face
- Ambient color cast: if IMAGE_1 has warm/cool/green/magenta tint on the skin from environment (wood walls, neon signs, sunset, etc.) — apply the same cast to the new face
- Skin shading transitions: smooth gradients from lit to shadow areas must follow the same curve as on the body and neck in IMAGE_1
- Shadow color and softness: shadows on the new face must have the same hue, opacity, and edge softness as shadows on the neck and shoulders in IMAGE_1
- Reflected light (fill light): any bounce light from clothing, walls, or surroundings hitting the face in IMAGE_1 must be preserved
- The face must look like it was photographed in the SAME light as the body, not pasted in from another photo

COPY ONLY FROM IMAGE_2 (facial identity):
- Eye shape, eye color, eye spacing, eyelid type
- Nose shape, width, length, tip, nostril shape, bridge profile
- Mouth shape, lip thickness, cupid's bow, natural lip color
- Jawline contour, chin shape, cheekbone structure
- Eyebrow shape, thickness, color
- Ear shape (where visible)
- Base skin tone and undertone of the face (then re-lit to match IMAGE_1's lighting)
- All facial skin details: pores, moles, freckles, acne, blemishes, scars, stubble, wrinkles, fine lines, asymmetry, under-eye area
- Facial hair pattern (beard, mustache, stubble) — if present in IMAGE_2
- Age markers — match the reference person's apparent age

ADOPT FROM IMAGE_1 (pose and expression, NOT identity):
- Facial expression: smile, frown, neutral, open/closed mouth, any visible teeth
- Eye state: open, squinted, gaze direction
- Eyebrow position: raised, neutral, furrowed
- Head tilt, head rotation, head angle

SKIN TONE & LIGHT INTERACTION:
The new face's skin tone comes from IMAGE_2, but it must be RE-LIT under IMAGE_1's lighting conditions. This means:
- If IMAGE_1 has warm light → the new face has the same warm cast
- If IMAGE_1 has cool/dim light → the new face is rendered with the same cool/dim quality
- If IMAGE_1 has high contrast → recreate that contrast on the new face
- The transition from face to neck must be seamless in both color AND lighting — no visible "swap line" at the jaw or hairline

OCCLUSION RULES (Z-ORDER) — CRITICAL:
Any object that appears IN FRONT OF the face in IMAGE_1 — fingers, hands, hair strands, glasses frames, cigarettes, microphones, cup edges, jewelry — MUST remain fully visible and on top of the new face in the output. When adding facial hair from IMAGE_2, render it BEHIND any finger, hand, or object that was originally in front of the chin or jaw. A finger touching the face stays ON TOP of the beard and skin, never buried under it. Preserve the exact depth layering of the original photo.

HEADWEAR PROTECTION:
If IMAGE_1 shows a cap, hat, hood, or any head covering — it stays. Do NOT replace it with hair from IMAGE_2. Only the face area below the headwear line is replaced. Cap text, logos, embroidery, and color must remain pixel-identical to IMAGE_1. Shadow cast by the headwear on the forehead/face in IMAGE_1 must be preserved on the new face.

STRICTLY AVOID:
- Do not change head size, head shape, or skull proportions
- Do not enlarge or narrow the head relative to the neck and shoulders
- Do not re-light the face differently from the body — face and neck must share the same lighting
- Do not flatten or remove shadows on the face
- Do not add new shadows or highlights that don't exist in IMAGE_1
- Do not beautify, smooth, or airbrush the skin
- Do not remove acne, redness, sweat, moles, freckles, or any imperfections
- Do not make the person younger or older than they appear in IMAGE_2
- Do not change skin tone to be lighter or more even than what the lighting dictates
- Do not regenerate the background, scene, or any non-face elements
- Do not remove hats, glasses, accessories, or held objects
- Do not render beard or facial hair over fingers/hands/objects in front of the face
- Do not change clothing, body, or pose
- Do not generate a generic "AI face" — match the reference identity precisely
- Do not produce a "pasted face" look — the face must be fully integrated into the scene's light

OUTPUT: The person from IMAGE_2 naturally placed into the exact scene of IMAGE_1, making the same expression and pose as the original person, photographed under the exact same lighting conditions. Identity from IMAGE_2, scene and light from IMAGE_1. Photorealistic, unedited-looking, indistinguishable from a real photograph — as if the reference person was actually present in the original scene.`;

/** Entry — user tapped «🔄 Замена лица» in the Scenarios submenu. */
export async function handleFaceSwapEnter(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  await userStateService.clearMediaInputs(ctx.user.id, FACE_SWAP_BUFFER_MODEL_ID);
  await userStateService.setState(ctx.user.id, "FACE_SWAP_AWAIT_REFERENCE", null);

  // Welcome — описание сценария + стоимость, как у моделей в Дизайне.
  // Под капотом nano-banana-pro @ 2K, цена считается через стандартный buildCostLine.
  const model = AI_MODELS[FACE_SWAP_MODEL_ID];
  const costLine = model ? buildCostLine(model, { resolution: "2K" }, ctx.t) : "";
  const welcome = [`<b>${ctx.t.scenarios.faceSwap}</b>`, ctx.t.scenarios.faceSwapWelcome, costLine]
    .filter(Boolean)
    .join("\n\n");
  await ctx.reply(welcome, { parse_mode: "HTML" });
  await ctx.reply(ctx.t.scenarios.faceSwapStep1, { parse_mode: "HTML" });
}

/**
 * Handles a photo (compressed or image-document) while the user is in
 * FACE_SWAP_AWAIT_REFERENCE or FACE_SWAP_AWAIT_FACE state.
 */
export async function handleFaceSwapPhoto(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;

  // Drop album siblings — only the first photo of any media group is consumed.
  // The first photo also triggers a one-time notice so the user knows the
  // siblings were skipped (otherwise the album upload feels broken). Note:
  // dedup is committed only AFTER a successful S3 upload (see below) so a
  // failed first photo doesn't blackhole the rest of the album.
  const mediaGroupId = ctx.message?.media_group_id;
  const mediaGroupKey = mediaGroupId ? `${ctx.user.id}:${mediaGroupId}` : null;
  if (mediaGroupKey && processedMediaGroups.has(mediaGroupKey)) return;

  let fileId: string | undefined;
  let fileSize: number | undefined;
  let mimeHint: string | undefined;
  if (ctx.message?.photo) {
    const largest = ctx.message.photo.at(-1);
    fileId = largest?.file_id;
    fileSize = largest?.file_size;
  } else if (ctx.message?.document?.mime_type?.startsWith("image/")) {
    fileId = ctx.message.document.file_id;
    fileSize = ctx.message.document.file_size;
    mimeHint = ctx.message.document.mime_type;
  }
  if (!fileId) {
    await ctx.reply(ctx.t.scenarios.faceSwapNotPhoto);
    return;
  }
  if (fileSize !== undefined && fileSize > TG_DOWNLOAD_LIMIT_BYTES) {
    await ctx.reply(ctx.t.scenarios.faceSwapPhotoTooLarge);
    return;
  }

  const state = await userStateService.get(ctx.user.id);
  const isReference = state?.state === "FACE_SWAP_AWAIT_REFERENCE";
  const isFace = state?.state === "FACE_SWAP_AWAIT_FACE";
  if (!isReference && !isFace) return;

  // Download from Telegram + upload to S3.
  const userId = ctx.user.id;
  const file = await ctx.api.getFile(fileId);
  const tgUrl = `https://api.telegram.org/file/bot${config.bot.token}/${file.file_path}`;
  const contentType = mimeHint?.startsWith("image/") ? mimeHint : "image/jpeg";
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const slot = isReference ? FACE_SWAP_SLOT_REFERENCE : FACE_SWAP_SLOT_FACE;
  const s3Key = `face_swap/${userId.toString()}/${Date.now()}_${slot}.${ext}`;
  const uploadedKey = await s3Service.uploadFromUrl(s3Key, tgUrl, contentType).catch(() => null);
  if (!uploadedKey) {
    await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.faceSwap, "design"));
    return;
  }

  // Persist the S3 key under the pseudo-model buffer so the second photo can
  // read it back. Use addMediaInput with overflow=true so retries on the same
  // slot replace the previous value rather than appending.
  await userStateService.addMediaInput(userId, FACE_SWAP_BUFFER_MODEL_ID, slot, uploadedKey, true);

  // Commit album dedup AFTER successful upload + notify the user once per
  // album. If upload had failed we'd have early-returned above without
  // marking the group — the next sibling can retry.
  if (mediaGroupKey) {
    processedMediaGroups.add(mediaGroupKey);
    // Cap the set so it can't grow unbounded across the bot's lifetime.
    if (processedMediaGroups.size > 1000) {
      const iter = processedMediaGroups.values();
      for (let i = 0; i < 100; i++) {
        const v = iter.next().value;
        if (v) processedMediaGroups.delete(v);
      }
    }
    await ctx.reply(ctx.t.scenarios.faceSwapAlbumNotice);
  }

  if (isReference) {
    await userStateService.setState(userId, "FACE_SWAP_AWAIT_FACE", null);
    await ctx.reply(ctx.t.scenarios.faceSwapStep2, { parse_mode: "HTML" });
    return;
  }

  // Second photo received — read both slots and submit.
  const slots = await userStateService.getMediaInputs(userId, FACE_SWAP_BUFFER_MODEL_ID);
  const referenceKey = slots[FACE_SWAP_SLOT_REFERENCE]?.[0];
  const faceKey = slots[FACE_SWAP_SLOT_FACE]?.[0];
  if (!referenceKey || !faceKey) {
    // Buffer was cleared mid-flow; restart from step 1.
    await userStateService.setState(userId, "FACE_SWAP_AWAIT_REFERENCE", null);
    await ctx.reply(ctx.t.scenarios.faceSwapStep1, { parse_mode: "HTML" });
    return;
  }

  const telegramId = ctx.user.telegramId;
  const chatId = ctx.chat?.id ?? (telegramId ? Number(telegramId) : undefined);
  if (chatId === undefined) return;

  // Resolve S3 keys → presigned URLs that the worker / Kie can fetch.
  let resolved: Record<string, string[]>;
  try {
    resolved = await resolveMediaInputUrls({
      edit: [referenceKey, faceKey],
    });
  } catch (err) {
    if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error(err, "Face swap: failed to resolve media URLs");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.faceSwap, "design"));
    }
    // S3 keys are gone — нет смысла держать буфер.
    await userStateService.clearMediaInputs(userId, FACE_SWAP_BUFFER_MODEL_ID);
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
    return;
  }

  await ctx.reply(ctx.t.scenarios.faceSwapGenerating);

  let submitOk = false;
  try {
    await generationService.submitImage({
      userId,
      modelId: FACE_SWAP_MODEL_ID,
      prompt: FACE_SWAP_PROMPT,
      mediaInputs: resolved,
      telegramChatId: chatId,
      sendOriginalLabel: ctx.t.common.sendOriginal,
      aspectRatio: "auto",
      promptMessageId: ctx.message?.message_id,
      extraModelSettings: {
        resolution: "2K",
        aspect_ratio: "auto",
        output_format: "jpeg",
        num_images: 1,
      },
      // Сценарий маскирует реальную модель: в подписи показываем «Замена лица»,
      // прячем захардкоженный английский промпт и кнопку «Доработать» (юзер
      // не выбирал модель — её и не должно быть для редактирования).
      displayNameOverride: ctx.t.scenarios.faceSwap,
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
      logger.error(err, "Face swap submit failed");
      await ctx.reply(pickGenerationFailedMessage(ctx.t, ctx.t.scenarios.faceSwap, "design"));
    }
  }

  // Чистим буфер только на успехе. На провале оставляем S3-ключи в БД —
  // следующий handleFaceSwapEnter их всё равно перезатрёт, а так юзер не
  // теряет последнюю загрузку до явного нового захода.
  if (submitOk) {
    await userStateService.clearMediaInputs(userId, FACE_SWAP_BUFFER_MODEL_ID);
    // Авто-рестарт flow: после успешного submit оставляем юзера в состоянии
    // ожидания нового референса. Если он пришлёт фото после результата — оно
    // подхватится как старт следующей Замены лица. Без этого SCENARIOS_SECTION
    // не имеет state-handler'а для фото — handleNoTool съел бы его с
    // невнятным «Раздел не выбран».
    await userStateService.setState(userId, "FACE_SWAP_AWAIT_REFERENCE", null);
  } else {
    // На ошибке возврат в Сценарии — оттуда юзер сам решит, что делать.
    await userStateService.setState(userId, "SCENARIOS_SECTION", null);
  }
}
