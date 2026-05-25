import z from "zod";

// type: known values are "image" | "video" | "audio"
// kept as string for forward compatibility.

export const uploadedMediaSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  // Presigned URL для превью; может быть null если S3 не вернул.
  url: z.string().nullable(),
  createdAt: z.string(),
});

export const uploadedMediaPageSchema = z.object({
  items: z.array(uploadedMediaSchema),
  nextCursor: z.string().nullable(),
});

export const listUploadedMediaQuerySchema = z.object({
  type: z.string().optional(),
  cursor: z.string().optional(),
  take: z.coerce.number().int().min(1).max(100).optional(),
});

export type UploadedMedia = z.infer<typeof uploadedMediaSchema>;
export type UploadedMediaPage = z.infer<typeof uploadedMediaPageSchema>;
export type ListUploadedMediaQuery = z.infer<typeof listUploadedMediaQuerySchema>;
