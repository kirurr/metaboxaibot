import type { Section, AIModel, MediaInputSlot, Translations } from "@metabox/shared";
import { AI_MODELS, getActiveSlots, getResolvedModes } from "@metabox/shared";
import { userStateService } from "@metabox/api/services";
import { config, UserFacingError } from "@metabox/shared";
import { InlineKeyboard, InputFile } from "grammy";
import type { Context } from "grammy";
import { getFileUrl, objectExists } from "@metabox/api/services";

export type SlotMediaType = "image" | "video" | "audio";

/** Telegram Bot API hard limit for downloading files (cloud Bot API). */
export const TG_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * Validate an uploaded media file against a slot's `constraints`.
 * Returns an error message (from `t.errors.mediaSlot*`) when rejected, or null
 * when the file is acceptable (or the slot has no constraints).
 *
 * Reusable across any handler that receives media into a slot — caller provides
 * the metadata it already has (duration from `message.video.duration`, size
 * from `file_size`). Missing fields are skipped, so photo slots can reuse this
 * for `maxFileSizeBytes` alone.
 */
export function validateMediaAgainstSlot(
  slot: MediaInputSlot,
  media: {
    durationSec?: number;
    fileSizeBytes?: number;
    widthPx?: number;
    heightPx?: number;
  },
  t: Translations,
): string | null {
  const c = slot.constraints;
  if (!c) return null;

  if (
    c.maxFileSizeBytes !== undefined &&
    media.fileSizeBytes !== undefined &&
    media.fileSizeBytes > c.maxFileSizeBytes
  ) {
    const actualMb = (media.fileSizeBytes / (1024 * 1024)).toFixed(1);
    const maxMb = (c.maxFileSizeBytes / (1024 * 1024)).toFixed(0);
    return t.errors.mediaSlotFileTooLarge.replace("{actualMb}", actualMb).replace("{maxMb}", maxMb);
  }

  if (media.durationSec !== undefined) {
    const d = media.durationSec;
    const hasMin = c.minDurationSec !== undefined;
    const hasMax = c.maxDurationSec !== undefined;
    const belowMin = hasMin && d < (c.minDurationSec as number);
    const aboveMax = hasMax && d > (c.maxDurationSec as number);
    if (belowMin || aboveMax) {
      const actual = String(Math.round(d));
      if (hasMin && hasMax) {
        return t.errors.mediaSlotDurationOutOfRange
          .replace("{actual}", actual)
          .replace("{min}", String(c.minDurationSec))
          .replace("{max}", String(c.maxDurationSec));
      }
      if (belowMin) {
        return t.errors.mediaSlotDurationTooShort
          .replace("{actual}", actual)
          .replace("{min}", String(c.minDurationSec));
      }
      return t.errors.mediaSlotDurationTooLong
        .replace("{actual}", actual)
        .replace("{max}", String(c.maxDurationSec));
    }
  }

  if (media.widthPx !== undefined && media.heightPx !== undefined) {
    const w = media.widthPx;
    const h = media.heightPx;
    const tooSmall =
      (c.minWidth !== undefined && w < c.minWidth) ||
      (c.minHeight !== undefined && h < c.minHeight);
    const tooLarge =
      (c.maxWidth !== undefined && w > c.maxWidth) ||
      (c.maxHeight !== undefined && h > c.maxHeight);
    if (tooSmall) {
      return t.errors.mediaSlotImageTooSmall
        .replace("{actualW}", String(w))
        .replace("{actualH}", String(h))
        .replace("{minW}", String(c.minWidth ?? 0))
        .replace("{minH}", String(c.minHeight ?? 0));
    }
    if (tooLarge) {
      return t.errors.mediaSlotImageTooLarge
        .replace("{actualW}", String(w))
        .replace("{actualH}", String(h))
        .replace("{maxW}", String(c.maxWidth ?? 0))
        .replace("{maxH}", String(c.maxHeight ?? 0));
    }

    // Frame pixels = w × h. Чек дополняет minWidth/minHeight/maxWidth/maxHeight:
    // обе стороны могут влезть в [min..max], но суммарная площадь — нет.
    // Пример: 4K phone-видео 3840×2160 = 8.29M пикселей превышает лимит
    // Evolink Seedance reference-to-video (~2.08M), хотя width=3840 ≤ 6000
    // и height=2160 ≤ 6000 проходят индивидуально.
    if (c.minFramePixels !== undefined || c.maxFramePixels !== undefined) {
      const frame = w * h;
      const belowMinFp = c.minFramePixels !== undefined && frame < c.minFramePixels;
      const aboveMaxFp = c.maxFramePixels !== undefined && frame > c.maxFramePixels;
      if (belowMinFp || aboveMaxFp) {
        const fmtMp = (px: number): string => (px / 1_000_000).toFixed(1);
        return t.errors.mediaSlotFramePixelsOutOfRange
          .replace("{actualW}", String(w))
          .replace("{actualH}", String(h))
          .replace("{actualMpix}", fmtMp(frame))
          .replace("{minMpix}", c.minFramePixels !== undefined ? fmtMp(c.minFramePixels) : "—")
          .replace("{maxMpix}", c.maxFramePixels !== undefined ? fmtMp(c.maxFramePixels) : "—");
      }
    }

    // Aspect ratio (width / height). Validate только если хотя бы один лимит задан
    // и обе стороны известны. Например, KIE Kling требует ratio ∈ [1:2.5, 2.5:1]
    // (т.е. w/h ∈ [0.4, 2.5]) — иначе submit падает 422 на стороне провайдера.
    if (h > 0 && (c.minAspectRatio !== undefined || c.maxAspectRatio !== undefined)) {
      const ratio = w / h;
      const belowMinR = c.minAspectRatio !== undefined && ratio < c.minAspectRatio;
      const aboveMaxR = c.maxAspectRatio !== undefined && ratio > c.maxAspectRatio;
      if (belowMinR || aboveMaxR) {
        const fmtRatio = (r: number): string => {
          if (r >= 1) return `${r.toFixed(1).replace(/\.0$/, "")}:1`;
          return `1:${(1 / r).toFixed(1).replace(/\.0$/, "")}`;
        };
        return t.errors.mediaSlotAspectRatioOutOfRange
          .replace("{actualW}", String(w))
          .replace("{actualH}", String(h))
          .replace("{minRatio}", c.minAspectRatio !== undefined ? fmtRatio(c.minAspectRatio) : "—")
          .replace("{maxRatio}", c.maxAspectRatio !== undefined ? fmtRatio(c.maxAspectRatio) : "—");
      }
    }
  }

  return null;
}

