import z from "zod";

export const exampleMessageToClient = z.object({
  text: z.string(),
});

export type ExampleMessageToClient = z.infer<typeof exampleMessageToClient>;

export const exampleMessageToServer = z.object({
  text: z.string(),
});

export type ExampleMessageToServer = z.infer<typeof exampleMessageToServer>;

// ── Web notifications ───────────────────────────────────────────────────

export const webNotificationType = z.enum([
  "image_success",
  "image_error",
  "video_success",
  "video_error",
  "audio_success",
  "audio_error",
]);
export type WebNotificationType = z.infer<typeof webNotificationType>;

export const webNotificationSchema = z.object({
  id: z.string(),
  jobId: z.string().nullable(),
  type: webNotificationType,
  title: z.string(),
  message: z.string(),
  isSeen: z.boolean(),
  data: z.unknown().nullable(),
  createdAt: z.string(),
});
export type WebNotificationDTO = z.infer<typeof webNotificationSchema>;

// server → client
export const notificationSnapshotEvent = z.array(webNotificationSchema);
export const notificationNewEvent = webNotificationSchema;

// client → server
export const notificationMarkSeenEvent = z.object({ ids: z.array(z.string()) });
export const notificationDeleteEvent = z.object({ id: z.string() });
