import type { Redis } from "ioredis";
import {
  JOB_NOTIFICATIONS_CHANNEL,
  jobNotificationMessageSchema,
  type JobNotificationMessage,
} from "@metabox/shared";
import { getRedis } from "../redis.js";
import { logger } from "../logger.js";

export type JobNotificationHandler = (msg: JobNotificationMessage) => void | Promise<void>;

let subscriber: Redis | null = null;

// Subscribe-mode на ioredis блокирует issue других команд, поэтому отдельный
// клиент через duplicate() — тот же приём, что в pricing-config.service.
export async function startJobNotificationsSubscriber(
  handler: JobNotificationHandler,
): Promise<void> {
  if (subscriber) return;

  subscriber = getRedis().duplicate();

  subscriber.on("message", (channel, raw) => {
    if (channel !== JOB_NOTIFICATIONS_CHANNEL) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger.warn({ err, raw }, "job-notify: bad JSON, dropped");
      return;
    }
    const result = jobNotificationMessageSchema.safeParse(parsed);
    if (!result.success) {
      logger.warn(
        { issues: result.error.issues, raw },
        "job-notify: schema validation failed, dropped",
      );
      return;
    }
    const msg = result.data;
    void Promise.resolve(handler(msg)).catch((err) =>
      logger.error({ err, msg }, "job-notify: handler threw"),
    );
  });

  subscriber.on("error", (err) => {
    logger.warn({ err }, "job-notify: subscriber error");
  });

  await subscriber.subscribe(JOB_NOTIFICATIONS_CHANNEL);
  logger.info({ channel: JOB_NOTIFICATIONS_CHANNEL }, "job-notify subscriber started");
}

export async function stopJobNotificationsSubscriber(): Promise<void> {
  if (!subscriber) return;
  try {
    await subscriber.unsubscribe(JOB_NOTIFICATIONS_CHANNEL);
  } catch {
    // ignore
  }
  subscriber.disconnect();
  subscriber = null;
}
