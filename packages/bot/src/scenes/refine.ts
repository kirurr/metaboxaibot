/**
 * Refine flow — "Доработать" button under generated images.
 *
 * Allows the user to load a generated image into a media input slot
 * of the active model, or choose a different model/section.
 *
 * Callback data formats (outputId = GenerationJobOutput cuid, ~25 chars):
 *   design_ref_{outputId}          — entry point
 *   ref_use:{outputId}             — use in active model
 *   ref_choose:{outputId}          — show section chooser
 *   ref_sec:{d|v}:{outputId}       — show families+singles for section
 *   ref_fam:{familyId}:{outputId}  — show family members submenu
 *   ref_mdl:{modelId}:{outputId}   — activate model
 *   ref_slt:{slotKey}:{outputId}   — pick slot (when model has multiple)
 */
import type { BotContext } from "../types/context.js";
import { generationService, userStateService } from "@metabox/api/services";
import {
  AI_MODELS,
  MODELS_BY_SECTION,
  FAMILIES_BY_SECTION,
  MODEL_FAMILIES,
  resolveModelDisplay,
  type MediaInputSlot,
} from "@metabox/shared";
import { InlineKeyboard } from "grammy";
import { activateVideoModel, sendVideoMediaInputStatus } from "./video.js";
import { activateDesignModel, sendDesignMediaInputStatus } from "./design.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Modes that accept a generated image for refinement, per section. */
const DESIGN_REFINE_MODES = new Set(["edit", "style_reference"]);
const VIDEO_REFINE_MODES = new Set(["first_frame", "last_frame", "reference"]);

function getCompatibleSlots(
  slots: MediaInputSlot[] | undefined,
  section: "design" | "video",
): MediaInputSlot[] {
  if (!slots?.length) return [];
  const modes = section === "design" ? DESIGN_REFINE_MODES : VIDEO_REFINE_MODES;
  return slots.filter((s) => modes.has(s.mode));
}

/**
 * Top-level refine keyboard: families (с хотя бы одним совместимым членом) +
 * standalone модели (без familyId, со совместимыми слотами). Layout — 2 в ряд,
 * как на обычном экране выбора модели. Family-кнопка ведёт в подменю
 * (`ref_fam:`), standalone — сразу активирует (`ref_mdl:`).
 */
function buildRefineFamilyOrModelKeyboard(
  section: "design" | "video",
  jobId: string,
  lang: string,
): InlineKeyboard {
  const allModels = MODELS_BY_SECTION[section] ?? [];
  const families = FAMILIES_BY_SECTION[section] ?? [];
  const familyModelIds = new Set(families.flatMap((f) => f.members.map((m) => m.modelId)));

  const buttons: Array<[string, string]> = [];

  // Families — добавляем только те, у которых есть compatible-член.
  for (const family of families) {
    const hasCompatibleMember = family.members.some((m) => {
      const model = AI_MODELS[m.modelId];
      return getCompatibleSlots(model?.mediaInputs, section).length > 0;
    });
    if (!hasCompatibleMember) continue;
    buttons.push([family.name, `ref_fam:${family.id}:${jobId}`]);
  }

  // Standalone — модели без familyId с compatible-слотами.
  for (const model of allModels) {
    if (familyModelIds.has(model.id)) continue;
    if (getCompatibleSlots(model.mediaInputs, section).length === 0) continue;
    const { name } = resolveModelDisplay(model.id, lang, model);
    buttons.push([name, `ref_mdl:${model.id}:${jobId}`]);
  }

  const kb = new InlineKeyboard();
  for (let i = 0; i < buttons.length; i += 2) {
    kb.text(buttons[i][0], buttons[i][1]);
    if (buttons[i + 1]) kb.text(buttons[i + 1][0], buttons[i + 1][1]);
    kb.row();
  }
  return kb;
}

