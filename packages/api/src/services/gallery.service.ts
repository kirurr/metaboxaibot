/**
 * Gallery business logic shared by Telegram (`/gallery/*`) and web
 * (`/web/gallery/*`) routes. All functions key off internal `User.id` —
 * `telegramId` is never part of this layer.
 *
 * Routes are thin wrappers: parse params → call service → map typed errors
 * (`GalleryNotFoundError` / `GalleryForbiddenError` / `GalleryBadRequestError`)
 * to HTTP 4xx via the local `mapGalleryError` helper in each route file.
 *
 * Behavior here mirrors the original inline logic in `routes/gallery.ts`
 * byte-for-byte (DTO shape, status code mapping, S3 cleanup fan-out,
 * "cannot rename/delete default folder", Favorites auto-create with the
 * Russian name "Избранное"). Do not change semantics without updating both
 * route files in lockstep.
 */

import { db } from "../db.js";
import { getFileUrl, deleteFile } from "./s3.service.js";
import { generateDownloadToken } from "../utils/download-token.js";
import { AI_MODELS, config } from "@metabox/shared";
import type {
  GalleryJob,
  GalleryOutput,
  GalleryFolder,
  GalleryListResponse,
  ListGalleryJobsQuery,
} from "@metabox/shared-browser/dto";

export class GalleryNotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "GalleryNotFoundError";
  }
}

export class GalleryForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "GalleryForbiddenError";
  }
}

export class GalleryBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GalleryBadRequestError";
  }
}

// Wire-формат DTO (Date → ISO string) живёт в @metabox/shared-browser/dto.
// На сервисе мы конвертим Date'ы перед return, чтобы тип service-функций
// совпадал с тем, что увидит фронт. JSON.stringify сам сериализует Date так
// же — wire bytes до/после рефакторинга идентичны, что важно для Telegram
// мини-аппы, чей клиент уже типизирует эти поля как string.
type GalleryOutputDto = GalleryOutput;
type GalleryJobDto = GalleryJob;
type GalleryFolderDto = GalleryFolder;
export type ListJobsParams = ListGalleryJobsQuery;

// SELECT-shape для job'а в gallery-views. Сохраняем как const, чтобы `listJobs`
// и `getJobById` гарантированно тянули одинаковые поля — тогда `serializeJob`
// корректен для обоих.
const JOB_SELECT = {
  id: true,
  section: true,
  modelId: true,
  prompt: true,
  inputData: true,
  tokensSpent: true,
  completedAt: true,
  folderItems: { select: { folderId: true } },
  outputs: {
    orderBy: { index: "asc" as const },
    select: {
      id: true,
      s3Key: true,
      thumbnailS3Key: true,
      outputUrl: true,
    },
  },
} as const;

// Структурный тип под JOB_SELECT. Prisma возвращает Decimal у tokensSpent —
// {toString(): string} | null покрывает и Decimal, и unit-test моки.
type RawJobOutput = {
  id: string;
  s3Key: string | null;
  thumbnailS3Key: string | null;
  outputUrl: string | null;
};

type RawJob = {
  id: string;
  section: string;
  modelId: string;
  prompt: string;
  inputData: unknown;
  tokensSpent: { toString(): string } | null;
  completedAt: Date | null;
  folderItems: { folderId: string }[];
  outputs: RawJobOutput[];
};

function serializeJob(job: RawJob, userId: bigint): GalleryJobDto {
  const base = config.api.publicUrl;
  const model = AI_MODELS[job.modelId];
  const inputData = (job.inputData ?? {}) as Record<string, unknown>;
  const modelSettings = (inputData.modelSettings as Record<string, unknown> | undefined) ?? {};

  const outputs: GalleryOutputDto[] = job.outputs.map((output) => {
    const previewUrl =
      job.section !== "design" && output.s3Key && base
        ? `${base}/download/${generateDownloadToken(output.s3Key, userId)}`
        : output.outputUrl;
    const thumbnailUrl =
      output.thumbnailS3Key && base
        ? `${base}/download/${generateDownloadToken(output.thumbnailS3Key, userId)}`
        : null;
    return {
      id: output.id,
      s3Key: output.s3Key,
      outputUrl: output.outputUrl,
      previewUrl,
      thumbnailUrl,
    };
  });

  return {
    id: job.id,
    section: job.section,
    modelId: job.modelId,
    modelName: model?.name ?? job.modelId,
    prompt: job.prompt,
    modelSettings,
    tokensSpent: job.tokensSpent ? job.tokensSpent.toString() : null,
    completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    folderIds: job.folderItems.map((fi) => fi.folderId),
    outputs,
  };
}

