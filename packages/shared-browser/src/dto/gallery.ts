/**
 * DTO для эндпоинтов `/web/gallery/*` (см. `packages/api/src/routes/web-gallery.ts`).
 * Зеркало shape'а из `packages/api/src/services/gallery.service.ts`, но в wire-формате:
 * Date-поля приходят как ISO-строки, Prisma.Decimal — как строка.
 *
 * Schemas/types используются и фронтом (для runtime-валидации ответов), и
 * могут переиспользоваться бэкендом — единый источник правды.
 */

import z from "zod";

// ── Job + output ────────────────────────────────────────────────────────────

export const galleryOutputSchema = z.object({
  id: z.string(),
  s3Key: z.string().nullable(),
  outputUrl: z.string().nullable(),
  /** Resolved playable URL — /download/:token if s3Key available, иначе outputUrl. */
  previewUrl: z.string().nullable(),
  /** Thumbnail WebP (400px wide) — только для image-jobs. */
  thumbnailUrl: z.string().nullable(),
});

export const galleryJobSchema = z.object({
  id: z.string(),
  section: z.string(),
  modelId: z.string(),
  modelName: z.string(),
  prompt: z.string(),
  /** Per-model settings, использованные при генерации. */
  modelSettings: z.record(z.string(), z.unknown()),
  /** Stringified Decimal; null для старых job'ов и recovery fast-path. */
  tokensSpent: z.string().nullable(),
  /** ISO date string. */
  completedAt: z.string().nullable(),
  folderIds: z.array(z.string()),
  outputs: z.array(galleryOutputSchema),
});

export const galleryListResponseSchema = z.object({
  items: z.array(galleryJobSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

// ── Folder ──────────────────────────────────────────────────────────────────

export const galleryFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** True для "Избранное" — не переименовать и не удалить. */
  isDefault: z.boolean(),
  isPinned: z.boolean(),
  /** ISO date string. */
  pinnedAt: z.string().nullable(),
  itemCount: z.number(),
  /** ISO date string. */
  createdAt: z.string(),
});

// ── Misc responses ──────────────────────────────────────────────────────────

export const galleryModelCountSchema = z.object({
  modelId: z.string(),
  count: z.number(),
});

export const galleryUrlResponseSchema = z.object({
  url: z.string(),
});

export const galleryFavoritesResponseSchema = z.object({
  folderId: z.string(),
});

// ── Query / body schemas ────────────────────────────────────────────────────

export const listGalleryJobsQuerySchema = z.object({
  /** image | audio | video */
  section: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  modelId: z.string().optional(),
  /** Comma-separated IDs (family-filter expands в это на клиенте). */
  modelIds: z.string().optional(),
  folderId: z.string().optional(),
});

export const createGalleryFolderBodySchema = z.object({
  name: z.string().min(1),
});

export const updateGalleryFolderBodySchema = z.object({
  name: z.string().min(1).optional(),
  isPinned: z.boolean().optional(),
});

// ── Inferred types ──────────────────────────────────────────────────────────

export type GalleryOutput = z.infer<typeof galleryOutputSchema>;
export type GalleryJob = z.infer<typeof galleryJobSchema>;
export type GalleryListResponse = z.infer<typeof galleryListResponseSchema>;
export type GalleryFolder = z.infer<typeof galleryFolderSchema>;
export type GalleryModelCount = z.infer<typeof galleryModelCountSchema>;
export type GalleryUrlResponse = z.infer<typeof galleryUrlResponseSchema>;
export type GalleryFavoritesResponse = z.infer<typeof galleryFavoritesResponseSchema>;
export type ListGalleryJobsQuery = z.infer<typeof listGalleryJobsQuerySchema>;
export type CreateGalleryFolderBody = z.infer<typeof createGalleryFolderBodySchema>;
export type UpdateGalleryFolderBody = z.infer<typeof updateGalleryFolderBodySchema>;