/**
 * Подпись для кнопки члена семьи — берём `model.name` (с учётом локали через
 * `resolveModelDisplay`). В name уже зашита эмодзи + версия + вариант
 * («🍌 Nano Banana 2», «🎥 Kling 3.0 Pro»), это понятнее голых меток
 * versionLabel/variantLabel вроде «v3 Standard» без бренда.
 */
function familyMemberLabel(member: { modelId: string }, lang: string): string {
  const model = AI_MODELS[member.modelId];
  return model ? resolveModelDisplay(member.modelId, lang, model).name : member.modelId;
}

/** Подменю членов семьи с compatible-слотами. Layout 2 в ряд. */
function buildRefineFamilyMembersKeyboard(
  familyId: string,
  section: "design" | "video",
  jobId: string,
  lang: string,
): InlineKeyboard {
  const family = MODEL_FAMILIES[familyId];
  const kb = new InlineKeyboard();
  if (!family) return kb;

  const buttons: Array<[string, string]> = [];
  for (const member of family.members) {
    const model = AI_MODELS[member.modelId];
    if (!model) continue;
    if (getCompatibleSlots(model.mediaInputs, section).length === 0) continue;
    buttons.push([familyMemberLabel(member, lang), `ref_mdl:${member.modelId}:${jobId}`]);
  }

  for (let i = 0; i < buttons.length; i += 2) {
    kb.text(buttons[i][0], buttons[i][1]);
    if (buttons[i + 1]) kb.text(buttons[i + 1][0], buttons[i + 1][1]);
    kb.row();
  }
  return kb;
}

/** Save s3Key into a media input slot and send the updated status menu. */
async function fillSlotAndSendStatus(
  ctx: BotContext,
  modelId: string,
  slotKey: string,
  s3Key: string,
  section: "design" | "video",
): Promise<void> {
  if (!ctx.user) return;
  await userStateService.addMediaInput(ctx.user.id, modelId, slotKey, s3Key);
  if (section === "video") {
    await sendVideoMediaInputStatus(ctx);
  } else {
    await sendDesignMediaInputStatus(ctx);
  }
}

/** Show "choose which slot" inline buttons for a model with multiple compatible slots. */
async function showSlotChoice(
  ctx: BotContext,
  compatibleSlots: MediaInputSlot[],
  jobId: string,
): Promise<void> {
  const kb = new InlineKeyboard();
  for (const slot of compatibleSlots) {
    const label = ctx.t.mediaInput[slot.labelKey as keyof typeof ctx.t.mediaInput] ?? slot.labelKey;
    kb.text(label, `ref_slt:${slot.slotKey}:${jobId}`).row();
  }
  await ctx.editMessageText(ctx.t.mediaInput.refineChooseSlot, { reply_markup: kb });
}

// ── Entry point: design_ref_{jobId} ─────────────────────────────────────────

export async function handleRefineEntry(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const jobId = (ctx.callbackQuery?.data ?? "").replace("design_ref_", "");
  await ctx.answerCallbackQuery();

  // Fetch job to verify it exists and has s3Key
  const job = await generationService.getOutputById(jobId);
  if (!job?.s3Key) return;

  const state = await userStateService.get(ctx.user.id);
  const section = (state?.section ?? "design") as "design" | "video" | "gpt" | "audio";

  // Determine active model and check for compatible slots
  let activeModelId: string | null = null;
  let compatibleSlots: MediaInputSlot[] = [];

  if (section === "video") {
    activeModelId = state?.videoModelId ?? null;
    if (activeModelId) {
      const model = AI_MODELS[activeModelId];
      compatibleSlots = getCompatibleSlots(model?.mediaInputs, "video");
    }
  } else if (section === "design") {
    activeModelId = state?.designModelId ?? null;
    if (activeModelId) {
      const model = AI_MODELS[activeModelId];
      compatibleSlots = getCompatibleSlots(model?.mediaInputs, "design");
    }
  }

  if (activeModelId && compatibleSlots.length > 0) {
    // Step 2a: active model supports — ask user
    const model = AI_MODELS[activeModelId]!;
    const { name: modelName } = resolveModelDisplay(
      activeModelId,
      ctx.user.language ?? "en",
      model,
    );
    const text = ctx.t.mediaInput.refineUseActive.replace("{model}", modelName);
    const kb = new InlineKeyboard()
      .text(ctx.t.mediaInput.refineActiveLabel.replace("{model}", modelName), `ref_use:${jobId}`)
      .row()
      .text(ctx.t.mediaInput.refineChooseModel, `ref_choose:${jobId}`);
    await ctx.reply(text, { reply_markup: kb });
  } else {
    // Step 2b: active model doesn't support
    const kb = new InlineKeyboard()
      .text(ctx.t.mediaInput.refineDesign, `ref_sec:d:${jobId}`)
      .text(ctx.t.mediaInput.refineVideo, `ref_sec:v:${jobId}`);
    await ctx.reply(ctx.t.mediaInput.refineNoSupport, { reply_markup: kb });
  }
}

