import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  addOutputToGalleryFolder,
  addToGalleryFavorites,
  createGalleryFolder,
  deleteGalleryFolder,
  deleteGalleryJob,
  deleteGalleryOutput,
  galleryKeys,
  getGalleryJob,
  getGalleryModelCounts,
  listGalleryFolders,
  listGalleryJobs,
  removeFromGalleryFavorites,
  removeOutputFromGalleryFolder,
  updateGalleryFolder,
  type CreateGalleryFolderBody,
  type GalleryFolder,
  type GalleryItem,
  type GalleryJobDetail,
  type GalleryListResponse,
  type ListGalleryJobsQuery,
  type UpdateGalleryFolderBody,
} from "@/api/gallery";
import { listGenerations, type GenerationJobDto } from "@/api/generation";

// ── Queries ─────────────────────────────────────────────────────────────────

/**
 * Page-based query на `/web/gallery`. При смене страницы/фильтра RQ держит
 * предыдущие данные через `placeholderData: keepPreviousData` — без flash'а
 * пустого состояния.
 */
export function useGalleryJobs(params: ListGalleryJobsQuery = {}) {
  return useQuery({
    queryKey: galleryKeys.jobsList(params),
    queryFn: ({ signal }) => listGalleryJobs(params, signal),
    placeholderData: keepPreviousData,
  });
}

/**
 * Инфинит-список завершённых генераций — используется как в попапе
 * переиспользования медиа (фильтр только по section), так и в галерее
 * (section + modelId + folderId). После refactor'а 2026-05-31 каждый item =
 * один output (см. `GalleryItem`). Page-based; `keepPreviousData` чтобы грид
 * не фликал при подгрузке.
 */
export function useInfiniteGalleryJobs(params: {
  section?: string;
  modelId?: string;
  folderId?: string;
}) {
  const limit = 24;
  const query = useInfiniteQuery({
    queryKey: galleryKeys.infiniteJobs(params),
    queryFn: ({ pageParam, signal }) =>
      listGalleryJobs({ ...params, page: pageParam, limit }, signal),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page * lastPage.limit < lastPage.total ? lastPage.page + 1 : undefined,
    placeholderData: keepPreviousData,
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

export function useGalleryFolders() {
  return useQuery({
    queryKey: galleryKeys.folders(),
    queryFn: ({ signal }) => listGalleryFolders(signal),
    staleTime: 60_000,
  });
}

/**
 * Single job для лайтбокса (deep-link `/gallery/:jobId`). Cold-load делает
 * fetch — кэш `jobsList`/`infiniteJobs` хранит item'ы (outputs), а тут нужен
 * job-detail (job + все outputs одной пачки), shape отличается.
 */
export function useGalleryJob(jobId: string | undefined) {
  return useQuery<GalleryJobDetail>({
    queryKey: galleryKeys.detail(jobId ?? ""),
    queryFn: ({ signal }) => getGalleryJob(jobId!, signal),
    enabled: !!jobId,
    staleTime: 30_000,
  });
}

/**
 * Сегодняшние failed-генерации для отображения в Gallery. Gallery API сам по
 * себе возвращает только `status: "done"`, поэтому failed тянем через
 * `/web/generations` (тот же эндпоинт, что у `GenerationHistory`), а статус и
 * "сегодня"-окно фильтруем клиентом в `select`.
 *
 * `queryKey` стартует с `galleryKeys.all` — существующая инвалидация в
 * `notificationsStore.upsert` (на каждый WS `notification:new`, включая
 * `*_error`) автоматически перефетчит этот запрос.
 */
export function useGalleryFailedToday(section?: string) {
  return useQuery<{ items: GenerationJobDto[] }, Error, GenerationJobDto[]>({
    queryKey: [...galleryKeys.all, "failed-today", section ?? null] as const,
    queryFn: () => listGenerations({ section, limit: 100 }),
    select: (data) => {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const cutoff = startOfToday.getTime();
      return data.items.filter(
        (j) => j.status === "failed" && new Date(j.createdAt).getTime() >= cutoff,
      );
    },
    staleTime: 30_000,
  });
}

export function useGalleryModelCounts(section?: string, folderId?: string) {
  return useQuery({
    queryKey: galleryKeys.modelCounts(section, folderId),
    queryFn: ({ signal }) => getGalleryModelCounts(section, folderId, signal),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

// ── Mutations ───────────────────────────────────────────────────────────────

function invalidateGallery(qc: ReturnType<typeof useQueryClient>) {
  return qc.invalidateQueries({ queryKey: galleryKeys.all });
}

export function useDeleteGalleryJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => deleteGalleryJob(jobId),
    onSuccess: () => invalidateGallery(qc),
  });
}

export function useDeleteGalleryOutput() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (outputId: string) => deleteGalleryOutput(outputId),
    onSuccess: () => invalidateGallery(qc),
  });
}

