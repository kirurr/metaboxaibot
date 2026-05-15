import { z } from "zod";

export const JOB_NOTIFICATIONS_CHANNEL = "job-notifications";

const jobNotificationOutputSchema = z.object({
  id: z.string(),
  outputUrl: z.string().nullable(),
  s3Key: z.string().nullable(),
});

export const jobNotificationSuccessSchema = z.object({
  kind: z.literal("success"),
  section: z.enum(["image", "video", "audio", "avatar"]),
  userId: z.string(),
  dbJobId: z.string(),
  outputs: z.array(jobNotificationOutputSchema),
  partial: z
    .object({
      success: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .optional(),
});

export const jobNotificationErrorSchema = z.object({
  kind: z.literal("error"),
  section: z.enum(["image", "video", "audio", "avatar"]),
  userId: z.string(),
  dbJobId: z.string(),
  userMessage: z.string(),
  errorCode: z.string().optional(),
});

export const jobNotificationMessageSchema = z.discriminatedUnion("kind", [
  jobNotificationSuccessSchema,
  jobNotificationErrorSchema,
]);

export type JobNotificationSuccess = z.infer<typeof jobNotificationSuccessSchema>;
export type JobNotificationError = z.infer<typeof jobNotificationErrorSchema>;
export type JobNotificationMessage = z.infer<typeof jobNotificationMessageSchema>;