// ── ref_use:{jobId} — use in active model ────────────────────────────────────

export async function handleRefineUseActive(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const jobId = (ctx.callbackQuery?.data ?? "").replace("ref_use:", "");
  await ctx.answerCallbackQuery();

  const job = await generationService.getOutputById(jobId);
  if (!job?.s3Key) return;

  const state = await userStateService.get(ctx.user.id);
  const section = (state?.section ?? "design") as "design" | "video";
  const activeModelId =
    section === "video" ? (state?.videoModelId ?? null) : (state?.designModelId ?? null);
  if (!activeModelId) return;

  const model = AI_MODELS[activeModelId];
  const compatibleSlots = getCompatibleSlots(model?.mediaInputs, section);

  if (compatibleSlots.length === 1) {
    // Single slot — fill directly
    await fillSlotAndSendStatus(ctx, activeModelId, compatibleSlots[0].slotKey, job.s3Key, section);
  } else if (compatibleSlots.length > 1) {
    // Multiple slots — ask which one
    await showSlotChoice(ctx, compatibleSlots, jobId);
  }
}

// ── ref_choose:{jobId} — show section buttons ───────────────────────────────

export async function handleRefineChooseModel(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const jobId = (ctx.callbackQuery?.data ?? "").replace("ref_choose:", "");
  await ctx.answerCallbackQuery();

  const kb = new InlineKeyboard()
    .text(ctx.t.mediaInput.refineDesign, `ref_sec:d:${jobId}`)
    .text(ctx.t.mediaInput.refineVideo, `ref_sec:v:${jobId}`);
  await ctx.editMessageText(ctx.t.mediaInput.refineNoSupport, { reply_markup: kb });
}

// ── ref_sec:{d|v}:{jobId} — show families+singles for section ───────────────

export async function handleRefineSection(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const data = (ctx.callbackQuery?.data ?? "").replace("ref_sec:", "");
  const sectionCode = data[0]; // "d" or "v"
  const jobId = data.slice(2);
  await ctx.answerCallbackQuery();

  const section: "design" | "video" = sectionCode === "v" ? "video" : "design";
  const lang = ctx.user.language ?? "en";
  const kb = buildRefineFamilyOrModelKeyboard(section, jobId, lang);

  if (!kb.inline_keyboard.length) {
    // No families/standalone models with compatible slots — shouldn't happen.
    await ctx.editMessageText(ctx.t.mediaInput.refineNoSupport);
    return;
  }
  await ctx.editMessageText(ctx.t.mediaInput.refineChooseModel, { reply_markup: kb });
}

// ── ref_fam:{familyId}:{jobId} — show family members submenu ────────────────