export function useCreateGalleryFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateGalleryFolderBody) => createGalleryFolder(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: galleryKeys.folders() }),
  });
}

export function useUpdateGalleryFolder(folderId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateGalleryFolderBody) => updateGalleryFolder(folderId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: galleryKeys.folders() }),
  });
}

export function useDeleteGalleryFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (folderId: string) => deleteGalleryFolder(folderId),
    // Удаление папки задевает и items (отфильтрованные по folderId списки) —
    // инвалидируем всё gallery-семейство.
    onSuccess: () => invalidateGallery(qc),
  });
}

export function useAddOutputToGalleryFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ folderId, outputId }: { folderId: string; outputId: string }) =>
      addOutputToGalleryFolder(folderId, outputId),
    onSuccess: () => invalidateGallery(qc),
  });
}

export function useRemoveOutputFromGalleryFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ folderId, outputId }: { folderId: string; outputId: string }) =>
      removeOutputFromGalleryFolder(folderId, outputId),
    onSuccess: () => invalidateGallery(qc),
  });
}

// ── Favorites (с optimistic update) ─────────────────────────────────────────
//
// Favorites toggle — самое чувствительное к лагу действие в галерее. Накладываем
// изменения сразу на все кэшированные списки items и откатываем при ошибке.
// Если default-папки нет в кэше — мутация всё равно отправится, просто без
// мгновенного UI-эффекта (бэк-данные приедут через `onSettled` invalidate).

type FavoritesContext = {
  snapshots: Array<[readonly unknown[], unknown]>;
};

async function snapshotItemsLists(qc: ReturnType<typeof useQueryClient>) {
  await qc.cancelQueries({ queryKey: galleryKeys.jobs() });
  return qc.getQueriesData<unknown>({ queryKey: galleryKeys.jobs() });
}

function patchItem(item: GalleryItem, favId: string, mode: "add" | "remove"): GalleryItem {
  if (mode === "add") {
    if (item.folderIds.includes(favId)) return item;
    return { ...item, folderIds: [...item.folderIds, favId] };
  }
  return { ...item, folderIds: item.folderIds.filter((id) => id !== favId) };
}

function patchItemsLists(
  qc: ReturnType<typeof useQueryClient>,
  snapshots: FavoritesContext["snapshots"],
  outputId: string,
  favId: string,
  mode: "add" | "remove",
) {
  // `galleryKeys.jobs()` накрывает и page-based (`GalleryListResponse`), и
  // infinite (`InfiniteData<GalleryListResponse>`) — структура у них разная,
  // обрабатываем оба варианта.
  for (const [key, data] of snapshots) {
    if (!data || typeof data !== "object") continue;
    if ("pages" in data) {
      const inf = data as InfiniteData<GalleryListResponse>;
      qc.setQueryData<InfiniteData<GalleryListResponse>>(key, {
        ...inf,
        pages: inf.pages.map((page) => ({
          ...page,
          items: page.items.map((it) => (it.id === outputId ? patchItem(it, favId, mode) : it)),
        })),
      });
    } else {
      const list = data as GalleryListResponse;
      if (!list.items) continue;
      qc.setQueryData<GalleryListResponse>(key, {
        ...list,
        items: list.items.map((it) => (it.id === outputId ? patchItem(it, favId, mode) : it)),
      });
    }
  }
}

function getFavoritesFolderId(qc: ReturnType<typeof useQueryClient>): string | undefined {
  const folders = qc.getQueryData<GalleryFolder[]>(galleryKeys.folders());
  return folders?.find((f) => f.isDefault)?.id;
}

export function useAddToGalleryFavorites() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string, FavoritesContext>({
    mutationFn: (outputId) => addToGalleryFavorites(outputId),
    onMutate: async (outputId) => {
      const snapshots = await snapshotItemsLists(qc);
      const favId = getFavoritesFolderId(qc);
      if (favId) patchItemsLists(qc, snapshots, outputId, favId, "add");
      return { snapshots };
    },
    onError: (_err, _outputId, ctx) => {
      ctx?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => invalidateGallery(qc),
  });
}

export function useRemoveFromGalleryFavorites() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string, FavoritesContext>({
    mutationFn: (outputId) => removeFromGalleryFavorites(outputId),
    onMutate: async (outputId) => {
      const snapshots = await snapshotItemsLists(qc);
      const favId = getFavoritesFolderId(qc);
      if (favId) patchItemsLists(qc, snapshots, outputId, favId, "remove");
      return { snapshots };
    },
    onError: (_err, _outputId, ctx) => {
      ctx?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => invalidateGallery(qc),
  });
}
