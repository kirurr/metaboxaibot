import type { BotContext } from "../types/context.js";
import type {
  SubmitImageParams,
  SubmitVideoParams,
  SubmitAudioParams,
} from "@metabox/api/services";
import {
  generationService,
  videoGenerationService,
  audioGenerationService,
  pendingGenerationService,
  costPreviewService,
  userStateService,
} from "@metabox/api/services";
import { db } from "@metabox/api/db";
import {
  AI_MODELS,
  config,
  generateWebToken,
  resolveModelDisplay,
  UserFacingError,
  resolveUserFacingErrorVariant,
  type AIModel,
  type MediaInputSlot,
} from "@metabox/shared";
import { InlineKeyboard, InputFile } from "grammy";
import { replyNoSubscription, replyInsufficientTokens } from "./reply-error.js";
import { ensureELTtsForVideo } from "./el-tts.js";
import { pickVideoPending, pickDesignPending } from "./pending-messages.js";
import { buildMediaInputStatusMenu } from "./media-input-state.js";
import { logger } from "../logger.js";

export type ConfirmKind = "image" | "video" | "audio";
export type ConfirmSubmitParams = SubmitImageParams | SubmitVideoParams | SubmitAudioParams;

/**
 * Snapshot of state values consumed at scene-time (before gate).
 * On Cancel, these are restored to userState so the user doesn't have to re-upload.
 * Captured by the caller right before the existing `clearMediaInputs` / `getAndClear*`
 * calls — values are exactly what was about to be wiped.
 */
export interface RestoreSnapshot {
  mediaInputs?: Record<string, string[]>;
  videoRefImageUrl?: string;
  videoRefDriverUrl?: string;
  videoRefVoiceUrl?: string;
  designRefMessageId?: string;
}

interface GateInput {
  ctx: BotContext;
  kind: ConfirmKind;
  modelId: string;
  prompt: string;
  submitParams: ConfirmSubmitParams;
  /** Override displayed prompt — e.g. placeholder for HeyGen voice-only path. */
  promptDisplay?: string;
  /** Snapshot of cleared state (slots + one-shot refs) for Cancel-restore. */
  restoreSnapshot?: RestoreSnapshot;
}

const SNAPSHOT_KEY = "__restoreSnapshot__";

/**
 * Telegram message limit is 4096 chars; header + cost line + blockquote tags
 * use ~80 chars, so cap the prompt body at ~4000 with safety margin.
 * Long prompts are tail-truncated with ellipsis (rare — most prompts are << 4000).
 */
const PROMPT_DISPLAY_MAX = 3900;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function clampPromptForDisplay(prompt: string): string {
  if (prompt.length <= PROMPT_DISPLAY_MAX) return prompt;
  return `${prompt.slice(0, PROMPT_DISPLAY_MAX - 3)}...`;
}

function bigintToString(_k: string, v: unknown): unknown {
  return typeof v === "bigint" ? v.toString() : v;
}

function serializePayload(params: ConfirmSubmitParams): Record<string, unknown> {
  return JSON.parse(JSON.stringify(params, bigintToString)) as Record<string, unknown>;
}

function deserializePayload(json: unknown, _kind: ConfirmKind): ConfirmSubmitParams {
  const obj = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
  delete obj[SNAPSHOT_KEY];
  if (typeof obj.userId === "string") obj.userId = BigInt(obj.userId);
  return obj as unknown as ConfirmSubmitParams;
}

function extractSnapshot(json: unknown): RestoreSnapshot | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const raw = obj[SNAPSHOT_KEY];
  if (!raw || typeof raw !== "object") return null;
  return raw as RestoreSnapshot;
}

type MediaKind = "photo" | "video" | "audio";

function inferKindFromSlot(slot: MediaInputSlot): MediaKind {
  if (slot.mode === "reference_audio" || slot.mode === "driving_audio") return "audio";
  if (
    slot.mode === "reference_video" ||
    slot.mode === "motion_video" ||
    slot.mode === "first_clip"
  ) {
    return "video";
  }
  return "photo";
}

/** Telegram media size limits per type (Bot API send-side). */
const PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
const VIDEO_AUDIO_LIMIT_BYTES = 50 * 1024 * 1024;

function sizeLimitFor(kind: MediaKind): number {
  return kind === "photo" ? PHOTO_LIMIT_BYTES : VIDEO_AUDIO_LIMIT_BYTES;
}

