import { Queue } from "bullmq";
import { getRedis } from "../redis.js";

export interface VideoJobData {
  /** GenerationJob.id in DB */
  dbJobId: string;
  /** BigInt userId serialised as string */
  userId: string;
  modelId: string;
  prompt: string;
  /** Optional source image URL for image-to-video */
  imageUrl?: string;
  /** Named media input slots: { [slotKey]: string[] } */
  mediaInputs?: Record<string, string[]>;
  /** Telegram chat id to notify when done */
  telegramChatId: number;
  /** Telegram message_id of the user's prompt message (for reply threading on result). */
  promptMessageId?: number;
  /** Pre-translated label for the "Send as file" button. */
  sendOriginalLabel?: string;
  /** Aspect ratio chosen by user, e.g. "16:9". */
  aspectRatio?: string;
  /** Clip duration in seconds chosen by user. */
  duration?: number;
  /** Per-model user settings (cfg_scale, resolution, etc.) */
  modelSettings?: Record<string, unknown>;
  /** Job pipeline stage. `"generate"` (default) submits; `"poll"` checks status. */
  stage?: "generate" | "poll";
  /** Epoch ms timestamp when polling started. */
  pollStartedAt?: number;
  /** Last poll interval used, so we can detect interval tier changes. */
  lastIntervalMs?: number;
  /** Soft retry counter for transient network failures (DNS hiccups etc.). */
  transientRetries?: number;
}

export function getVideoQueue(): Queue<VideoJobData> {
  return new Queue<VideoJobData>("video", { connection: getRedis() });
}
