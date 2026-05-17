import { Prisma } from "@prisma/client";
import { db } from "../db.js";
import type { BotState, Section } from "@metabox/shared";
import type { UserState } from "@prisma/client";

/** Maps a section name to the corresponding UserState dialog-ID field. */
function dialogField(
  section: Section,
): "gptDialogId" | "designDialogId" | "audioDialogId" | "videoDialogId" {
  const map = {
    gpt: "gptDialogId",
    design: "designDialogId",
    audio: "audioDialogId",
    video: "videoDialogId",
  } as const;
  return map[section];
}

/** Maps a media section to the corresponding UserState model-ID field. */
function sectionModelField(
  section: "design" | "audio" | "video",
): "designModelId" | "audioModelId" | "videoModelId" {
  const map = {
    design: "designModelId",
    audio: "audioModelId",
    video: "videoModelId",
  } as const;
  return map[section];
}

export const userStateService = {
  async get(userId: bigint): Promise<UserState | null> {
    return db.userState.findUnique({ where: { userId } });
  },

  async setState(userId: bigint, state: BotState, section?: Section | null): Promise<UserState> {
    return db.userState.upsert({
      where: { userId },
      create: { userId, state, section: section ?? null },
      update: { state, ...(section !== undefined ? { section } : {}) },
    });
  },

  async setDialogForSection(
    userId: bigint,
    section: Section,
    dialogId: string | null,
  ): Promise<void> {
    const field = dialogField(section);
    await db.userState.upsert({
      where: { userId },
      create: { userId, state: "IDLE", [field]: dialogId },
      update: { [field]: dialogId },
    });
  },

  /** Returns the active dialogId for a given section, or null. */
  async getDialogForSection(userId: bigint, section: Section): Promise<string | null> {
    const state = await db.userState.findUnique({ where: { userId } });
    if (!state) return null;
    return state[dialogField(section)] ?? null;
  },

  async setGptModel(userId: bigint, modelId: string): Promise<void> {
    await db.userState.upsert({
      where: { userId },
      create: { userId, state: "IDLE", gptModelId: modelId },
      update: { gptModelId: modelId },
    });
  },

  /** Saves the selected model for a media section (design/audio/video) independently. */
  async setModelForSection(
    userId: bigint,
    section: "design" | "audio" | "video",
    modelId: string,
  ): Promise<void> {
    const field = sectionModelField(section);
    await db.userState.upsert({
      where: { userId },
      create: { userId, state: "IDLE", [field]: modelId },
      update: { [field]: modelId },
    });
  },

  /** Set (or clear) the design reference message for img2img. Null = clear. */
  async setDesignRefMessage(userId: bigint, messageId: string | null): Promise<void> {
    await db.userState.upsert({
      where: { userId },
      create: { userId, state: "IDLE", designRefMessageId: messageId },
      update: { designRefMessageId: messageId },
    });
  },

  /** Save a Telegram photo URL as the D-ID lip-sync reference (one-shot). */
  async setVideoRefImageUrl(userId: bigint, url: string): Promise<void> {
    await db.userState.upsert({
      where: { userId },
      create: { userId, state: "IDLE", videoRefImageUrl: url },
      update: { videoRefImageUrl: url },
    });
  },

  /** Retrieve and clear the saved video ref image URL (one-shot). Returns null if not set. */
  async getAndClearVideoRefImageUrl(userId: bigint): Promise<string | null> {
    const state = await db.userState.findUnique({ where: { userId } });
    if (!state?.videoRefImageUrl) return null;
    await db.userState.update({ where: { userId }, data: { videoRefImageUrl: null } });
    return state.videoRefImageUrl;
  },

  /** Save a Telegram video URL as the D-ID driver_url reference (one-shot). */
  async setVideoRefDriverUrl(userId: bigint, url: string): Promise<void> {
    await db.userState.upsert({
      where: { userId },
      create: { userId, state: "IDLE", videoRefDriverUrl: url },
      update: { videoRefDriverUrl: url },
    });
  },

  /** Retrieve and clear the saved driver video URL (one-shot). Returns null if not set. */
  async getAndClearVideoRefDriverUrl(userId: bigint): Promise<string | null> {
    const state = await db.userState.findUnique({ where: { userId } });
    if (!state?.videoRefDriverUrl) return null;
    await db.userState.update({ where: { userId }, data: { videoRefDriverUrl: null } });
    return state.videoRefDriverUrl;
  },

  /** Save a Telegram voice message URL as the HeyGen audio voice source (one-shot). */
  async setVideoRefVoiceUrl(userId: bigint, url: string): Promise<void> {
    await db.userState.upsert({
      where: { userId },
      create: { userId, state: "IDLE", videoRefVoiceUrl: url },
      update: { videoRefVoiceUrl: url },
    });
  },

  /** Retrieve and clear the saved voice URL (one-shot). Returns null if not set. */
  async getAndClearVideoRefVoiceUrl(userId: bigint): Promise<string | null> {
    const state = await db.userState.findUnique({ where: { userId } });
    if (!state?.videoRefVoiceUrl) return null;
    await db.userState.update({ where: { userId }, data: { videoRefVoiceUrl: null } });
    return state.videoRefVoiceUrl;
  },

  /**
   * Сохранить длительность только что загруженного в HeyGen voice_audio слот
   * аудио (в секундах). Перезаписывается на каждой новой загрузке. НЕ
   * очищается на submit — `hasVoiceAudio` guard в боте отсекает stale значения
   * когда в submit'е mediaInputs.voice_audio пуст.
   */
  async setVideoVoiceDurationSec(userId: bigint, durationSec: number): Promise<void> {
    // Defensive: только положительные значения. Если caller передал 0/отриц./NaN —
    // это сигнал «нечего стэшить», эквивалент clear (иначе stale 0 в DB подсунул
    // бы фейковый hint=0 в cost-preview).
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      await this.clearVideoVoiceDurationSec(userId);
      return;
    }
    await db.userState.upsert({
      where: { userId },
      create: { userId, state: "IDLE", videoVoiceDurationSec: durationSec },
      update: { videoVoiceDurationSec: durationSec },
    });
  },

  /** Прочитать сохранённую длительность; null если не задана. */
  async getVideoVoiceDurationSec(userId: bigint): Promise<number | null> {
    const state = await db.userState.findUnique({ where: { userId } });
    return state?.videoVoiceDurationSec ?? null;
  },

  /** Сбросить (явно). Используется когда rawVoiceS3Key override подменяет
   *  слот-voice — иначе подсунули бы duration от старого файла к новому. */
  async clearVideoVoiceDurationSec(userId: bigint): Promise<void> {
    const state = await db.userState.findUnique({
      where: { userId },
      select: { videoVoiceDurationSec: true },
    });
    if (state?.videoVoiceDurationSec == null) return;
    await db.userState.update({ where: { userId }, data: { videoVoiceDurationSec: null } });
  },

  /** Returns per-model image settings: { [modelId]: { aspectRatio: string } } */
  async getImageSettings(userId: bigint): Promise<Record<string, { aspectRatio: string }>> {
    const state = await db.userState.findUnique({ where: { userId } });
    if (!state?.imageSettings) return {};
    return state.imageSettings as Record<string, { aspectRatio: string }>;
  },

  /** Saves the aspect ratio for a specific model without touching other models' settings. */
  async setImageAspectRatio(userId: bigint, modelId: string, aspectRatio: string): Promise<void> {
    const current = await this.getImageSettings(userId);
    const updated = { ...current, [modelId]: { aspectRatio } };
    await db.userState.upsert({
      where: { userId },
      create: { userId, state: "IDLE", imageSettings: updated },
      update: { imageSettings: updated },
    });
  },

  /** Returns per-model video settings: { [modelId]: { aspectRatio?: string; duration?: number } } */
  async getVideoSettings(
    userId: bigint,
  ): Promise<Record<string, { aspectRatio?: string; duration?: number }>> {
    const state = await db.userState.findUnique({ where: { userId } });
    if (!state?.videoSettings) return {};
    return state.videoSettings as Record<string, { aspectRatio?: string; duration?: number }>;
  },

  /** Saves aspectRatio and/or duration for a video model, merging with existing settings. */
  async setVideoSetting(
    userId: bigint,
    modelId: string,
    patch: { aspectRatio?: string; duration?: number },
  ): Promise<void> {
    const current = await this.getVideoSettings(userId);
    const existing = current[modelId] ?? {};
    const updated = { ...current, [modelId]: { ...existing, ...patch } };
    await db.userState.upsert({
      where: { userId },
      create: { userId, state: "IDLE", videoSettings: updated },
      update: { videoSettings: updated },
    });
  },

  /** Returns all per-model custom settings for a user. */
  async getModelSettings(userId: bigint): Promise<Record<string, Record<string, unknown>>> {
    const state = await db.userState.findUnique({ where: { userId } });
    if (!state?.modelSettings) return {};
    return state.modelSettings as Record<string, Record<string, unknown>>;
  },

  /** Merges the given key/value pairs into the stored settings for a specific model.
   *
   * Uses a single atomic SQL upsert with jsonb concatenation (||) to avoid
   * the lost-update race condition of a read-modify-write cycle. The merge is:
   *   modelSettings = COALESCE(modelSettings, '{}') || { modelId: COALESCE(modelSettings->modelId, '{}') || settings }
   */
  async setModelSettings(
    userId: bigint,
    modelId: string,
    settings: Record<string, unknown>,
    opts?: { replace?: boolean },
  ): Promise<void> {
    const settingsJson = JSON.stringify(settings);
    if (opts?.replace) {
      // Full replace: overwrite modelSettings[modelId] with the incoming
      // object (keys not listed are dropped). Used by "Apply settings" from
      // the gallery so stale per-key overrides don't leak through.
      await db.$executeRaw`
        INSERT INTO user_states ("userId", "state", "modelSettings", "updatedAt")
        VALUES (
          ${userId},
          'IDLE',
          jsonb_build_object(${modelId}::text, ${settingsJson}::jsonb),
          NOW()
        )
        ON CONFLICT ("userId") DO UPDATE
        SET "modelSettings" = COALESCE(user_states."modelSettings", '{}'::jsonb)
          || jsonb_build_object(${modelId}::text, ${settingsJson}::jsonb),
            "updatedAt" = NOW()
      `;
      return;
    }
    // Default: atomic jsonb merge — deep-merge into modelSettings[modelId]
    // without reading the current value first.
    await db.$executeRaw`
      INSERT INTO user_states ("userId", "state", "modelSettings", "updatedAt")
      VALUES (
        ${userId},
        'IDLE',
        jsonb_build_object(${modelId}::text, ${settingsJson}::jsonb),
        NOW()
      )
      ON CONFLICT ("userId") DO UPDATE
      SET "modelSettings" = COALESCE(user_states."modelSettings", '{}'::jsonb)
        || jsonb_build_object(
             ${modelId}::text,
             COALESCE(user_states."modelSettings"->${modelId}, '{}'::jsonb)
               || ${settingsJson}::jsonb
           ),
          "updatedAt" = NOW()
    `;
  },

  // ── Per-dialog settings ──────────────────────────────────────────────────
  // Stored in the same modelSettings JSON under key "dialog:<dialogId>".

  dialogSettingsKey(dialogId: string): string {
    return `dialog:${dialogId}`;
  },

  async getDialogSettings(userId: bigint, dialogId: string): Promise<Record<string, unknown>> {
    const all = await this.getModelSettings(userId);
    return all[this.dialogSettingsKey(dialogId)] ?? {};
  },

  async setDialogSettings(
    userId: bigint,
    dialogId: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    await this.setModelSettings(userId, this.dialogSettingsKey(dialogId), settings);
  },

  async deleteDialogSettings(userId: bigint, dialogId: string): Promise<void> {
    const key = this.dialogSettingsKey(dialogId);
    await db.$executeRaw`
      UPDATE user_states
      SET "modelSettings" = COALESCE("modelSettings", '{}'::jsonb) - ${key}::text,
          "updatedAt" = NOW()
      WHERE "userId" = ${userId}
    `;
  },

  /**
   * Resolves effective settings for a dialog: dialog-level overrides merged
   * on top of model-level defaults. Callers get a single flat object.
   */
  async getEffectiveDialogSettings(
    userId: bigint,
    dialogId: string,
    modelId: string,
  ): Promise<Record<string, unknown>> {
    const all = await this.getModelSettings(userId);
    const modelLevel = all[modelId] ?? {};
    const dialogLevel = all[this.dialogSettingsKey(dialogId)] ?? {};
    return { ...modelLevel, ...dialogLevel };
  },

  // ── Media inputs (per-model, slot-based) ───────────────────────────────────
  // Storage shape: { [modelId]: { [slotKey]: string[] } }
  // Slots persist across model/section switches — only cleared on generation
  // start (for the active model) or explicit user removal.

  /** Full root map. Legacy flat-shape values are ignored (treated as empty). */
  async getAllMediaInputs(userId: bigint): Promise<Record<string, Record<string, string[]>>> {
    const state = await db.userState.findUnique({ where: { userId } });
    const raw = state?.mediaInputs;
    if (!raw || typeof raw !== "object") return {};
    const result: Record<string, Record<string, string[]>> = {};
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        result[key] = val as Record<string, string[]>;
      }
    }
    return result;
  },

  /** Add a URL to a media input slot for the given model. Returns the updated map for that model. */
  async addMediaInput(
    userId: bigint,
    modelId: string,
    slotKey: string,
    url: string,
    overflow?: boolean,
  ): Promise<Record<string, string[]>> {
    const all = await this.getAllMediaInputs(userId);
    const forModel = all[modelId] ?? {};
    const forSlot = forModel[slotKey] ?? [];
    if (overflow) {
      forSlot.splice(0, 1);
    }
    forSlot.push(url);
    const updatedForModel = { ...forModel, [slotKey]: [...forSlot] };
    const updated = { ...all, [modelId]: updatedForModel };
    await db.userState.upsert({
      where: { userId },
      create: { userId, state: "IDLE", mediaInputs: updated },
      update: { mediaInputs: updated },
    });
    return updatedForModel;
  },

  /** Get media inputs for a specific model: { [slotKey]: string[] } */
  async getMediaInputs(userId: bigint, modelId: string): Promise<Record<string, string[]>> {
    const all = await this.getAllMediaInputs(userId);
    return all[modelId] ?? {};
  },

  /**
   * Bulk-set raw slot values for a model (used by low-iq mode Cancel-restore).
   * Empty/undefined slots clears the model entry. Pass raw `tg:fileId:...` /
   * S3-key strings — same shape as what `getMediaInputs` returns.
   */
  async setMediaInputsForModel(
    userId: bigint,
    modelId: string,
    slots: Record<string, string[]> | undefined,
  ): Promise<void> {
    const all = await this.getAllMediaInputs(userId);
    if (!slots || Object.keys(slots).length === 0) {
      delete all[modelId];
    } else {
      all[modelId] = slots;
    }
    const hasAny = Object.keys(all).length > 0;
    await db.userState.upsert({
      where: { userId },
      create: {
        userId,
        state: "IDLE",
        mediaInputs: hasAny ? all : Prisma.DbNull,
      },
      update: { mediaInputs: hasAny ? all : Prisma.DbNull },
    });
  },

  /** Clear all media input slots for a specific model (e.g. after generation start). */
  async clearMediaInputs(userId: bigint, modelId: string): Promise<void> {
    const all = await this.getAllMediaInputs(userId);
    if (!all[modelId]) return;
    delete all[modelId];
    const hasAny = Object.keys(all).length > 0;
    await db.userState.update({
      where: { userId },
      data: { mediaInputs: hasAny ? all : Prisma.DbNull },
    });
  },

  // ── Selected mode (per-model) ─────────────────────────────────────────────
  // Storage shape: { [modelId]: modeId }. Used for models with `modes` defined.

  /** Returns the full { modelId: modeId } map. Empty object when nothing saved. */
  async getSelectedModes(userId: bigint): Promise<Record<string, string>> {
    const state = await db.userState.findUnique({ where: { userId } });
    const raw = state?.selectedModes;
    if (!raw || typeof raw !== "object") return {};
    const result: Record<string, string> = {};
    for (const [modelId, modeId] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof modeId === "string") result[modelId] = modeId;
    }
    return result;
  },

  /** Returns the saved mode id for a specific model, or null. */
  async getSelectedMode(userId: bigint, modelId: string): Promise<string | null> {
    const all = await this.getSelectedModes(userId);
    return all[modelId] ?? null;
  },

  /** Persist the chosen mode for a specific model. Pass null to clear. */
  async setSelectedMode(userId: bigint, modelId: string, modeId: string | null): Promise<void> {
    const all = await this.getSelectedModes(userId);
    if (modeId == null) {
      delete all[modelId];
    } else {
      all[modelId] = modeId;
    }
    const hasAny = Object.keys(all).length > 0;
    await db.userState.upsert({
      where: { userId },
      create: { userId, state: "IDLE", selectedModes: hasAny ? all : Prisma.DbNull },
      update: { selectedModes: hasAny ? all : Prisma.DbNull },
    });
  },

  /** Clear a specific slot for a specific model. */
  async clearMediaInputSlot(userId: bigint, modelId: string, slotKey: string): Promise<void> {
    const all = await this.getAllMediaInputs(userId);
    const forModel = all[modelId];
    if (!forModel) return;
    delete forModel[slotKey];
    if (Object.keys(forModel).length === 0) delete all[modelId];
    else all[modelId] = forModel;
    const hasAny = Object.keys(all).length > 0;
    await db.userState.update({
      where: { userId },
      data: { mediaInputs: hasAny ? all : Prisma.DbNull },
    });
  },
};