/** Подготовленный к отправке элемент: либо media (file_id или buffer-как-InputFile),
 *  либо `file` — учитываем только в текстовой сводке. */
type PreparedItem = { kind: "media"; source: string | InputFile } | { kind: "file" };

/**
 * Pre-classify + download (для URL'ов) каждый элемент слота.
 *
 *  - `tg:photo:`/`tg:video:`/`tg:audio:`/`tg:voice:` matching slot kind → media,
 *    source = file_id (никаких size-проверок: file_id выдан самим Telegram'ом
 *    при upload'е, размер уже валидный).
 *  - `tg:doc:` / mismatched-kind → file (uploaded-as-document или несовместимый
 *    тип; Telegram отверг бы их в `sendPhoto`/`sendVideo`).
 *  - HTTP(S)-URL — скачиваем байты, проверяем размер. Если влезает в лимит
 *    Telegram'а → media (InputFile с буфером); если нет → file.
 *  - Прочее (resolved-URL без https) — пытаемся как media, сделать предпроверку
 *    нечем.
 */
async function preparePreviewItems(
  resolved: string[],
  raws: string[] | undefined,
  slotKind: MediaKind,
): Promise<PreparedItem[]> {
  const limit = sizeLimitFor(slotKind);
  const out: PreparedItem[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const res = resolved[i];
    const raw = raws && raws.length === resolved.length ? raws[i] : undefined;
    if (raw && raw.startsWith("tg:")) {
      const rest = raw.slice(3);
      const idx = rest.indexOf(":");
      const tgKind = idx === -1 ? rest : rest.slice(0, idx);
      const fileId = idx === -1 ? "" : rest.slice(idx + 1);
      const source = fileId || res;
      if (tgKind === "photo" && slotKind === "photo") {
        out.push({ kind: "media", source });
        continue;
      }
      if (tgKind === "video" && slotKind === "video") {
        out.push({ kind: "media", source });
        continue;
      }
      if ((tgKind === "audio" || tgKind === "voice") && slotKind === "audio") {
        out.push({ kind: "media", source });
        continue;
      }
      out.push({ kind: "file" });
      continue;
    }
    if (typeof res === "string" && res.startsWith("http")) {
      try {
        const r = await fetch(res);
        if (!r.ok) {
          logger.warn(
            { status: r.status, url: res },
            "preparePreviewItems: URL fetch returned non-OK",
          );
          out.push({ kind: "file" });
          continue;
        }
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > limit) {
          logger.info(
            { size: buf.length, limit, slotKind },
            "preparePreviewItems: media too big, treating as file",
          );
          out.push({ kind: "file" });
          continue;
        }
        const ext = slotKind === "video" ? "mp4" : slotKind === "audio" ? "ogg" : "jpg";
        const file = new InputFile(buf, filenameFromUrl(res, `preview.${ext}`));
        out.push({ kind: "media", source: file });
      } catch (err) {
        logger.warn({ err, url: res }, "preparePreviewItems: URL fetch threw, treating as file");
        out.push({ kind: "file" });
      }
      continue;
    }
    // Не URL и не tg: — отдаём как есть, надеемся что Telegram примет.
    out.push({ kind: "media", source: res });
  }
  return out;
}