type ListJobsOpts = {
  /**
   * Когда true — выводит избранные jobs первыми (sorted by completedAt desc),
   * затем остальные. Кросс-страничная пагинация: total и порядок согласованы.
   * Web-роут включает этот флаг; Telegram-роут — нет, чтобы поведение
   * `/gallery/*` осталось байт-в-байт (порядок ровно `completedAt desc`).
   */
  favoritesFirst?: boolean;
};

async function listJobs(
  userId: bigint,
  params: ListJobsParams,
  opts: ListJobsOpts = {},
): Promise<GalleryListResponse> {
  const { section, modelId, modelIds, folderId } = params;
  const take = Math.min(params.limit ?? 20, 100);
  const skip = (Math.max(params.page ?? 1, 1) - 1) * take;
  const page = Math.max(params.page ?? 1, 1);

  const modelIdsArray = modelIds ? modelIds.split(",").filter(Boolean) : null;
  const where = {
    userId,
    status: "done",
    ...(section ? { section } : {}),
    ...(modelIdsArray ? { modelId: { in: modelIdsArray } } : modelId ? { modelId } : {}),
    ...(folderId ? { folderItems: { some: { folderId } } } : {}),
  };

  // Favorites-first path — только если флаг и есть default-папка.
  if (opts.favoritesFirst) {
    const favFolder = await db.galleryFolder.findFirst({
      where: { userId, isDefault: true },
      select: { id: true },
    });
    const favId = favFolder?.id;
    if (favId) {
      // AND, а не spread: иначе where.folderItems (фильтр пользователя по
      // папке) был бы перезаписан вторым folderItems-условием.
      const favWhere = { AND: [where, { folderItems: { some: { folderId: favId } } }] };
      const nonFavWhere = { AND: [where, { folderItems: { none: { folderId: favId } } }] };

      const [favCount, nonFavCount] = await Promise.all([
        db.generationJob.count({ where: favWhere }),
        db.generationJob.count({ where: nonFavWhere }),
      ]);

      const rawJobs: RawJob[] = [];

      if (skip < favCount) {
        const favTake = Math.min(take, favCount - skip);
        const favs = await db.generationJob.findMany({
          where: favWhere,
          orderBy: { completedAt: "desc" },
          skip,
          take: favTake,
          select: JOB_SELECT,
        });
        rawJobs.push(...favs);
        if (favTake < take) {
          const rest = await db.generationJob.findMany({
            where: nonFavWhere,
            orderBy: { completedAt: "desc" },
            skip: 0,
            take: take - favTake,
            select: JOB_SELECT,
          });
          rawJobs.push(...rest);
        }
      } else {
        const rest = await db.generationJob.findMany({
          where: nonFavWhere,
          orderBy: { completedAt: "desc" },
          skip: skip - favCount,
          take,
          select: JOB_SELECT,
        });
        rawJobs.push(...rest);
      }

      return {
        items: rawJobs.map((job) => serializeJob(job, userId)),
        total: favCount + nonFavCount,
        page,
        limit: take,
      };
    }
    // favId не найден → fall-through на простой путь.
  }

  const [rawJobs, total] = await Promise.all([
    db.generationJob.findMany({
      where,
      orderBy: { completedAt: "desc" },
      take,
      skip,
      select: JOB_SELECT,
    }),
    db.generationJob.count({ where }),
  ]);

  const items = rawJobs.map((job) => serializeJob(job, userId));
  return { items, total, page, limit: take };
}

async function getJobById(userId: bigint, jobId: string): Promise<GalleryJobDto> {
  const job = await db.generationJob.findFirst({
    where: { id: jobId, userId, status: "done" },
    select: JOB_SELECT,
  });
  if (!job) throw new GalleryNotFoundError("Job not found");
  return serializeJob(job, userId);
}

