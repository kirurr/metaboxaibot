import z from "zod";

/**
 * Element — именованный (@-тег) набор референсных изображений пользователя.
 * Картинки элемента хранятся как UploadedMedia с elementId, но в общий список
 * переиспользования не попадают. Здесь — только image-медиа (type фиксирован).
 */

// @-имя без символа @: латиница/цифры/подчёркивание, 1–64 символа.
export const elementNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_]+$/, "Only letters, digits and underscore are allowed");

export const elementMediaSchema = z.object({
  id: z.string(),
  // s3Key нужен фронту, чтобы подставить картинку в генерацию.
  s3Key: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number(),
  // Presigned URL для превью; может быть null если S3 не вернул.
  url: z.string().nullable(),
  createdAt: z.string(),
});

export const elementSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  media: z.array(elementMediaSchema),
});

export const elementsResponseSchema = z.object({
  items: z.array(elementSchema),
});

export const createElementBodySchema = z.object({
  name: elementNameSchema,
});

export const updateElementBodySchema = z.object({
  name: elementNameSchema,
});

export type ElementMedia = z.infer<typeof elementMediaSchema>;
export type Element = z.infer<typeof elementSchema>;
export type ElementsResponse = z.infer<typeof elementsResponseSchema>;
export type CreateElementBody = z.infer<typeof createElementBodySchema>;
export type UpdateElementBody = z.infer<typeof updateElementBodySchema>;
