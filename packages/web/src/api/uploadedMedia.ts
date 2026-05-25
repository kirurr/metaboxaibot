import { apiClient } from "./client";
import {
  uploadedMediaPageSchema,
  type UploadedMediaPage,
  type UploadedMedia,
  type ListUploadedMediaQuery,
} from "@metabox/shared-browser/dto";

export type { UploadedMediaPage, UploadedMedia, ListUploadedMediaQuery };

/** Список ранее загруженных пользователем медиа (newest first, курсорная пагинация). */
export async function listUploadedMedia(
  params: ListUploadedMediaQuery = {},
  signal?: AbortSignal,
): Promise<UploadedMediaPage> {
  const data = await apiClient("/web/uploaded-media", {
    signal,
    query: { type: params.type, cursor: params.cursor, take: params.take },
  });
  return uploadedMediaPageSchema.parse(data);
}

/** Удаляет запись из списка переиспользования (S3-объект остаётся). */
export async function deleteUploadedMedia(id: string) {
  return apiClient<{ success: boolean }>(`/web/uploaded-media/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ── Query keys ──────────────────────────────────────────────────────────────
// Иерархическая фабрика (как `galleryKeys`) — точечная инвалидация по типу и
// веерная по всему домену. `type ?? null` чтобы ключ был стабильным для
// «все типы».
export const uploadedMediaKeys = {
  all: ["uploadedMedia"] as const,
  list: (type?: string) => [...uploadedMediaKeys.all, "list", type ?? null] as const,
};