async function getModelCounts(
  userId: bigint,
  section?: string,
  folderId?: string,
): Promise<{ modelId: string; count: number }[]> {
  const rows = await db.generationJob.groupBy({
    by: ["modelId"],
    where: {
      userId,
      status: "done",
      ...(section ? { section } : {}),
      ...(folderId ? { folderItems: { some: { folderId } } } : {}),
    },
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
  });
  return rows.map((r) => ({ modelId: r.modelId, count: r._count.id }));
}

/**
 * Resolves a playable URL for a single output. Used by both the per-output
 * preview endpoint and the original-url endpoint (when `forceDownload` is
 * true, the S3 URL is signed with attachment-disposition).
 *
 * Note: this is intentionally NOT the same shape as the previewUrl produced
 * inside `listJobs` — that one short-circuits on `section === "design"`,
 * which is a legacy guard preserved verbatim. The per-output endpoints
 * always render `${base}/download/${token}` when s3Key is present.
 */
async function resolveOutputUrl(
  userId: bigint,
  outputId: string,
  forceDownload: boolean,
): Promise<string> {
  const output = await db.generationJobOutput.findUnique({
    where: { id: outputId },
    include: { job: { select: { userId: true } } },
  });
  if (!output) throw new GalleryNotFoundError();
  if (output.job.userId !== userId) throw new GalleryForbiddenError();

  let url: string | null = null;
  if (forceDownload) {
    if (output.s3Key) {
      const filename = output.s3Key.split("/").pop() ?? "file";
      url = await getFileUrl(output.s3Key, filename);
    }
    if (!url) url = output.outputUrl;
  } else {
    const base = config.api.publicUrl;
    url =
      output.s3Key && base
        ? `${base}/download/${generateDownloadToken(output.s3Key, userId)}`
        : output.outputUrl;
  }

  if (!url) throw new GalleryBadRequestError("File not available");
  return url;
}

function getOutputPreviewUrl(userId: bigint, outputId: string): Promise<string> {
  return resolveOutputUrl(userId, outputId, false);
}

function getOutputOriginalUrl(userId: bigint, outputId: string): Promise<string> {
  return resolveOutputUrl(userId, outputId, true);
}

async function deleteJob(userId: bigint, jobId: string): Promise<void> {
  const job = await db.generationJob.findUnique({
    where: { id: jobId },
    select: {
      userId: true,
      outputs: { select: { s3Key: true, thumbnailS3Key: true } },
    },
  });

  if (!job) throw new GalleryNotFoundError();
  if (job.userId !== userId) throw new GalleryForbiddenError();

  await Promise.all(
    job.outputs.flatMap((o) => [
      o.s3Key ? deleteFile(o.s3Key) : Promise.resolve(),
      o.thumbnailS3Key ? deleteFile(o.thumbnailS3Key) : Promise.resolve(),
    ]),
  );

  // outputs cascade-delete via the FK on GenerationJobOutput
  await db.generationJob.delete({ where: { id: jobId } });
}

async function listFolders(userId: bigint): Promise<GalleryFolderDto[]> {
  const folders = await db.galleryFolder.findMany({
    where: { userId },
    include: { _count: { select: { items: true } } },
    orderBy: [{ isPinned: "desc" }, { pinnedAt: "asc" }, { isDefault: "desc" }, { name: "asc" }],
  });

  return folders.map((f) => ({
    id: f.id,
    name: f.name,
    isDefault: f.isDefault,
    isPinned: f.isPinned,
    pinnedAt: f.pinnedAt ? f.pinnedAt.toISOString() : null,
    itemCount: f._count.items,
    createdAt: f.createdAt.toISOString(),
  }));
}

async function createFolder(userId: bigint, name: string): Promise<GalleryFolderDto> {
  if (!name || !name.trim()) throw new GalleryBadRequestError("Name is required");

  const folder = await db.galleryFolder.create({
    data: { userId, name: name.trim() },
  });

  return {
    id: folder.id,
    name: folder.name,
    isDefault: false,
    isPinned: false,
    pinnedAt: null,
    itemCount: 0,
    createdAt: folder.createdAt.toISOString(),
  };
}

