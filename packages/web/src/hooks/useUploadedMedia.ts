import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  listUploadedMedia,
  deleteUploadedMedia,
  uploadedMediaKeys,
  type UploadedMediaPage,
} from "@/api/uploadedMedia";

const TAKE = 24;

/**
 * Инфинит-список ранее загруженных пользователем медиа (newest first), с
 * курсорной пагинацией. `type` фильтрует по image|video|audio (для слота —
 * один тип). Кэш живёт между открытиями попапа / переключениями табов, поэтому
 * UI не фликает.
 */
export function useUploadedMedia(type?: string) {
  const query = useInfiniteQuery({
    queryKey: uploadedMediaKeys.list(type),
    queryFn: ({ pageParam, signal }) =>
      listUploadedMedia({ type, cursor: pageParam, take: TAKE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return {
    items,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    error: query.error,
  };
}

/**
 * Удаление с optimistic-removal из инфинит-кэша. S3-объект не трогается
 * (бэкенд удаляет только строку). Откат при ошибке, invalidate в onSettled.
 */
export function useDeleteUploadedMedia(type?: string) {
  const qc = useQueryClient();
  const key = uploadedMediaKeys.list(type);
  return useMutation<unknown, Error, string, { prev?: InfiniteData<UploadedMediaPage> }>({
    mutationFn: (id) => deleteUploadedMedia(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<InfiniteData<UploadedMediaPage>>(key);
      if (prev) {
        qc.setQueryData<InfiniteData<UploadedMediaPage>>(key, {
          ...prev,
          pages: prev.pages.map((p) => ({
            ...p,
            items: p.items.filter((it) => it.id !== id),
          })),
        });
      }
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}