/** Имя файла для буфер-аплоада: берём последний path-сегмент URL без query. */
function filenameFromUrl(url: string, fallback: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").pop();
    return last && last.length > 0 ? last : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Один media-элемент → одно сообщение в чат. Один try, без retry/fallback'ов:
 * вся проверка размера и pre-fetch уже сделана в `preparePreviewItems`,
 * так что сюда уезжает либо file_id, либо InputFile с проверенным буфером.
 */
async function sendOneItem(
  ctx: BotContext,
  kind: MediaKind,
  source: string | InputFile,
  caption: string | undefined,
): Promise<boolean> {
  const opts = caption ? { caption } : {};
  try {
    if (kind === "photo") await ctx.replyWithPhoto(source, opts);
    else if (kind === "video") await ctx.replyWithVideo(source, opts);
    else await ctx.replyWithAudio(source, opts);
    return true;
  } catch (err) {
    logger.warn({ err, kind }, "sendOneItem: send failed");
    return false;
  }
}

/**
 * Локаль-агностичный pluralize по русским правилам (1 / 2-4 / 5+). Для en
 * locale это безопасно: One = "file", Few = Many = "files", и любая ветка
 * возвращает корректную форму. Для ru: правило с учётом 11/12-14 исключений.
 */
function pluralNoun(ctx: BotContext, count: number): string {
  const t = ctx.t.confirmGeneration;
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return t.mediaFileNounOne;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return t.mediaFileNounFew;
  return t.mediaFileNounMany;
}

/** Caption для медиа-сообщения о слоте (photo/video/audio media-group/single). */
function mediaCaptionForSlot(
  ctx: BotContext,
  kind: MediaKind,
  count: number,
  label: string,
): string {
  const captionKey: keyof typeof ctx.t.confirmGeneration =
    count === 1
      ? kind === "photo"
        ? "mediaPreviewPhotoSingle"
        : kind === "video"
          ? "mediaPreviewVideoSingle"
          : "mediaPreviewAudioSingle"
      : kind === "photo"
        ? "mediaPreviewPhotoMulti"
        : kind === "video"
          ? "mediaPreviewVideoMulti"
          : "mediaPreviewAudioMulti";
  return ctx.t.confirmGeneration[captionKey].replace("{label}", label);
}

/** Standalone-сводка про file-only элементы слота (когда медиа в слоте нет). */
function fileSummaryText(ctx: BotContext, count: number, label: string): string {
  if (count === 1) {
    return ctx.t.confirmGeneration.mediaPreviewFileSingle.replace("{label}", label);
  }
  return ctx.t.confirmGeneration.mediaPreviewFileMulti
    .replace("{count}", String(count))
    .replace("{noun}", pluralNoun(ctx, count))
    .replace("{label}", label);
}

/**
 * Составляет caption для media-сообщения слота. Если в слоте есть и media,
 * и file-only элементы — используем mixed-формат вида «Эти изображения и
 * N файлов будут использоваться как «{label}»». Иначе — обычный media-caption.
 */
function buildCombinedCaption(
  ctx: BotContext,
  kind: MediaKind,
  mediaCount: number,
  fileCount: number,
  label: string,
): string {
  if (fileCount === 0) return mediaCaptionForSlot(ctx, kind, mediaCount, label);
  const mixedKey: keyof typeof ctx.t.confirmGeneration =
    kind === "photo"
      ? "mediaPreviewMixedPhoto"
      : kind === "video"
        ? "mediaPreviewMixedVideo"
        : "mediaPreviewMixedAudio";
  return ctx.t.confirmGeneration[mixedKey]
    .replace("{fileCount}", String(fileCount))
    .replace("{fileNoun}", pluralNoun(ctx, fileCount))
    .replace("{label}", label);
}

/**
 * Sends one preview message per filled media slot, with a caption explaining
 * which slot the media will be used as. Called BEFORE the confirm message so
 * the user can visually verify their uploads before clicking Start.
 *
 * Поток для одного слота:
 *  1. `preparePreviewItems` классифицирует каждый элемент и для URL-источников
 *     заранее качает байты + проверяет размер (фото ≤10 МБ, видео/аудио ≤50 МБ).
 *     Слишком большие или неподходящие по типу (uploaded-as-document, voice,
 *     mismatch) → переводятся в file-only.
 *  2. По итоговым счётчикам строим caption: media-only / file-only / mixed.
 *  3. Шлём media (single или альбом батчами по 10).
 *  4. Если в слоте file-only элементы и нет media — отдельная текстовая сводка.
 */
async function sendMediaPreviews(
  ctx: BotContext,
  model: AIModel,
  resolvedInputs: Record<string, string[]>,
  rawInputs: Record<string, string[]> | undefined,
): Promise<void> {
  const slots = model.mediaInputs ?? [];
  for (const slot of slots) {
    const resolved = resolvedInputs[slot.slotKey];
    if (!resolved?.length) continue;
    const raws = rawInputs?.[slot.slotKey];
    const kind = inferKindFromSlot(slot);
    const label = ctx.t.mediaInput[slot.labelKey as keyof typeof ctx.t.mediaInput] ?? slot.labelKey;

    const items = await preparePreviewItems(resolved, raws, kind);
    const mediaItems = items.filter((it) => it.kind === "media").map((it) => it.source);
    const fileCount = items.filter((it) => it.kind === "file").length;

    // Только файлы — одно текстовое сообщение.
    if (mediaItems.length === 0) {
      if (fileCount > 0) {
        const summary = fileSummaryText(ctx, fileCount, label);
        await ctx
          .reply(summary)
          .catch((err) =>
            logger.warn(
              { err, slotKey: slot.slotKey, fileCount },
              "sendMediaPreviews: file summary reply failed",
            ),
          );
      }
      continue;
    }

    const caption = buildCombinedCaption(ctx, kind, mediaItems.length, fileCount, label);

    if (mediaItems.length === 1) {
      const ok = await sendOneItem(ctx, kind, mediaItems[0], caption);
      if (!ok) {
        logger.warn(
          { slotKey: slot.slotKey, kind, fileCount },
          "sendMediaPreviews: single media send failed",
        );
        // Single failed — fallback на текстовую сводку, чтобы юзер всё-таки
        // увидел подтверждение что слот заполнен.
        await ctx
          .reply(fileSummaryText(ctx, mediaItems.length + fileCount, label))
          .catch((replyErr) =>
            logger.warn(
              { replyErr, slotKey: slot.slotKey },
              "sendMediaPreviews: fallback summary reply failed",
            ),
          );
      }
      continue;
    }

    // Telegram media-group допускает максимум 10 элементов на album.
    // Бьём на батчи по 10 — будет N последовательных альбомов.
    const ALBUM_MAX = 10;
    for (let start = 0; start < mediaItems.length; start += ALBUM_MAX) {
      const batch = mediaItems.slice(start, start + ALBUM_MAX);
      const isFirstBatch = start === 0;
      const media = batch.map((src, i) => ({
        type: kind,
        media: src,
        ...(isFirstBatch && i === 0 ? { caption } : {}),
      }));
      try {
        // grammY's replyWithMediaGroup type is restrictive on inputs; safe-cast
        // since we've narrowed kind above and Telegram accepts mixed strings.
        await ctx.replyWithMediaGroup(
          media as unknown as Parameters<typeof ctx.replyWithMediaGroup>[0],
        );
      } catch (err) {
        // Group failed — Telegram отбрасывает всю группу при первой кривой ссылке.
        // Повторяем поэлементно, чтобы остальные элементы всё же дошли.
        logger.warn(
          { err, slotKey: slot.slotKey, kind, count: batch.length, batchStart: start },
          "sendMediaPreviews: group send failed, falling back to per-item",
        );
        for (let i = 0; i < batch.length; i++) {
          const itemCaption = isFirstBatch && i === 0 ? caption : undefined;
          const ok = await sendOneItem(ctx, kind, batch[i], itemCaption);
          if (!ok) {
            logger.warn(
              { slotKey: slot.slotKey, kind, index: start + i },
              "sendMediaPreviews: per-item send failed, skipping",
            );
          }
        }
      }
    }
  }
}

/**
 * If the user has confirm-before-generate ON, sends a confirmation message,
 * persists the pending request, and returns true (caller must NOT proceed
 * with submit). Returns false when the gate is off — caller falls through
 * to its existing submit logic.
 */
export async function gateLowIqMode(input: GateInput): Promise<boolean> {
  const { ctx, kind, modelId, prompt, submitParams, promptDisplay, restoreSnapshot } = input;
  if (!ctx.user || !ctx.chat) return false;

  const user = await db.user.findUnique({
    where: { id: ctx.user.id },
    select: { confirmBeforeGenerate: true },
  });
  if (!user || !user.confirmBeforeGenerate) return false;

  let cost: number;
  try {
    if (kind === "image") {
      cost = (await costPreviewService.previewImage(submitParams as SubmitImageParams)).cost;
    } else if (kind === "video") {
      cost = (await costPreviewService.previewVideo(submitParams as SubmitVideoParams)).cost;
    } else {
      cost = (await costPreviewService.previewAudio(submitParams as SubmitAudioParams)).cost;
    }
  } catch (err) {
    logger.warn(
      { err, kind, modelId },
      "gateLowIqMode: cost preview failed; bypassing confirmation",
    );
    return false;
  }

  const model = AI_MODELS[modelId];
  const modelName = model ? resolveModelDisplay(modelId, ctx.user.language, model).name : modelId;
  const displayedPrompt = promptDisplay ?? clampPromptForDisplay(prompt);
  const text = ctx.t.confirmGeneration.message
    .replace("{model}", escapeHtml(modelName))
    .replace("{prompt}", escapeHtml(displayedPrompt))
    .replace("{cost}", cost.toFixed(2));

  // Send per-slot media previews BEFORE the confirm message so the user can
  // visually verify uploads. Only for image/video kinds with mediaInputs.
  if (model && (kind === "image" || kind === "video")) {
    const submitMedia = (submitParams as SubmitImageParams | SubmitVideoParams).mediaInputs;
    if (submitMedia && Object.keys(submitMedia).length > 0) {
      await sendMediaPreviews(ctx, model, submitMedia, restoreSnapshot?.mediaInputs);
    }
  }

  const kb = new InlineKeyboard()
    .text(ctx.t.confirmGeneration.start, "lqg:start")
    .text(ctx.t.confirmGeneration.cancel, "lqg:cancel");
  const sent = await ctx.reply(text, { reply_markup: kb, parse_mode: "HTML" });

  const payloadObj = serializePayload(submitParams);
  if (restoreSnapshot && Object.keys(restoreSnapshot).length > 0) {
    payloadObj[SNAPSHOT_KEY] = restoreSnapshot;
  }

  const { previous } = await pendingGenerationService.upsert({
    userId: ctx.user.id,
    section: kind,
    modelId,
    prompt,
    payload: payloadObj as object,
    estimatedCost: cost,
    chatId: BigInt(ctx.chat.id),
    messageId: BigInt(sent.message_id),
  });

  if (previous) {
    await ctx.api
      .editMessageReplyMarkup(Number(previous.chatId), Number(previous.messageId), {
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => void 0);
  }

  return true;
}

async function runReplaySubmit(
  ctx: BotContext,
  kind: ConfirmKind,
  params: ConfirmSubmitParams,
): Promise<void> {
  if (!ctx.user || !ctx.chat) return;
  const chatId = ctx.chat.id;
  const pendingText =
    kind === "audio"
      ? ctx.t.audio.processing
      : kind === "video"
        ? pickVideoPending(ctx)
        : pickDesignPending(ctx);
  const pendingMsg = await ctx.reply(pendingText);

  try {
    if (kind === "image") {
      await generationService.submitImage(params as SubmitImageParams);
    } else if (kind === "video") {
      // EL TTS pre-gen for HeyGen+EL is deferred until here so cancelling the
      // confirm message costs the user $0 in EL spend.
      const videoParams = await ensureELTtsForVideo(params as SubmitVideoParams);
      await videoGenerationService.submitVideo(videoParams);
    } else {
      await audioGenerationService.submitAudio(params as SubmitAudioParams);
    }
    // pendingMsg намеренно НЕ удаляется на успехе — остаётся как «в процессе»-
    // индикатор, пока воркер не пришлёт финальный результат. Mirrors confirm-off
    // scene behavior (audio/design просто оставляют pendingMsg).
  } catch (err: unknown) {
    await ctx.api.deleteMessage(chatId, pendingMsg.message_id).catch(() => void 0);
    if (err instanceof Error && err.message === "NO_SUBSCRIPTION") {
      await replyNoSubscription(ctx);
    } else if (err instanceof Error && err.message === "INSUFFICIENT_TOKENS") {
      await replyInsufficientTokens(ctx);
    } else if (err instanceof UserFacingError) {
      await ctx.reply(resolveUserFacingErrorVariant(err, ctx.t));
    } else {
      logger.error({ err, kind }, "runReplaySubmit failed");
      const failKey =
        kind === "audio"
          ? ctx.t.audio.generationFailed
          : kind === "video"
            ? ctx.t.video.generationFailed
            : ctx.t.design.generationFailed;
      await ctx.reply(failKey);
    }
  }
}

export async function handleLowIqStart(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const callbackMessageId = ctx.callbackQuery?.message?.message_id;
  const pending = await pendingGenerationService.getByUser(ctx.user.id);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: ctx.t.confirmGeneration.expired });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => void 0);
    return;
  }
  if (callbackMessageId !== undefined && BigInt(callbackMessageId) !== pending.messageId) {
    await ctx.answerCallbackQuery({ text: ctx.t.confirmGeneration.replaced });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => void 0);
    return;
  }
  if (pending.expiresAt.getTime() < Date.now()) {
    await pendingGenerationService.deleteById(pending.id);
    await ctx.answerCallbackQuery({ text: ctx.t.confirmGeneration.expired });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => void 0);
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => void 0);
  await pendingGenerationService.deleteById(pending.id);

  const kind = pending.section as ConfirmKind;
  const params = deserializePayload(pending.payload, kind);
  await runReplaySubmit(ctx, kind, params);
}