export type TgFileKind = "photo" | "doc" | "video" | "audio" | "voice";

/** Slot value format for Telegram-uploaded media: resolved lazily at submit. */
export function buildTgSlotValue(kind: TgFileKind, fileId: string): string {
  return `tg:${kind}:${fileId}`;
}

async function tgGetFilePath(fileId: string): Promise<string> {
  const res = await fetch(
    `https://api.telegram.org/bot${config.bot.token}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  const data = (await res.json().catch(() => null)) as {
    ok: boolean;
    result?: { file_path?: string };
    description?: string;
  } | null;
  if (!res.ok || !data?.ok || !data.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${data?.description ?? `HTTP ${res.status}`}`);
  }
  return data.result.file_path;
}

export interface ActiveUploadSlot {
  slotKey: string;
  modelId: string;
  maxImages: number;
  section: Section;
}

const activeSlots = new Map<bigint, ActiveUploadSlot>();

export function setActiveSlot(userId: bigint, slot: ActiveUploadSlot): void {
  activeSlots.set(userId, slot);
}

export function getActiveSlot(userId: bigint): ActiveUploadSlot | undefined {
  return activeSlots.get(userId);
}

export function clearActiveSlot(userId: bigint): void {
  activeSlots.delete(userId);
}

/**
 * Returns the media types a slot can accept based on its `mode`.
 * `reference_element` accepts both photos (1-4) and a single video.
 */
export function getSlotMediaTypes(slot: MediaInputSlot): readonly SlotMediaType[] {
  switch (slot.mode) {
    case "reference_video":
    case "motion_video":
    case "first_clip":
      return ["video"];
    case "reference_audio":
    case "driving_audio":
      return ["audio"];
    case "reference_element":
      return slot.imagesOnly ? ["image"] : ["image", "video"];
    default:
      return ["image"];
  }
}

