import type { Prisma } from "@prisma/client";
import { getImageQueue, getVideoQueue, getAudioQueue, getAvatarQueue } from "@metabox/api/queues";
import type { Queue } from "bullmq";
import { logger } from "../logger.js";

interface GenerationInputData {
  negativePrompt?: string;
  mediaInputs?: Record<string, string[]>;
  modelSettings?: Record<string, unknown>;
  imageUrl?: string;
  /** Scenario-masking overrides (Face Swap и пр.), персистятся в БД из generation.service.ts. */
  displayNameOverride?: string;
  hidePromptInCaption?: boolean;
  hideRefineButton?: boolean;
}

export type GenerationJobRow = {
  id: string;
  userId: bigint;
  section: string;
  modelId: string;
  prompt: string;
  inputData: Prisma.JsonValue | null;
  providerJobId: string | null;
  pollStartedAt: Date | null;
  dialogId: string;
};

export type UserAvatarRow = {
  id: string;
  userId: bigint;
  provider: string;
  externalId: string | null;
  providerKeyId: string | null;
};

function getGenerationQueue(section: string): Queue | null {
  if (section === "image") return getImageQueue();
  if (section === "video") return getVideoQueue();
  if (section === "audio") return getAudioQueue();
  return null;
}

/**
 * Re-enqueues a GenerationJob stuck in pending/processing (e.g. after Redis data loss).
 * Uses jobId = dbJobId so BullMQ native dedup silently skips if the job is already
 * in the queue (active/waiting/delayed) — safe to call on every startup and from watchdog.
 *
 * `delayMs` (optional): postpone the job by this many milliseconds. Use a small
 * random jitter from reconcile to avoid hammering providers with N parallel
 * submissions after long downtime.
 */
export async function requeueGenerationJob(job: GenerationJobRow, delayMs?: number): Promise<void> {
  const queue = getGenerationQueue(job.section);
  if (!queue) {
    logger.warn({ dbJobId: job.id, section: job.section }, "requeue: unknown section, skipping");
    return;
  }

  const existing = await queue.getJob(job.id);
  if (existing) {
    logger.debug(
      { dbJobId: job.id, section: job.section },
      "requeue: job already in queue, skipping",
    );
    return;
  }

  const inputData = (job.inputData ?? {}) as unknown as GenerationInputData;
  const telegramChatId = Number(job.userId);
  const stage = job.providerJobId ? "poll" : "generate";
  const backoffDelay = job.section === "video" ? 10000 : 5000;
  // Восстанавливаем оригинальный момент старта polling — иначе после Redis
  // wipe 24ч-таймаут стартует с нуля и legitimate-зависший провайдер живёт ещё сутки.
  const pollStartedAt = job.pollStartedAt?.getTime() ?? Date.now();

  const opts = {
    jobId: job.id,
    removeOnComplete: true,
    attempts: 3,
    backoff: { type: "exponential" as const, delay: backoffDelay },
    ...(delayMs !== undefined ? { delay: delayMs } : {}),
  };

  if (job.section === "image") {
    await queue.add(
      stage,
      {
        dbJobId: job.id,
        userId: job.userId.toString(),
        modelId: job.modelId,
        prompt: job.prompt,
        negativePrompt: inputData.negativePrompt,
        mediaInputs: inputData.mediaInputs,
        telegramChatId,
        dialogId: job.dialogId,
        modelSettings: inputData.modelSettings,
        stage,
        ...(stage === "poll" ? { pollStartedAt } : {}),
        // Restore scenario-masking overrides — без этого после Redis-wipe юзер
        // получит результат с реальным именем модели, оригинальным промптом и
        // активной кнопкой «Доработать».
        ...(inputData.displayNameOverride
          ? { displayNameOverride: inputData.displayNameOverride }
          : {}),
        ...(inputData.hidePromptInCaption ? { hidePromptInCaption: true } : {}),
        ...(inputData.hideRefineButton ? { hideRefineButton: true } : {}),
      },
      opts,
    );
    return;
  }

  if (job.section === "video") {
    await queue.add(
      stage,
      {
        dbJobId: job.id,
        userId: job.userId.toString(),
        modelId: job.modelId,
        prompt: job.prompt,
        imageUrl: inputData.imageUrl,
        mediaInputs: inputData.mediaInputs,
        telegramChatId,
        modelSettings: inputData.modelSettings ?? {},
        stage,
        ...(stage === "poll" ? { pollStartedAt } : {}),
        ...(inputData.hidePromptInCaption ? { hidePromptInCaption: true } : {}),
      },
      opts,
    );
    return;
  }

  if (job.section === "audio") {
    await queue.add(
      stage,
      {
        dbJobId: job.id,
        userId: job.userId.toString(),
        modelId: job.modelId,
        prompt: job.prompt,
        telegramChatId,
        modelSettings: inputData.modelSettings ?? {},
        stage,
        ...(stage === "poll" ? { pollStartedAt } : {}),
      },
      opts,
    );
  }
}

/**
 * Re-enqueues the poll action for a UserAvatar stuck in 'creating' state.
 * Uses jobId = userAvatarId for native BullMQ dedup — safe on every startup.
 */
export async function requeueAvatarPoll(avatar: UserAvatarRow): Promise<void> {
  if (!avatar.externalId) return;

  const queue = getAvatarQueue();
  const existing = await queue.getJob(avatar.id);
  if (existing) {
    logger.debug({ userAvatarId: avatar.id }, "requeue: avatar job already in queue, skipping");
    return;
  }

  await queue.add(
    "poll",
    {
      userAvatarId: avatar.id,
      userId: avatar.userId.toString(),
      provider: avatar.provider,
      action: "poll",
      telegramChatId: Number(avatar.userId),
      pollAttempt: 0,
    },
    {
      jobId: avatar.id,
      removeOnComplete: true,
      // Transient network blip к провайдеру не должен убивать recovery —
      // даём BullMQ-уровневые retries как у generation-jobs.
      attempts: 3,
      backoff: { type: "exponential" as const, delay: 5000 },
    },
  );
}
