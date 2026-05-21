import z from "zod";

export const adminUploadKindSchema = z.enum(["media", "thumbnail"]);
export const adminUploadSectionSchema = z.enum(["design", "video"]);

export const adminUploadResponseSchema = z.object({
  s3Key: z.string(),
  url: z.string().nullable(),
  mimeType: z.string(),
  size: z.number(),
});

export type AdminUploadKind = z.infer<typeof adminUploadKindSchema>;
export type AdminUploadSection = z.infer<typeof adminUploadSectionSchema>;
export type AdminUploadResponse = z.infer<typeof adminUploadResponseSchema>;