/**
 * Picks the next slot to auto-fill given current state and the media type
 * being uploaded. Iterates `slots` in definition order and returns the first
 * one that:
 *  - accepts `mediaType`,
 *  - has remaining capacity (`maxImages ?? 1`),
 *  - is not from a different exclusiveGroup than already-filled slots.
 *
 * Returns `null` when nothing fits — caller treats this as overflow.
 */
export function pickAutoSlot(
  slots: readonly MediaInputSlot[],
  filledInputs: Record<string, string[]>,
  mediaType: SlotMediaType,
): MediaInputSlot | null {
  const filledGroups = new Set<string>();
  for (const slot of slots) {
    if (slot.exclusiveGroup && filledInputs[slot.slotKey]?.length) {
      filledGroups.add(slot.exclusiveGroup);
    }
  }

  for (const slot of slots) {
    if (!getSlotMediaTypes(slot).includes(mediaType)) continue;
    if (slot.exclusiveGroup && filledGroups.size > 0 && !filledGroups.has(slot.exclusiveGroup))
      continue;
    const used = filledInputs[slot.slotKey]?.length ?? 0;
    const max = slot.maxImages ?? 1;
    if (used >= max) continue;
    return slot;
  }
  return null;
}

/**
 * Builds the human-readable per-slot capacity breakdown shown in the
 * "too many media" overflow reply. Slots from the same exclusiveGroup are
 * shown only once (the first one in definition order) — the user picks one
 * group anyway, so listing both halves of an "either/or" set is noise.
 *
 * Format examples:
 *   • Первый кадр
 *   • Референс × 3
 */
export function formatSlotBreakdown(
  slots: readonly MediaInputSlot[],
  t: Translations,
): { totalMax: number; lines: string[] } {
  const seenGroups = new Set<string>();
  const lines: string[] = [];
  let totalMax = 0;
  for (const slot of slots) {
    if (slot.exclusiveGroup) {
      if (seenGroups.has(slot.exclusiveGroup)) continue;
      seenGroups.add(slot.exclusiveGroup);
    }
    const max = slot.maxImages ?? 1;
    totalMax += max;
    const label = t.mediaInput[slot.labelKey as keyof typeof t.mediaInput] ?? slot.labelKey;
    lines.push(max > 1 ? `• ${String(label)} × ${max}` : `• ${String(label)}`);
  }
  return { totalMax, lines };
}

/**
 * Per-(user, media-group) accumulator used by the auto-slot distribution
 * path: each photo in a group fires its own handler call, but we only want
 * to send ONE reply at the end (after debounceSlotReply settles). The
 * accumulator collects overflow count + earliest seen caption across all
 * siblings, then the debounce callback consumes and acts on it.
 */
interface DistributionState {
  overflowCount: number;
  caption?: string;
  modelId: string;
  section: Section;
}
const distributionStates = new Map<string, DistributionState>();

function distributionKey(userId: bigint, mediaGroupId: string | undefined): string {
  return `${userId}__${mediaGroupId ?? "single"}`;
}

export function trackDistribution(
  userId: bigint,
  mediaGroupId: string | undefined,
  patch: { overflow: boolean; caption?: string; modelId: string; section: Section },
): void {
  const key = distributionKey(userId, mediaGroupId);
  const prev = distributionStates.get(key);
  const next: DistributionState = prev
    ? {
        overflowCount: prev.overflowCount + (patch.overflow ? 1 : 0),
        caption: prev.caption ?? patch.caption,
        modelId: prev.modelId,
        section: prev.section,
      }
    : {
        overflowCount: patch.overflow ? 1 : 0,
        caption: patch.caption,
        modelId: patch.modelId,
        section: patch.section,
      };
  distributionStates.set(key, next);
}

export function consumeDistribution(
  userId: bigint,
  mediaGroupId: string | undefined,
): DistributionState | undefined {
  const key = distributionKey(userId, mediaGroupId);
  const value = distributionStates.get(key);
  distributionStates.delete(key);
  return value;
}

/**
 * Builds the overflow reply body. Caller composes it into the slot status
 * message (so the user sees the breakdown alongside the current slot menu).
 */
