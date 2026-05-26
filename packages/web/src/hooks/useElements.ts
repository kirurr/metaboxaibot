import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listElements,
  createElement,
  updateElement,
  deleteElement,
  uploadElementMedia,
  deleteElementMedia,
  elementKeys,
  type Element,
} from "@/api/elements";

// Стабильная ссылка на пустой список. Без неё `query.data ?? []` отдавал бы НОВЫЙ
// `[]` на каждый рендер, когда запрос выключен/не загружен (на страницах генерации
// он обычно `enabled=false`). Новый identity протекал в зависимости useMemo
// (`activeMentions`/`cappedMentions`) и далее в debounce-эффект preview, который
// из-за этого перезапускался каждый рендер и заспамливал бэкенд запросами.
const EMPTY_ELEMENTS: Element[] = [];

/**
 * Список Element'ов пользователя (именованные наборы референсных изображений).
 * Кэш живёт между открытиями — UI не фликает. Каждый элемент содержит вложенный
 * массив media (картинки с пресайн-url).
 */
export function useElements(enabled = true) {
  const query = useQuery({
    queryKey: elementKeys.list(),
    queryFn: ({ signal }) => listElements(signal),
    enabled,
  });

  return {
    elements: query.data ?? EMPTY_ELEMENTS,
    isLoading: query.isLoading,
    error: query.error,
  };
}

/** Создание элемента. Конфликт имени прилетает как ApiError(409). */
export function useCreateElement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => createElement(name),
    onSettled: () => qc.invalidateQueries({ queryKey: elementKeys.list() }),
  });
}

/** Переименование элемента. */
export function useUpdateElement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => updateElement(id, name),
    onSettled: () => qc.invalidateQueries({ queryKey: elementKeys.list() }),
  });
}

/** Удаление элемента (с картинками). */
export function useDeleteElement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteElement(id),
    onSettled: () => qc.invalidateQueries({ queryKey: elementKeys.list() }),
  });
}

/** Загрузка картинки в элемент (multipart). */
export function useUploadElementMedia() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ elementId, file }: { elementId: string; file: File }) =>
      uploadElementMedia(elementId, file),
    onSettled: () => qc.invalidateQueries({ queryKey: elementKeys.list() }),
  });
}

/** Удаление одной картинки из элемента. */
export function useDeleteElementMedia() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ elementId, mediaId }: { elementId: string; mediaId: string }) =>
      deleteElementMedia(elementId, mediaId),
    onSettled: () => qc.invalidateQueries({ queryKey: elementKeys.list() }),
  });
}
