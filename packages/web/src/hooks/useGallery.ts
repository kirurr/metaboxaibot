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

// ── Optimistic patch (folders + favorites) ─────────────────────────────────
//
// Folder/favorites toggle — наиболее лаг-чувствительные действия. Накладываем
// изменения сразу на ВСЕ кэшированные шейпы:
//   • `galleryKeys.jobs()` — list/infinite шейпы (карточка в гриде);
//   • `galleryKeys.detail(jobId)` — `GalleryJobDetail` для открытого лайтбокса
//     (heart/чекбокс папки внутри JobPreview).
// Без патча detail-кэша heart внутри модалки залипал до round-trip'а
// invalidate'а (staleTime у detail = 30s; force-refetch через onSettled).

type OptimisticSnapshots = {
  lists: Array<[readonly unknown[], unknown]>;
  details: Array<[readonly unknown[], unknown]>;
};

type OptimisticContext = { snapshots: OptimisticSnapshots };

async function snapshotGalleryCaches(
  qc: ReturnType<typeof useQueryClient>,
): Promise<OptimisticSnapshots> {
  await qc.cancelQueries({ queryKey: galleryKeys.all });
  return {
    lists: qc.getQueriesData<unknown>({ queryKey: galleryKeys.jobs() }),
    details: qc.getQueriesData<unknown>({ queryKey: [...galleryKeys.all, "detail"] }),
  };
}

function restoreSnapshots(
  qc: ReturnType<typeof useQueryClient>,
  snapshots: OptimisticSnapshots,
): void {
  for (const [key, data] of snapshots.lists) qc.setQueryData(key, data);
  for (const [key, data] of snapshots.details) qc.setQueryData(key, data);
}

function patchFolderIds(
  current: readonly string[],
  folderId: string,
  mode: "add" | "remove",
): string[] | undefined {
  if (mode === "add") {
    if (current.includes(folderId)) return undefined;
    return [...current, folderId];
  }
  if (!current.includes(folderId)) return undefined;
  return current.filter((id) => id !== folderId);
}

function patchItem(item: GalleryItem, folderId: string, mode: "add" | "remove"): GalleryItem {
  const next = patchFolderIds(item.folderIds, folderId, mode);
  if (!next) return item;
  return { ...item, folderIds: next };
}

function patchGalleryCaches(
  qc: ReturnType<typeof useQueryClient>,
  snapshots: OptimisticSnapshots,
  outputId: string,
  folderId: string,
  mode: "add" | "remove",
) {
  // Lists: и page-based (`GalleryListResponse`), и infinite
  // (`InfiniteData<GalleryListResponse>`). Структура разная — две ветки.
  for (const [key, data] of snapshots.lists) {
    if (!data || typeof data !== "object") continue;
    if ("pages" in data) {
      const inf = data as InfiniteData<GalleryListResponse>;
      qc.setQueryData<InfiniteData<GalleryListResponse>>(key, {
        ...inf,
        pages: inf.pages.map((page) => ({
          ...page,
          items: page.items.map((it) => (it.id === outputId ? patchItem(it, folderId, mode) : it)),
        })),
      });
    } else {
      const list = data as GalleryListResponse;
      if (!list.items) continue;
      qc.setQueryData<GalleryListResponse>(key, {
        ...list,
        items: list.items.map((it) => (it.id === outputId ? patchItem(it, folderId, mode) : it)),
      });
    }
  }

  // Detail: ищем output внутри `outputs[]` нужной джобы и патчим его
  // `folderIds`. JobPreview лайтбокс читает `activeOutput.folderIds` ровно
  // отсюда, так что heart/чекбоксы папок мгновенно отражают клик.
  for (const [key, data] of snapshots.details) {
    if (!data || typeof data !== "object") continue;
    const detail = data as GalleryJobDetail;
    if (!Array.isArray(detail.outputs)) continue;
    if (!detail.outputs.some((o) => o.id === outputId)) continue;
    qc.setQueryData<GalleryJobDetail>(key, {
      ...detail,
      outputs: detail.outputs.map((o) => {
        if (o.id !== outputId) return o;
        const next = patchFolderIds(o.folderIds, folderId, mode);
        return next ? { ...o, folderIds: next } : o;
      }),
    });
  }
}

function getFavoritesFolderId(qc: ReturnType<typeof useQueryClient>): string | undefined {
  const folders = qc.getQueryData<GalleryFolder[]>(galleryKeys.folders());
  return folders?.find((f) => f.isDefault)?.id;
}

type FolderMutationVars = { folderId: string; outputId: string };

export function useAddOutputToGalleryFolder() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, FolderMutationVars, OptimisticContext>({
    mutationFn: ({ folderId, outputId }) => addOutputToGalleryFolder(folderId, outputId),
    onMutate: async ({ folderId, outputId }) => {
      const snapshots = await snapshotGalleryCaches(qc);
      patchGalleryCaches(qc, snapshots, outputId, folderId, "add");
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) restoreSnapshots(qc, ctx.snapshots);
    },
    onSettled: () => invalidateGallery(qc),
  });
}

export function useRemoveOutputFromGalleryFolder() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, FolderMutationVars, OptimisticContext>({
    mutationFn: ({ folderId, outputId }) => removeOutputFromGalleryFolder(folderId, outputId),
    onMutate: async ({ folderId, outputId }) => {
      const snapshots = await snapshotGalleryCaches(qc);
      patchGalleryCaches(qc, snapshots, outputId, folderId, "remove");
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx) restoreSnapshots(qc, ctx.snapshots);
    },
    onSettled: () => invalidateGallery(qc),
  });
}

// ── Favorites (sugar над default-папкой) ────────────────────────────────────
//
// Делегирует на тот же `patchGalleryCaches`, что и обычные папочные мутации —
// поведение идентично, отличается только то, что folderId резолвится из кэша
// (default-папка пользователя). Если её ещё нет — мутация всё равно уйдёт, но
// без мгновенного UI-эффекта; бэк-данные приедут через `onSettled` invalidate.

export function useAddToGalleryFavorites() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string, OptimisticContext>({
    mutationFn: (outputId) => addToGalleryFavorites(outputId),
    onMutate: async (outputId) => {
      const snapshots = await snapshotGalleryCaches(qc);
      const favId = getFavoritesFolderId(qc);
      if (favId) patchGalleryCaches(qc, snapshots, outputId, favId, "add");
      return { snapshots };
    },
    onError: (_err, _outputId, ctx) => {
      if (ctx) restoreSnapshots(qc, ctx.snapshots);
    },
    onSettled: () => invalidateGallery(qc),
  });
}

export function useRemoveFromGalleryFavorites() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string, OptimisticContext>({
    mutationFn: (outputId) => removeFromGalleryFavorites(outputId),
    onMutate: async (outputId) => {
      const snapshots = await snapshotGalleryCaches(qc);
      const favId = getFavoritesFolderId(qc);
      if (favId) patchGalleryCaches(qc, snapshots, outputId, favId, "remove");
      return { snapshots };
    },
    onError: (_err, _outputId, ctx) => {
      if (ctx) restoreSnapshots(qc, ctx.snapshots);
    },
    onSettled: () => invalidateGallery(qc),
  });
}
