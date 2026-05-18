import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addJobToGalleryFolder,
  addToGalleryFavorites,
  createGalleryFolder,
  deleteGalleryFolder,
  deleteGalleryJob,
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
      const pages = qc.getQueriesData<GalleryListResponse>({ queryKey: galleryKeys.jobs() });
      for (const [, list] of pages) {
        const hit = list?.items.find((j) => j.id === jobId);
        if (hit) return hit;
      }
      return undefined;
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
  snapshots: Array<[readonly unknown[], GalleryListResponse | undefined]>;
};

async function snapshotJobsLists(qc: ReturnType<typeof useQueryClient>) {
  await qc.cancelQueries({ queryKey: galleryKeys.jobs() });
  return qc.getQueriesData<GalleryListResponse>({ queryKey: galleryKeys.jobs() });
}

function patchJobsLists(
  qc: ReturnType<typeof useQueryClient>,
  snapshots: FavoritesContext["snapshots"],
  jobId: string,
  favId: string,
  mode: "add" | "remove",
) {
  for (const [key, list] of snapshots) {
    if (!list) continue;
    qc.setQueryData<GalleryListResponse>(key, {
      ...list,
      items: list.items.map((j) => {
        if (j.id !== jobId) return j;
        if (mode === "add") {
          if (j.folderIds.includes(favId)) return j;
          return { ...j, folderIds: [...j.folderIds, favId] };
        }
        return { ...j, folderIds: j.folderIds.filter((id) => id !== favId) };
      }),
    });
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