export async function handleRefineFamily(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const data = (ctx.callbackQuery?.data ?? "").replace("ref_fam:", "");
  const sepIdx = data.lastIndexOf(":");
  const familyId = data.slice(0, sepIdx);
  const jobId = data.slice(sepIdx + 1);
  await ctx.answerCallbackQuery();

  const family = MODEL_FAMILIES[familyId];
  if (!family) {
    await ctx.editMessageText(ctx.t.mediaInput.refineNoSupport);
    return;
  }
  const section = family.section as "design" | "video";
  const lang = ctx.user.language ?? "en";
  const kb = buildRefineFamilyMembersKeyboard(familyId, section, jobId, lang);

  if (!kb.inline_keyboard.length) {
    await ctx.editMessageText(ctx.t.mediaInput.refineNoSupport);
    return;
  }
  await ctx.editMessageText(ctx.t.mediaInput.refineChooseModel, { reply_markup: kb });
}

// ── ref_mdl:{modelId}:{jobId} — activate model ─────────────────────────────

export async function handleRefineModel(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const data = (ctx.callbackQuery?.data ?? "").replace("ref_mdl:", "");
  // modelId may contain colons? No — model IDs are alphanumeric+hyphens.
  // Format: {modelId}:{jobId}
  const sepIdx = data.lastIndexOf(":");
  const modelId = data.slice(0, sepIdx);
  const jobId = data.slice(sepIdx + 1);
  await ctx.answerCallbackQuery();

  const job = await generationService.getOutputById(jobId);
  if (!job?.s3Key) return;

  const model = AI_MODELS[modelId];
  if (!model) return;

  const section = model.section as "design" | "video";
  const compatibleSlots = getCompatibleSlots(model.mediaInputs, section);
  if (compatibleSlots.length === 0) return;

  // Delete the chooser message
  await ctx.deleteMessage().catch(() => void 0);

  // If section is changing, swap the persistent bottom reply keyboard.
  const state = await userStateService.get(ctx.user.id);
  const prevSection = state?.section;
  const crossingSections = prevSection !== section;

  // Activate the model (sends activation message with hints).
  // Suppress the inline keyboard — the status menu sent next carries the
  // unified media-input + management keyboard. When crossing sections,
  // attach the section's persistent bottom reply keyboard to the activation msg.
  if (section === "video") {
    await activateVideoModel(ctx, modelId, {
      suppressKeyboard: true,
      sectionReplyKeyboard: crossingSections,
    });
  } else {
    await activateDesignModel(ctx, modelId, {
      suppressKeyboard: true,
      sectionReplyKeyboard: crossingSections,
    });
  }

  // Fill the slot
  if (compatibleSlots.length === 1) {
    await userStateService.addMediaInput(
      ctx.user.id,
      modelId,
      compatibleSlots[0].slotKey,
      job.s3Key,
    );
    if (section === "video") {
      await sendVideoMediaInputStatus(ctx);
    } else {
      await sendDesignMediaInputStatus(ctx);
    }
  } else {
    // Multiple compatible slots — ask which one
    const kb = new InlineKeyboard();
    for (const slot of compatibleSlots) {
      const label =
        ctx.t.mediaInput[slot.labelKey as keyof typeof ctx.t.mediaInput] ?? slot.labelKey;
      kb.text(label, `ref_slt:${slot.slotKey}:${jobId}`).row();
    }
    await ctx.reply(ctx.t.mediaInput.refineChooseSlot, { reply_markup: kb });
  }
}

// ── ref_slt:{slotKey}:{jobId} — pick slot ───────────────────────────────────

export async function handleRefineSlot(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const data = (ctx.callbackQuery?.data ?? "").replace("ref_slt:", "");
  const sepIdx = data.lastIndexOf(":");
  const slotKey = data.slice(0, sepIdx);
  const jobId = data.slice(sepIdx + 1);
  await ctx.answerCallbackQuery();

  const job = await generationService.getOutputById(jobId);
  if (!job?.s3Key) return;

  const state = await userStateService.get(ctx.user.id);
  const section = (state?.section ?? "design") as "design" | "video";
  const modelId =
    section === "video" ? (state?.videoModelId ?? null) : (state?.designModelId ?? null);
  if (!modelId) return;

  // Remove the slot chooser keyboard
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => void 0);

  await fillSlotAndSendStatus(ctx, modelId, slotKey, job.s3Key, section);
}