export function buildOverflowMessage(model: AIModel, t: Translations): string {
  if (!model.mediaInputs?.length) return "";
  const { totalMax, lines } = formatSlotBreakdown(model.mediaInputs, t);
  return t.mediaInput.tooManyMedia
    .replace("{modelName}", model.name)
    .replace("{totalMax}", String(totalMax))
    .replace("{breakdown}", lines.join("\n"));
}

/**
 * Returns the slots active for the user's currently-selected mode on the
 * given model. For models without `modes` defined, returns all `mediaInputs`
 * unchanged. Centralizes the (load model + load saved mode + filter) chain so
 * scene handlers don't have to repeat it.
 */
export async function getActiveModelSlots(
  userId: bigint,
  modelId: string,
): Promise<MediaInputSlot[]> {
  const model = AI_MODELS[modelId];
  if (!model?.mediaInputs?.length) return [];
  const modes = getResolvedModes(model);
  if (!modes) return model.mediaInputs;
  const savedModeId = await userStateService.getSelectedMode(userId, modelId);
  return getActiveSlots(model, savedModeId);
}

/**
 * Returns the first slot that's required-but-missing for this model, or null
 * if all required inputs are present.
 *
 * Beyond the intrinsic `slot.required` flag this can be extended with
 * conditional requirements derived from mode or model definition.
 */
export function findMissingRequiredSlot(
  _modelId: string,
  activeSlots: MediaInputSlot[],
  filledInputs: Record<string, string[]>,
): MediaInputSlot | null {
  for (const slot of activeSlots) {
    if (slot.required && !filledInputs[slot.slotKey]?.length) return slot;
  }
  return null;
}

/**
 * Builds the inline keyboard for the mode picker (one button per mode, two
 * per row). Callback data: `mode:<section>:<modelId>:<modeId>`.
 *
 * Returned alongside the message body so callers can attach their own
 * additional buttons (e.g. management web-app) before sending.
 */
export function buildModePickerMenu(
  modes: readonly { id: string; labelKey: string }[],
  section: string,
  modelId: string,
  t: Translations,
): { text: string; kb: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (let i = 0; i < modes.length; i += 2) {
    const a = modes[i];
    const labelA = String(t.modelModes[a.labelKey as keyof typeof t.modelModes] ?? a.labelKey);
    kb.text(labelA, `mode:${section}:${modelId}:${a.id}`);
    const b = modes[i + 1];
    if (b) {
      const labelB = String(t.modelModes[b.labelKey as keyof typeof t.modelModes] ?? b.labelKey);
      kb.text(labelB, `mode:${section}:${modelId}:${b.id}`);
    }
    kb.row();
  }
  return { text: t.modelModes.pickerTitle, kb };
}

/**
 * Builds the per-slot "uploaded" toast shown after auto-distribution settles.
 * Single-image slots get "✅ {slot} uploaded"; multi-image slots get the
 * counted "✅ {slot}: {n}/{max} saved" form.
 */
export function buildSlotUploadedMessage(
  slot: MediaInputSlot,
  count: number,
  t: Translations,
): string {
  const label = String(t.mediaInput[slot.labelKey as keyof typeof t.mediaInput] ?? slot.labelKey);
  const max = slot.maxImages ?? 1;
  if (max === 1) {
    return t.mediaInput.imageSavedSingle.replace("{slot}", label);
  }
  return t.mediaInput.imageSaved
    .replace("{slot}", label)
    .replace("{n}", String(count))
    .replace("{max}", String(max));
}

/**
 * Builds an inline keyboard showing current media input slot status + a text line.
 * Filled slots: "✅ {label}" with remove callback.
 * Empty slots: "🖼 {label} (optional/required)" with upload callback.
 * If all required slots are filled (or none are required), appends readyForPrompt text.
 * When `promptOptional` is true and all required slots are filled, adds a "Start generation" button.
 */