async function restoreFromSnapshot(
  userId: bigint,
  modelId: string,
  snapshot: RestoreSnapshot,
): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (snapshot.mediaInputs) {
    tasks.push(
      userStateService
        .setMediaInputsForModel(userId, modelId, snapshot.mediaInputs)
        .catch((err) => logger.warn({ err, userId, modelId }, "restoreFromSnapshot: mediaInputs")),
    );
  }
  if (snapshot.videoRefImageUrl) {
    tasks.push(
      userStateService
        .setVideoRefImageUrl(userId, snapshot.videoRefImageUrl)
        .catch((err) => logger.warn({ err, userId }, "restoreFromSnapshot: videoRefImageUrl")),
    );
  }
  if (snapshot.videoRefDriverUrl) {
    tasks.push(
      userStateService
        .setVideoRefDriverUrl(userId, snapshot.videoRefDriverUrl)
        .catch((err) => logger.warn({ err, userId }, "restoreFromSnapshot: videoRefDriverUrl")),
    );
  }
  if (snapshot.videoRefVoiceUrl) {
    tasks.push(
      userStateService
        .setVideoRefVoiceUrl(userId, snapshot.videoRefVoiceUrl)
        .catch((err) => logger.warn({ err, userId }, "restoreFromSnapshot: videoRefVoiceUrl")),
    );
  }
  if (snapshot.designRefMessageId) {
    tasks.push(
      userStateService
        .setDesignRefMessage(userId, snapshot.designRefMessageId)
        .catch((err) => logger.warn({ err, userId }, "restoreFromSnapshot: designRefMessageId")),
    );
  }
  await Promise.all(tasks);
}

