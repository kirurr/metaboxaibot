import { Queue } from "bullmq";
import { getRedis } from "../redis.js";

export interface AvatarJobData {
  /** UserAvatar.id in DB */
  userAvatarId: string;
  /** BigInt userId serialised as string */
  userId: string;
  provider: string;
  action: "create" | "poll";
  /** Source image URL — only for action="create" */
  imageUrl?: string;
  /** S3 key of the source image (preferred over imageUrl) */
  s3Key?: string;
  /** Telegram chat id to notify when done. `null` — джоб инициирован из web,
   *  воркер должен слать WS-уведомление через apiNotify вместо Telegram. */
  telegramChatId: number | null;
  /** Poll attempt counter (incremented on each retry) */
  pollAttempt?: number;
  /** S3 keys of multiple images (for Soul character creation) */
  s3Keys?: string[];
  /** Display name for the character */
  characterName?: string;
  /** Soft retry counter for transient network failures (DNS hiccups etc.). */
  transientRetries?: number;
}

export function getAvatarQueue(): Queue<AvatarJobData> {
  return new Queue<AvatarJobData>("avatar", { connection: getRedis() });
}