export function buildMediaInputStatusMenu(
  slots: MediaInputSlot[],
  filledInputs: Record<string, string[]>,
  section: string,
  t: Translations,
  options?: { promptOptional?: boolean; promptOptionalRequiresMedia?: boolean },
): { text: string; kb: InlineKeyboard } {
  const kb = new InlineKeyboard();

  let allRequiredFilled = true;
  let nextElementShown = false;

  // Determine which exclusive groups have filled slots.
  const filledGroups = new Set<string>();
  for (const slot of slots) {
    if (slot.exclusiveGroup && filledInputs[slot.slotKey]?.length) {
      filledGroups.add(slot.exclusiveGroup);
    }
  }

  for (const slot of slots) {
    const label = t.mediaInput[slot.labelKey as keyof typeof t.mediaInput] ?? slot.labelKey;
    const isFilled = !!filledInputs[slot.slotKey]?.length;

    // Hide slots from other exclusive groups when one group is active.
    if (
      slot.exclusiveGroup &&
      !isFilled &&
      filledGroups.size > 0 &&
      !filledGroups.has(slot.exclusiveGroup)
    ) {
      continue;
    }

    // Прогрессивный reveal: скрываем кнопку пока зависимый слот не заполнен.
    // (Если данный слот уже заполнен — показываем как обычно, чтобы можно было
    // снять.)
    if (slot.revealAfter && !isFilled && !filledInputs[slot.revealAfter]?.length) {
      continue;
    }

    // Progressive reveal for element slots: show filled + one next empty slot.
    if (slot.mode === "reference_element") {
      if (isFilled) {
        kb.text(`✅ ${label}`, `mi:${section}:${slot.slotKey}`)
          .text(t.mediaInput.remove, `mi_remove:${section}:${slot.slotKey}`)
          .row();
      } else if (!nextElementShown) {
        nextElementShown = true;
        const suffix = slot.required ? ` ${t.mediaInput.required}` : ` ${t.mediaInput.optional}`;
        kb.text(`${label}${suffix}`, `mi:${section}:${slot.slotKey}`).row();
        if (slot.required) allRequiredFilled = false;
      }
      continue;
    }

    if (isFilled) {
      kb.text(`✅ ${label}`, `mi:${section}:${slot.slotKey}`)
        .text(t.mediaInput.remove, `mi_remove:${section}:${slot.slotKey}`)
        .row();
    } else {
      const suffix = slot.required ? ` ${t.mediaInput.required}` : ` ${t.mediaInput.optional}`;
      kb.text(`${label}${suffix}`, `mi:${section}:${slot.slotKey}`).row();
      if (slot.required) allRequiredFilled = false;
    }
  }

  const promptOptional = options?.promptOptional ?? false;
  const requiresMedia = options?.promptOptionalRequiresMedia ?? false;
  const hasAnyFilled = Object.values(filledInputs).some((v) => v?.length);
  const showGenerateButton =
    allRequiredFilled && promptOptional && (!requiresMedia || hasAnyFilled);

  if (showGenerateButton) {
    kb.text(t.mediaInput.startGeneration, `mi_generate:${section}`).row();
  }

  const text = allRequiredFilled
    ? promptOptional && (!requiresMedia || hasAnyFilled)
      ? t.mediaInput.readyForPromptOptional
      : t.mediaInput.readyForPrompt
    : "";
  return { text, kb };
}

/**
 * Debounce reply when receiving media into a slot. Each upload saves
 * immediately, but the reply is delayed: only the last callback (after no
 * more uploads arrive within the window) fires. Albums use `mediaGroupId`
 * as the key; individually-sent files fall back to a per-user key, so
 * rapid sequential uploads also coalesce.
 *
 * `scope` further partitions the timer (e.g. by slotKey for per-slot
 * "uploaded" messages, since one media group can fill multiple slots and
 * each needs its own debounced reply).
 */
const slotReplyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const SLOT_REPLY_DEBOUNCE_MS = 500;

export function debounceSlotReply(
  userId: bigint,
  mediaGroupId: string | undefined,
  callback: () => Promise<void>,
  scope?: string,
): void {
  const key = `${userId}__${mediaGroupId ?? "single"}${scope ? `__${scope}` : ""}`;
  const existing = slotReplyTimers.get(key);
  if (existing) clearTimeout(existing);
  slotReplyTimers.set(
    key,
    setTimeout(() => {
      slotReplyTimers.delete(key);
      void callback();
    }, SLOT_REPLY_DEBOUNCE_MS),
  );
}

