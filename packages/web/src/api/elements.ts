import { apiClient, postMultipartFile } from "./client";
import {
  elementSchema,
  elementMediaSchema,
  elementsResponseSchema,
  type Element,
  type ElementMedia,
} from "@metabox/shared-browser/dto";

export type { Element, ElementMedia };

/** Все элементы пользователя (newest first) с вложенными референсными картинками. */
export async function listElements(signal?: AbortSignal): Promise<Element[]> {
  const data = await apiClient("/web/elements", { signal });
  return elementsResponseSchema.parse(data).items;
}

/** Создаёт пустой элемент. Бросает ApiError(409) если имя уже занято. */
export async function createElement(name: string): Promise<Element> {
  const data = await apiClient("/web/elements", { method: "POST", body: { name } });
  return elementSchema.parse(data);
}

/** Переименовывает элемент. Бросает ApiError(409) при дубле имени. */
export async function updateElement(id: string, name: string): Promise<Element> {
  const data = await apiClient(`/web/elements/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { name },
  });
  return elementSchema.parse(data);
}

/** Удаляет элемент со всеми картинками (S3-объекты остаются). */
export async function deleteElement(id: string) {
  return apiClient<{ success: boolean }>(`/web/elements/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Убирает одну картинку из элемента (S3-объект остаётся). */
export async function deleteElementMedia(elementId: string, mediaId: string) {
  return apiClient<{ success: boolean }>(
    `/web/elements/${encodeURIComponent(elementId)}/media/${encodeURIComponent(mediaId)}`,
    { method: "DELETE" },
  );
}

/** Загружает одно изображение в элемент (multipart). */
export async function uploadElementMedia(elementId: string, file: File): Promise<ElementMedia> {
  const res = await postMultipartFile(`/web/elements/${encodeURIComponent(elementId)}/media`, file);
  return elementMediaSchema.parse(await res.json());
}

// ── Query keys ──────────────────────────────────────────────────────────────
export const elementKeys = {
  all: ["elements"] as const,
  list: () => [...elementKeys.all, "list"] as const,
};
