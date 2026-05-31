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
 *
 * История: до 2026-05-31 список галереи группировал outputs под job'у, а
 * фавориты/папки висели на job'е. Теперь — один item на output (`GalleryItem`),
 * фавориты/папки на outputId. `getGalleryJob` остался для лайтбокса.
 */

import z from "zod";
import { apiClient } from "./client";
import {
  galleryJobDetailSchema,
  galleryListResponseSchema,
  galleryFolderSchema,
  galleryModelCountSchema,
  galleryUrlResponseSchema,
  galleryFavoritesResponseSchema,
  type GalleryOutput,
  type GalleryItem,
  type GalleryJobDetail,
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
  GalleryOutput,
  GalleryItem,
  GalleryJobDetail,
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

// ── Items ───────────────────────────────────────────────────────────────────
// (хелперы оставляем под именем "Jobs" для совместимости с импортами в коде —
// семантика теперь output-flat, но это деталь shape'а ответа.)

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
  folderId?: string,
  signal?: AbortSignal,
): Promise<GalleryModelCount[]> {
  const data = await apiClient("/web/gallery/model-counts", {
    signal,
    query: {
      ...(section ? { section } : {}),
      ...(folderId ? { folderId } : {}),
    },
  });
  return modelCountsArraySchema.parse(data);
}

export async function getGalleryPreviewUrl(outputId: string): Promise<GalleryUrlResponse> {
  const data = await apiClient(`/web/gallery/${encodeURIComponent(outputId)}/preview-url`);
  return galleryUrlResponseSchema.parse(data);
}

export async function getGalleryOriginalUrl(outputId: string): Promise<GalleryUrlResponse> {
  const data = await apiClient(`/web/gallery/outputs/${encodeURIComponent(outputId)}/original-url`);
  return galleryUrlResponseSchema.parse(data);
}

export async function getGalleryJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<GalleryJobDetail> {
  const data = await apiClient(`/web/gallery/jobs/${encodeURIComponent(jobId)}`, { signal });
  return galleryJobDetailSchema.parse(data);
}

export function deleteGalleryJob(jobId: string) {
  return apiClient<{ success: boolean }>(`/web/gallery/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}

/** Удаляет один output. `jobDeleted: true` — это был последний, джоба снесена. */
export function deleteGalleryOutput(outputId: string) {
  return apiClient<{ jobDeleted: boolean }>(
    `/web/gallery/outputs/${encodeURIComponent(outputId)}`,
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
  return apiClient<{ success: boolean }>(`/web/gallery/folders/${encodeURIComponent(folderId)}`, {
    method: "DELETE",
  });
}

export function addOutputToGalleryFolder(folderId: string, outputId: string) {
  return apiClient<{ success: boolean }, { outputId: string }>(
    `/web/gallery/folders/${encodeURIComponent(folderId)}/items`,
    { method: "POST", body: { outputId } },
  );
}

export function removeOutputFromGalleryFolder(folderId: string, outputId: string) {
  return apiClient<{ success: boolean }>(
    `/web/gallery/folders/${encodeURIComponent(folderId)}/items/${encodeURIComponent(outputId)}`,
    { method: "DELETE" },
  );
}

// ── Favorites (sugar над default-папкой) ────────────────────────────────────

export async function addToGalleryFavorites(outputId: string): Promise<GalleryFavoritesResponse> {
  const data = await apiClient("/web/gallery/favorites", {
    method: "POST",
    body: { outputId },
  });
  return galleryFavoritesResponseSchema.parse(data);
}

export function removeFromGalleryFavorites(outputId: string) {
  return apiClient<{ success: boolean }>(`/web/gallery/favorites/${encodeURIComponent(outputId)}`, {
    method: "DELETE",
  });
}

// ── Query keys ──────────────────────────────────────────────────────────────
//
// Иерархическая фабрика (TkDodo pattern) — позволяет инвалидировать как точечно
// (`galleryKeys.folders()`), так и веером по всему домену (`galleryKeys.all`).
// Все ключи начинаются с `["gallery", ...]`, чтобы `invalidateQueries({
// queryKey: galleryKeys.all })` зацепил всё gallery-семейство одним вызовом.

export const galleryKeys = {
  all: ["gallery"] as const,
  jobs: () => [...galleryKeys.all, "jobs"] as const,
  jobsList: (params: ListGalleryJobsQuery) => [...galleryKeys.jobs(), params] as const,
  infiniteJobs: (params: { section?: string; modelId?: string; folderId?: string }) =>
    [...galleryKeys.jobs(), "infinite", params] as const,
  detail: (id: string) => [...galleryKeys.all, "detail", id] as const,
  modelCounts: (section: string | undefined, folderId: string | undefined) =>
    [...galleryKeys.all, "model-counts", section ?? null, folderId ?? null] as const,
  folders: () => [...galleryKeys.all, "folders"] as const,
  previewUrl: (outputId: string) => [...galleryKeys.all, "preview-url", outputId] as const,
  originalUrl: (outputId: string) => [...galleryKeys.all, "original-url", outputId] as const,
};