/**
 * Резолвит одно сырое значение слота:
 *  - `tg:{kind}:{fileId}` → fresh Telegram download URL
 *  - `http*`              → pass-through
 *  - иначе                → S3-ключ; HEAD-check + getFileUrl
 *
 * Возвращает `{ kind: "url" }` при успехе и `{ kind: "stale" }` если ссылка
 * больше не работает (Telegram file_id протух, S3-объект удалён). Caller
 * (`resolveMediaInputUrls`) бросает UserFacingError и опционально чистит
 * протухшие записи из persistent state'а.
 */
type SlotResolveResult = { kind: "url"; url: string } | { kind: "stale" };

async function resolveSlotValue(v: string): Promise<SlotResolveResult> {
  if (v.startsWith("tg:")) {
    const idx = v.indexOf(":", 3);
    const fileId = idx === -1 ? v.slice(3) : v.slice(idx + 1);
    try {
      const filePath = await tgGetFilePath(fileId);
      return {
        kind: "url",
        url: `https://api.telegram.org/file/bot${config.bot.token}/${filePath}`,
      };
    } catch {
      return { kind: "stale" };
    }
  }
  if (v.startsWith("http")) return { kind: "url", url: v };
  // S3-ключ. HEAD'аем до подписи URL — иначе сабмитим в провайдер ссылку на
  // удалённый объект, провайдер 404'ит мид-генерации, юзер видит generic
  // «generationFailed». `null` от objectExists = S3 не сконфигурен или
  // транзиентная ошибка HEAD'а → fail-open: продолжаем, пусть провайдер
  // сам разберётся.
  const exists = await objectExists(v);
  if (exists === false) return { kind: "stale" };
  const url = await getFileUrl(v);
  return { kind: "url", url: url ?? v };
}

/**
 * Resolves media input values right before generation so URLs are fresh.
 * See `resolveSlotValue` for per-value semantics.
 *
 * При обнаружении протухших ссылок (Telegram file expired / S3 object 404):
 *  - если задан `cleanup: { userId, modelId }` — удаляем протухшие сырые
 *    значения из `userState.mediaInputs[modelId]`. Следующий заход в этот же
 *    слот юзер увидит чистым / без поломанной ссылки.
 *  - в любом случае бросаем `UserFacingError("mediaSlotExpired")`, чтобы юзер
 *    увидел понятное сообщение «загрузите файл повторно».
 */
export async function resolveMediaInputUrls(
  inputs: Record<string, string[]>,
  cleanup?: { userId: bigint; modelId: string },
): Promise<Record<string, string[]>> {
  const resolved: Record<string, string[]> = {};
  const cleanRaw: Record<string, string[]> = {};
  let hasStale = false;

  for (const [slotKey, values] of Object.entries(inputs)) {
    const out: string[] = [];
    const remainingRaw: string[] = [];
    for (const v of values) {
      const r = await resolveSlotValue(v);
      if (r.kind === "stale") {
        hasStale = true;
      } else {
        out.push(r.url);
        remainingRaw.push(v);
      }
    }
    resolved[slotKey] = out;
    if (remainingRaw.length > 0) cleanRaw[slotKey] = remainingRaw;
  }

  if (hasStale) {
    if (cleanup) {
      await userStateService
        .setMediaInputsForModel(cleanup.userId, cleanup.modelId, cleanRaw)
        .catch(() => void 0);
    }
    throw new UserFacingError("Media slot expired", { key: "mediaSlotExpired" });
  }
  return resolved;
}

/** Maps slot.mode to the default Telegram send method for legacy values without explicit kind. */
function inferKindFromSlotMode(mode: MediaInputSlot["mode"]): TgFileKind {
  if (mode === "reference_audio" || mode === "driving_audio") return "audio";
  if (mode === "reference_video" || mode === "motion_video" || mode === "first_clip")
    return "video";
  return "photo";
}

interface ResolvedSlotItem {
  kind: TgFileKind;
  source: string | InputFile;
}

