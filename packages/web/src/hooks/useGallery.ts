import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  addJobToGalleryFolder,
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
  removeJobFromGalleryFolder,
  updateGalleryFolder,
  type CreateGalleryFolderBody,
  type GalleryFolder,
  type GalleryJob,
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
 * (section + modelId + folderId). Page-based (`/web/gallery` отдаёт
 * page/limit/total); `keepPreviousData` чтобы грид не фликал при подгрузке.
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

  const jobs = query.data?.pages.flatMap((p) => p.items) ?? [];

  return {
    jobs,
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
 * Single job для лайтбокса (deep-link `/gallery/:jobId`). `initialData` сначала
 * ищет job в кэше любого `useGalleryJobs` — это даёт мгновенный рендер при
 * клике по карточке. Cold-load делает fetch.
 */
export function useGalleryJob(jobId: string | undefined) {
  const qc = useQueryClient();
  return useQuery<GalleryJob>({
    queryKey: galleryKeys.detail(jobId ?? ""),
    queryFn: ({ signal }) => getGalleryJob(jobId!, signal),
    enabled: !!jobId,
    initialData: () => {
      if (!jobId) return undefined;
      // Под `galleryKeys.jobs()` живут и page-based, и infinite queries
      // (data shape: `GalleryListResponse` vs `InfiniteData<GalleryListResponse>`).
      // Ищем jobId в обоих вариантах.
      const queries = qc.getQueriesData<unknown>({ queryKey: galleryKeys.jobs() });
      for (const [, data] of queries) {
        if (!data) continue;
        if (typeof data === "object" && "pages" in data) {
          const inf = data as InfiniteData<GalleryListResponse>;
          for (const page of inf.pages) {
            const hit = page.items.find((j) => j.id === jobId);
            if (hit) return hit;
          }
        } else {
          const list = data as GalleryListResponse;
          const hit = list.items?.find((j) => j.id === jobId);
          if (hit) return hit;
        }
      }
      return undefined;
    },
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
    // Удаление папки задевает и jobs (отфильтрованные по folderId списки) —
    // инвалидируем всё gallery-семейство.
    onSuccess: () => invalidateGallery(qc),
  });
}

export function useAddJobToGalleryFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ folderId, jobId }: { folderId: string; jobId: string }) =>
      addJobToGalleryFolder(folderId, jobId),
    onSuccess: () => invalidateGallery(qc),
  });
}

export function useRemoveJobFromGalleryFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ folderId, jobId }: { folderId: string; jobId: string }) =>
      removeJobFromGalleryFolder(folderId, jobId),
    onSuccess: () => invalidateGallery(qc),
  });
}

// ── Favorites (с optimistic update) ─────────────────────────────────────────
//
// Favorites toggle — самое чувствительное к лагу действие в галерее. Накладываем
// изменения сразу на все кэшированные списки jobs и откатываем при ошибке.
// Если default-папки нет в кэше — мутация всё равно отправится, просто без
// мгновенного UI-эффекта (бэк-данные приедут через `onSettled` invalidate).

type FavoritesContext = {
  snapshots: Array<[readonly unknown[], unknown]>;
};

async function snapshotJobsLists(qc: ReturnType<typeof useQueryClient>) {
  await qc.cancelQueries({ queryKey: galleryKeys.jobs() });
  return qc.getQueriesData<unknown>({ queryKey: galleryKeys.jobs() });
}

function patchJob(job: GalleryJob, favId: string, mode: "add" | "remove"): GalleryJob {
  if (mode === "add") {
    if (job.folderIds.includes(favId)) return job;
    return { ...job, folderIds: [...job.folderIds, favId] };
  }
  return { ...job, folderIds: job.folderIds.filter((id) => id !== favId) };
}

function patchJobsLists(
  qc: ReturnType<typeof useQueryClient>,
  snapshots: FavoritesContext["snapshots"],
  jobId: string,
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
          items: page.items.map((j) => (j.id === jobId ? patchJob(j, favId, mode) : j)),
        })),
      });
    } else {
      const list = data as GalleryListResponse;
      if (!list.items) continue;
      qc.setQueryData<GalleryListResponse>(key, {
        ...list,
        items: list.items.map((j) => (j.id === jobId ? patchJob(j, favId, mode) : j)),
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
    mutationFn: (jobId) => addToGalleryFavorites(jobId),
    onMutate: async (jobId) => {
      const snapshots = await snapshotJobsLists(qc);
      const favId = getFavoritesFolderId(qc);
      if (favId) patchJobsLists(qc, snapshots, jobId, favId, "add");
      return { snapshots };
    },
    onError: (_err, _jobId, ctx) => {
      ctx?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => invalidateGallery(qc),
  });
}

export function useRemoveFromGalleryFavorites() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string, FavoritesContext>({
    mutationFn: (jobId) => removeFromGalleryFavorites(jobId),
    onMutate: async (jobId) => {
      const snapshots = await snapshotJobsLists(qc);
      const favId = getFavoritesFolderId(qc);
      if (favId) patchJobsLists(qc, snapshots, jobId, favId, "remove");
      return { snapshots };
    },
    onError: (_err, _jobId, ctx) => {
      ctx?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => invalidateGallery(qc),
  });
}