async function updateFolder(
  userId: bigint,
  folderId: string,
  patch: { name?: string; isPinned?: boolean },
): Promise<GalleryFolderDto> {
  const { name, isPinned } = patch;

  const folder = await db.galleryFolder.findUnique({ where: { id: folderId } });
  if (!folder) throw new GalleryNotFoundError();
  if (folder.userId !== userId) throw new GalleryForbiddenError();
  if (name !== undefined && folder.isDefault)
    throw new GalleryBadRequestError("Cannot rename default folder");
  if (name !== undefined && !name.trim()) throw new GalleryBadRequestError("Name is required");

  const updated = await db.galleryFolder.update({
    where: { id: folderId },
    data: {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(isPinned !== undefined ? { isPinned, pinnedAt: isPinned ? new Date() : null } : {}),
    },
    include: { _count: { select: { items: true } } },
  });

  return {
    id: updated.id,
    name: updated.name,
    isDefault: updated.isDefault,
    isPinned: updated.isPinned,
    pinnedAt: updated.pinnedAt ? updated.pinnedAt.toISOString() : null,
    itemCount: updated._count.items,
    createdAt: updated.createdAt.toISOString(),
  };
}

async function deleteFolder(userId: bigint, folderId: string): Promise<void> {
  const folder = await db.galleryFolder.findUnique({ where: { id: folderId } });
  if (!folder) throw new GalleryNotFoundError();
  if (folder.userId !== userId) throw new GalleryForbiddenError();
  if (folder.isDefault) throw new GalleryBadRequestError("Cannot delete default folder");

  await db.galleryFolder.delete({ where: { id: folderId } });
}

async function addJobToFolder(userId: bigint, folderId: string, jobId: string): Promise<void> {
  const folder = await db.galleryFolder.findUnique({ where: { id: folderId } });
  if (!folder) throw new GalleryNotFoundError();
  if (folder.userId !== userId) throw new GalleryForbiddenError();

  const job = await db.generationJob.findUnique({
    where: { id: jobId },
    select: { userId: true },
  });
  if (!job) throw new GalleryNotFoundError("Job not found");
  if (job.userId !== userId) throw new GalleryForbiddenError();

  await db.galleryFolderItem.upsert({
    where: { folderId_jobId: { folderId, jobId } },
    create: { folderId, jobId },
    update: {},
  });
}

async function removeJobFromFolder(userId: bigint, folderId: string, jobId: string): Promise<void> {
  const folder = await db.galleryFolder.findUnique({ where: { id: folderId } });
  if (!folder) throw new GalleryNotFoundError();
  if (folder.userId !== userId) throw new GalleryForbiddenError();

  await db.galleryFolderItem.deleteMany({ where: { folderId, jobId } });
}

async function addToFavorites(userId: bigint, jobId: string): Promise<{ folderId: string }> {
  const job = await db.generationJob.findUnique({
    where: { id: jobId },
    select: { userId: true },
  });
  if (!job) throw new GalleryNotFoundError("Job not found");
  if (job.userId !== userId) throw new GalleryForbiddenError();

  let favorites = await db.galleryFolder.findFirst({ where: { userId, isDefault: true } });
  if (!favorites) {
    favorites = await db.galleryFolder.create({
      data: { userId, name: "Избранное", isDefault: true },
    });
  }

  await db.galleryFolderItem.upsert({
    where: { folderId_jobId: { folderId: favorites.id, jobId } },
    create: { folderId: favorites.id, jobId },
    update: {},
  });

  return { folderId: favorites.id };
}

async function removeFromFavorites(userId: bigint, jobId: string): Promise<void> {
  const favorites = await db.galleryFolder.findFirst({ where: { userId, isDefault: true } });
  if (!favorites) throw new GalleryNotFoundError("No favorites folder");

  await db.galleryFolderItem.deleteMany({ where: { folderId: favorites.id, jobId } });
}

export const galleryService = {
  listJobs,
  getJobById,
  getModelCounts,
  getOutputPreviewUrl,
  getOutputOriginalUrl,
  deleteJob,
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  addJobToFolder,
  removeJobFromFolder,
  addToFavorites,
  removeFromFavorites,
};