async function resolveSlotItem(v: string, slot: MediaInputSlot): Promise<ResolvedSlotItem | null> {
  if (v.startsWith("tg:")) {
    const rest = v.slice(3);
    const idx = rest.indexOf(":");
    const parsedKind = (idx === -1 ? rest : rest.slice(0, idx)) as TgFileKind;
    const fileId = idx === -1 ? "" : rest.slice(idx + 1);
    if (!fileId) return null;
    return { kind: parsedKind, source: fileId };
  }
  const kind = inferKindFromSlotMode(slot.mode);
  const url = v.startsWith("http") ? v : ((await getFileUrl(v)) ?? null);
  if (!url) return null;
  return { kind, source: new InputFile({ url }) };
}

/** Telegram media-group bucket: photo+video can mix, audio/document own buckets, voice never groups. */
type GroupBucket = "photo_video" | "audio" | "document" | "single";
function bucketFor(kind: TgFileKind): GroupBucket {
  if (kind === "photo" || kind === "video") return "photo_video";
  if (kind === "audio") return "audio";
  if (kind === "doc") return "document";
  return "single"; // voice
}

async function sendSingle(ctx: Context, chatId: number, item: ResolvedSlotItem): Promise<void> {
  const { kind, source } = item;
  if (kind === "photo") await ctx.api.sendPhoto(chatId, source);
  else if (kind === "video") await ctx.api.sendVideo(chatId, source);
  else if (kind === "audio") await ctx.api.sendAudio(chatId, source);
  else if (kind === "voice") await ctx.api.sendVoice(chatId, source);
  else await ctx.api.sendDocument(chatId, source);
}

async function sendBucket(
  ctx: Context,
  chatId: number,
  bucket: GroupBucket,
  items: ResolvedSlotItem[],
): Promise<void> {
  if (items.length === 1 || bucket === "single") {
    for (const item of items) {
      try {
        await sendSingle(ctx, chatId, item);
      } catch {
        // skip unresendable item
      }
    }
    return;
  }
  // Telegram media groups accept 2-10 items; chunk if needed.
  for (let i = 0; i < items.length; i += 10) {
    const chunk = items.slice(i, i + 10);
    if (chunk.length === 1) {
      try {
        await sendSingle(ctx, chatId, chunk[0]);
      } catch {
        /* skip */
      }
      continue;
    }
    try {
      if (bucket === "photo_video") {
        await ctx.api.sendMediaGroup(
          chatId,
          chunk.map((it) =>
            it.kind === "video"
              ? { type: "video", media: it.source }
              : { type: "photo", media: it.source },
          ),
        );
      } else if (bucket === "audio") {
        await ctx.api.sendMediaGroup(
          chatId,
          chunk.map((it) => ({ type: "audio", media: it.source })),
        );
      } else {
        await ctx.api.sendMediaGroup(
          chatId,
          chunk.map((it) => ({ type: "document", media: it.source })),
        );
      }
    } catch {
      // Fallback: send individually if media group failed (e.g. mixed legacy URLs).
      for (const item of chunk) {
        try {
          await sendSingle(ctx, chatId, item);
        } catch {
          /* skip */
        }
      }
    }
  }
}

/**
 * Sends slot contents back to the chat as a preview when the user taps a filled slot.
 * For `tg:{kind}:{fileId}` values uses file_id directly (no download). For legacy
 * URL/s3Key values, resolves to a URL and sends by InputFile.
 * Multiple compatible items (photos/videos, audio, documents) are batched into
 * a Telegram media group; voice messages are always sent individually.
 */
export async function sendSlotPreview(
  ctx: Context,
  slot: MediaInputSlot,
  values: string[],
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  // Resolve all items, then group consecutive compatible items into buckets.
  const resolved: ResolvedSlotItem[] = [];
  for (const v of values) {
    const item = await resolveSlotItem(v, slot);
    if (item) resolved.push(item);
  }
  if (!resolved.length) return;

  let currentBucket = bucketFor(resolved[0].kind);
  let currentChunk: ResolvedSlotItem[] = [];
  for (const item of resolved) {
    const b = bucketFor(item.kind);
    if (b !== currentBucket) {
      await sendBucket(ctx, chatId, currentBucket, currentChunk);
      currentChunk = [];
      currentBucket = b;
    }
    currentChunk.push(item);
  }
  if (currentChunk.length) await sendBucket(ctx, chatId, currentBucket, currentChunk);
}
