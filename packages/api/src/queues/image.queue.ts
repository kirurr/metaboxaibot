import { Queue } from "bullmq";
import { getRedis } from "../redis.js";

export interface ImageJobData {
  /** GenerationJob.id in DB */
  dbJobId: string;
  /** BigInt userId serialised as string */
  userId: string;
  modelId: string;
  prompt: string;
  negativePrompt?: string;
  sourceImageUrl?: string;
  /** Named media input slots: { [slotKey]: string[] } */
  mediaInputs?: Record<string, string[]>;
  /** Telegram chat id to notify when done; null when generation originated outside Telegram (web). */
  telegramChatId: number | null;
  /**
   * Telegram message_id of the user's prompt message. When set, the worker
   * sends the result as a reply to this message so the user can match
   * which request produced which result. Best-effort (allow_sending_without_reply).
   */
  promptMessageId?: number;
  /** Dialog.id for saving messages and enabling img2img context. */
  dialogId?: string;
  /** Pre-translated label for the "Send as file" button. */
  sendOriginalLabel?: string;
  /** Aspect ratio chosen by user, e.g. "16:9", "1:1". */
  aspectRatio?: string;
  /** Per-model user settings (inference steps, style, seed, etc.) */
  modelSettings?: Record<string, unknown>;
  /** Job pipeline stage. `"generate"` (default) submits; `"poll"` checks status. */
  stage?: "generate" | "poll";
  /** Epoch ms timestamp when polling started (stage transitions from generate → poll). */
  pollStartedAt?: number;
  /** Last poll interval used, so we can detect interval tier changes. */
  lastIntervalMs?: number;
  /** Soft retry counter for transient network failures (DNS hiccups etc.). */
  transientRetries?: number;
  /**
   * Сколько изображений сгенерировать (1..maxVirtualBatch). При >1 и
   * `model.nativeBatchMax === 1` воркер запустит N последовательных submit'ов
   * с разнесением во времени и склеит результат в существующий multi-output UX.
   */
  numImages?: number;
}

export function getImageQueue(): Queue<ImageJobData> {
  return new Queue<ImageJobData>("image", { connection: getRedis() });
}