/**
 * Builds the post-cancel inline keyboard: media-input slots + management webapp button.
 * Mirrors what the model activation message shows, so the user can immediately
 * tweak slots or settings after cancelling.
 */
async function buildPostCancelKeyboard(
  ctx: BotContext,
  section: "image" | "video",
  modelId: string,
): Promise<InlineKeyboard | undefined> {
  if (!ctx.user) return undefined;
  const model = AI_MODELS[modelId];
  if (!model) return undefined;

  const kb = new InlineKeyboard();
  if (model.mediaInputs?.length) {
    const filledInputs = await userStateService.getMediaInputs(ctx.user.id, modelId);
    const sceneSection = section === "image" ? "design" : "video";
    const { kb: slotsKb } = buildMediaInputStatusMenu(
      model.mediaInputs,
      filledInputs,
      sceneSection,
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

  const webappUrl = config.bot.webappUrl;
  if (webappUrl && ctx.user.telegramId) {
    const wtoken = generateWebToken(ctx.user.telegramId, config.bot.token);
    const sectionParam = section === "image" ? "design" : "video";
    const mgmtLabel = section === "image" ? ctx.t.design.management : ctx.t.video.management;
    kb.webApp(mgmtLabel, `${webappUrl}?page=management&section=${sectionParam}&wtoken=${wtoken}`);
  }

  return kb.inline_keyboard.length ? kb : undefined;
}

/** True if snapshot has at least one non-empty slot/ref worth restoring. */
function snapshotHasFiles(snapshot: RestoreSnapshot | null): boolean {
  if (!snapshot) return false;
  if (snapshot.mediaInputs) {
    for (const arr of Object.values(snapshot.mediaInputs)) {
      if (arr && arr.length > 0) return true;
    }
  }
  if (snapshot.videoRefImageUrl) return true;
  if (snapshot.videoRefDriverUrl) return true;
  if (snapshot.videoRefVoiceUrl) return true;
  if (snapshot.designRefMessageId) return true;
  return false;
}

export async function handleLowIqCancel(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const pending = await pendingGenerationService.getByUser(ctx.user.id);
  let menuKb: InlineKeyboard | undefined;
  let hadFiles = false;
  if (pending) {
    const snapshot = extractSnapshot(pending.payload);
    if (snapshot) {
      hadFiles = snapshotHasFiles(snapshot);
      await restoreFromSnapshot(ctx.user.id, pending.modelId, snapshot);
    }
    if (pending.section === "image" || pending.section === "video") {
      menuKb = await buildPostCancelKeyboard(ctx, pending.section, pending.modelId);
    }
  }
  await pendingGenerationService.deleteByUser(ctx.user.id);
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => void 0);
  const text = hadFiles
    ? ctx.t.confirmGeneration.cancelledWithFiles
    : ctx.t.confirmGeneration.cancelled;
  await ctx.reply(text, menuKb ? { reply_markup: menuKb } : undefined);
}
