/**
 * Эндпоинты `/web/gallery/*` — те же ресурсы, что у `/gallery/*` мини-аппы,
 * но под JWT-auth (см. `packages/api/src/routes/web-gallery.ts`).
 *
 * DTO живут в `@metabox/shared-browser/dto` — единый источник правды между
 * бэкендом и фронтом. Каждый GET валидирует ответ через `*Schema.parse(...)`
 * чтобы поймать дрейф shape'а на runtime (как в `promptExamples.ts`).
 *
 * Все эндпоинты требуют привязанного Telegram (бэкенд гейтит
 * `webTelegramLinkedPreHandler`). На 403 TELEGRAM_NOT_LINKED `apiClient`
 * сам открывает модалку через `useUIStore`.
 */

import z from "zod";
import { apiClient } from "./client";
import {
  galleryListResponseSchema,
  galleryFolderSchema,
  galleryModelCountSchema,
  galleryUrlResponseSchema,
  galleryFavoritesResponseSchema,
  type GalleryJob,
  type GalleryOutput,
  type GalleryFolder,
  type GalleryListResponse,
  type GalleryModelCount,
  type GalleryUrlResponse,
  type GalleryFavoritesResponse,
  type ListGalleryJobsQuery,
  type CreateGalleryFolderBody,
  type UpdateGalleryFolderBody,
} from "@metabox/shared-browser/dto";

// Re-export для удобства потребителей в `packages/web`.
export type {
  GalleryJob,
  GalleryOutput,
  GalleryFolder,
  GalleryListResponse,
  GalleryModelCount,
  GalleryUrlResponse,
  GalleryFavoritesResponse,
  ListGalleryJobsQuery,
  CreateGalleryFolderBody,
  UpdateGalleryFolderBody,
};

const modelCountsArraySchema = z.array(galleryModelCountSchema);
const foldersArraySchema = z.array(galleryFolderSchema);

// ── Jobs ────────────────────────────────────────────────────────────────────

export async function listGalleryJobs(
  params: ListGalleryJobsQuery = {},
  signal?: AbortSignal,
): Promise<GalleryListResponse> {
  const data = await apiClient("/web/gallery", {
    signal,
    query: {
      section: params.section,
      page: params.page,
      limit: params.limit,
      modelId: params.modelId,
      modelIds: params.modelIds,
      folderId: params.folderId,
    },
  });
  return galleryListResponseSchema.parse(data);
}

export async function getGalleryModelCounts(
  section?: string,
  signal?: AbortSignal,
): Promise<GalleryModelCount[]> {
  const data = await apiClient("/web/gallery/model-counts", {
    signal,
    query: section ? { section } : undefined,
  });
  return modelCountsArraySchema.parse(data);
}

export async function getGalleryPreviewUrl(outputId: string): Promise<GalleryUrlResponse> {
  const data = await apiClient(
    `/web/gallery/${encodeURIComponent(outputId)}/preview-url`,
  );
  return galleryUrlResponseSchema.parse(data);
}

export async function getGalleryOriginalUrl(outputId: string): Promise<GalleryUrlResponse> {
  const data = await apiClient(
    `/web/gallery/outputs/${encodeURIComponent(outputId)}/original-url`,
  );
  return galleryUrlResponseSchema.parse(data);
}

export function deleteGalleryJob(jobId: string) {
  return apiClient<{ success: boolean }>(
    `/web/gallery/jobs/${encodeURIComponent(jobId)}`,
    { method: "DELETE" },
  );
}

// ── Folders ─────────────────────────────────────────────────────────────────

export async function listGalleryFolders(signal?: AbortSignal): Promise<GalleryFolder[]> {
  const data = await apiClient("/web/gallery/folders", { signal });
  return foldersArraySchema.parse(data);
}

export async function createGalleryFolder(body: CreateGalleryFolderBody): Promise<GalleryFolder> {
  const data = await apiClient("/web/gallery/folders", { method: "POST", body });
  return galleryFolderSchema.parse(data);
}

export async function updateGalleryFolder(
  folderId: string,
  body: UpdateGalleryFolderBody,
): Promise<GalleryFolder> {
  const data = await apiClient(`/web/gallery/folders/${encodeURIComponent(folderId)}`, {
    method: "PATCH",
    body,
  });
  return galleryFolderSchema.parse(data);
}

export function deleteGalleryFolder(folderId: string) {
  return apiClient<{ success: boolean }>(
    `/web/gallery/folders/${encodeURIComponent(folderId)}`,
    { method: "DELETE" },
  );
}

export function addJobToGalleryFolder(folderId: string, jobId: string) {
  return apiClient<{ success: boolean }, { jobId: string }>(
    `/web/gallery/folders/${encodeURIComponent(folderId)}/items`,
    { method: "POST", body: { jobId } },
  );
}

export function removeJobFromGalleryFolder(folderId: string, jobId: string) {
  return apiClient<{ success: boolean }>(
    `/web/gallery/folders/${encodeURIComponent(folderId)}/items/${encodeURIComponent(jobId)}`,
    { method: "DELETE" },
  );
}

// ── Favorites (sugar над default-папкой) ────────────────────────────────────

export async function addToGalleryFavorites(jobId: string): Promise<GalleryFavoritesResponse> {
  const data = await apiClient("/web/gallery/favorites", {
    method: "POST",
    body: { jobId },
  });
  return galleryFavoritesResponseSchema.parse(data);
}

export function removeFromGalleryFavorites(jobId: string) {
  return apiClient<{ success: boolean }>(
    `/web/gallery/favorites/${encodeURIComponent(jobId)}`,
    { method: "DELETE" },
  );
}
