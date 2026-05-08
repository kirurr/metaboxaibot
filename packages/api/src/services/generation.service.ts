import { db } from "../db.js";
import { getImageQueue } from "../queues/image.queue.js";
import { AI_MODELS, ONE_SHOT_SETTING_KEYS, UserFacingError } from "@metabox/shared";
import { checkBalance } from "./token.service.js";
import { costPreviewService } from "./cost-preview.service.js";

/**
 * Strip one-shot (per-generation) fields from a `modelSettings` snapshot
 * before persisting it into `GenerationJob.inputData.modelSettings`. The
 * runtime object passed to queue workers is left untouched — only the
 * history copy is sanitised so stale upload URLs don't pollute the
 * gallery's "Apply settings" flow.
 */
function stripOneShotKeys(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (ONE_SHOT_SETTING_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface SubmitImageParams {
  userId: bigint;
  modelId: string;
  prompt: string;
  negativePrompt?: string;
  sourceImageUrl?: string;
  /** Named media input slots: { [slotKey]: string[] } */
  mediaInputs?: Record<string, string[]>;
  telegramChatId: number;
  /** If set, user/assistant messages are saved to this dialog for img2img context. */
  dialogId?: string;
  /** Pre-translated label for the "Send as file" inline button. */
  sendOriginalLabel?: string;
  /** Aspect ratio chosen by user, e.g. "16:9", "1:1". */
  aspectRatio?: string;
  /** "{chatId}:{messageId}" of the inline button that triggered this job. Used for dedup. */
  sourceMessageId?: string;
  /** Telegram message_id of the user's prompt — worker replies to it when sending the result. */
  promptMessageId?: number;
}

export interface SubmitImageResult {
  dbJobId: string;
}

export const generationService = {
  async hasActiveJobForSource(userId: bigint, sourceMessageId: string): Promise<boolean> {
    const existing = await db.generationJob.findFirst({
      where: { userId, sourceMessageId, status: { in: ["pending", "processing"] } },
      select: { id: true },
    });
    return existing !== null;
  },

  /**
   * Fetch a generation output by ID (for refine / download buttons).
   * Also supports legacy jobId lookup (old buttons sent before migration).
   */
  async getOutputById(
    id: string,
  ): Promise<{ s3Key: string | null; modelId: string; section: string } | null> {
    // Try as output ID first
    let output = await db.generationJobOutput.findUnique({
      where: { id },
      include: { job: { select: { modelId: true, section: true } } },
    });
    if (output) {
      return { s3Key: output.s3Key, modelId: output.job.modelId, section: output.job.section };
    }

    // Fallback: treat as jobId (for old buttons sent before migration)
    output = await db.generationJobOutput.findFirst({
      where: { jobId: id, index: 0 },
      include: { job: { select: { modelId: true, section: true } } },
    });
    if (output) {
      return { s3Key: output.s3Key, modelId: output.job.modelId, section: output.job.section };
    }

    return null;
  },

  async submitImage(params: SubmitImageParams): Promise<SubmitImageResult> {
    const {
      userId,
      modelId,
      prompt,
      negativePrompt,
      sourceImageUrl,
      telegramChatId,
      dialogId,
      sendOriginalLabel,
    } = params;

    const model = AI_MODELS[modelId];
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    // Pre-validate: if user attached a photo (legacy sourceImageUrl or any
    // populated mediaInputs slot) but the model is text-only, bounce with a
    // friendly message instead of submitting a job that the provider will
    // reject downstream (e.g. Replicate Imagen "Unexpected field 'image'").
    const hasImageInput =
      Boolean(sourceImageUrl) ||
      Object.values(params.mediaInputs ?? {}).some((arr) => arr.length > 0);
    if (hasImageInput && !model.supportsImages) {
      throw new UserFacingError(`Model ${modelId} does not accept image inputs`, {
        key: "modelDoesNotSupportImages",
        params: { modelName: model.name },
      });
    }

    const preview = await costPreviewService.previewImage(params);
    const modelSettings = preview.effectiveModelSettings;
    const effectiveAspectRatio = preview.effectiveAspectRatio;
    const numImages = preview.numImages;

    await checkBalance(userId, preview.cost);

    const job = await db.generationJob.create({
      data: {
        userId,
        dialogId: dialogId ?? "",
        section: "image",
        modelId,
        prompt,
        inputData: {
          ...(negativePrompt ? { negativePrompt } : {}),
          ...(params.mediaInputs ? { mediaInputs: params.mediaInputs } : {}),
          ...(() => {
            const historySettings = stripOneShotKeys(modelSettings as Record<string, unknown>);
            return Object.keys(historySettings).length > 0
              ? {
                  modelSettings: historySettings as Record<
                    string,
                    string | number | boolean | null
                  >,
                }
              : {};
          })(),
          // Persist `n` для virtual-batch воркера: чтобы после restart'а воркер
          // знал сколько sub-job'ов запускать без перечитывания userState.
          ...(numImages > 1 ? { batch: { n: numImages } } : {}),
        },
        status: "pending",
        ...(params.sourceMessageId ? { sourceMessageId: params.sourceMessageId } : {}),
      },
    });

    const queue = getImageQueue();
    await queue.add(
      "generate",
      {
        dbJobId: job.id,
        userId: userId.toString(),
        modelId,
        prompt,
        negativePrompt,
        sourceImageUrl,
        mediaInputs: params.mediaInputs,
        telegramChatId,
        dialogId,
        sendOriginalLabel,
        aspectRatio: effectiveAspectRatio,
        modelSettings,
        ...(numImages > 1 ? { numImages } : {}),
        ...(params.promptMessageId ? { promptMessageId: params.promptMessageId } : {}),
      },
      {
        jobId: job.id,
        removeOnComplete: true,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    );

    return { dbJobId: job.id };
  },
};
