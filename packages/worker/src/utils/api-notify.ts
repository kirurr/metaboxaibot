import { getRedis } from "@metabox/api/redis";
import { JOB_NOTIFICATIONS_CHANNEL, type JobNotificationMessage } from "@metabox/shared";
import { logger } from "../logger.js";

interface ApiNotifySuccessInput {
  userId: string;
  dbJobId: string;
  outputs: Array<{
    id: string;
    outputUrl: string | null;
    s3Key: string | null;
  }>;
  partial?: { success: number; total: number };
}

interface ApiNotifyErrorInput {
  userId: string;
  dbJobId: string;
  userMessage: string;
  errorCode?: string;
}

// Publisher на ioredis — обычная команда (не блокирует connection), поэтому
// переиспользуем основной singleton. Best-effort: при сбое pub/sub джоба уже
// завершена и записана в БД, обработчик не валим.
async function publish(message: JobNotificationMessage): Promise<void> {
  try {
    await getRedis().publish(JOB_NOTIFICATIONS_CHANNEL, JSON.stringify(message));
  } catch (err) {
    logger.warn({ err, message }, "job-notify publish failed");
  }
}

export async function apiNotifySuccess(input: ApiNotifySuccessInput): Promise<void> {
  await publish({ kind: "success", section: "image", ...input });
}

export async function apiNotifyError(input: ApiNotifyErrorInput): Promise<void> {
  await publish({ kind: "error", section: "image", ...input });
}
