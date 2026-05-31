/**
 * Gallery business logic shared by Telegram (`/gallery/*`) and web
 * (`/web/gallery/*`) routes. All functions key off internal `User.id` —
 * `telegramId` is never part of this layer.
 *
 * Routes are thin wrappers: parse params → call service → map typed errors
 * (`GalleryNotFoundError` / `GalleryForbiddenError` / `GalleryBadRequestError`)
 * to HTTP 4xx via the local `mapGalleryError` helper in each route file.
 *
 * История: до 2026-05-31 list-эндпоинт группировал outputs под job'у; фавориты
 * и папки висели на job'е. После — один output = один item в списке, фавориты и
 * папки на output'е. `getJobById` остался для лайтбокса (`/web/gallery/jobs/:id`):
 * job + outputs (у каждого свой `folderIds`).
 */

import { db } from "../db.js";
import { getFileUrl, deleteFile } from "./s3.service.js";
import { generateDownloadToken } from "../utils/download-token.js";
import { AI_MODELS, config } from "@metabox/shared";
import type {
  GalleryOutput,
  GalleryItem,
  GalleryJobDetail,
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

type GalleryOutputDto = GalleryOutput;
type GalleryItemDto = GalleryItem;
type GalleryJobDetailDto = GalleryJobDetail;
type GalleryFolderDto = GalleryFolder;
export type ListJobsParams = ListGalleryJobsQuery;

// SELECT-shape для output'а. Тащим job-контекст inline через relation — этого
// достаточно и для серилизации в `GalleryItem`, и для проверки ownership при
// folder-операциях.
const OUTPUT_SELECT = {
  id: true,
  index: true,
  s3Key: true,
  thumbnailS3Key: true,
  outputUrl: true,
  folderItems: { select: { folderId: true } },
  job: {
    select: {
      id: true,
      userId: true,
      section: true,
      modelId: true,
      prompt: true,
      inputData: true,
      tokensSpent: true,
      completedAt: true,
      _count: { select: { outputs: true } },
    },
  },
} as const;

type RawOutput = {
  id: string;
  index: number;
  s3Key: string | null;
  thumbnailS3Key: string | null;
  outputUrl: string | null;
  folderItems: { folderId: string }[];
  job: {
    id: string;
    userId: bigint;
    section: string;
    modelId: string;
    prompt: string;
    inputData: unknown;
    tokensSpent: { toString(): string } | null;
    completedAt: Date | null;
    _count: { outputs: number };
  };
};

function buildPreviewUrl(
  section: string,
  s3Key: string | null,
  outputUrl: string | null,
  userId: bigint,
): string | null {
  const base = config.api.publicUrl;
  // section === "design" — legacy guard: dev-инструмент рисовал на чужом домене,
  // короткоживущий outputUrl всё ещё нужен. Сохраняем поведение byte-for-byte.
  if (section !== "design" && s3Key && base) {
    return `${base}/download/${generateDownloadToken(s3Key, userId)}`;
  }
  return outputUrl;
}

function buildThumbnailUrl(thumbnailS3Key: string | null, userId: bigint): string | null {
  const base = config.api.publicUrl;
  if (thumbnailS3Key && base) {
    return `${base}/download/${generateDownloadToken(thumbnailS3Key, userId)}`;
  }
  return null;
}

function serializeItem(row: RawOutput, userId: bigint): GalleryItemDto {
  const inputData = (row.job.inputData ?? {}) as Record<string, unknown>;
  const modelSettings = (inputData.modelSettings as Record<string, unknown> | undefined) ?? {};
  const model = AI_MODELS[row.job.modelId];
  return {
    id: row.id,
    jobId: row.job.id,
    section: row.job.section,
    modelId: row.job.modelId,
    modelName: model?.name ?? row.job.modelId,
    prompt: row.job.prompt,
    modelSettings,
    tokensSpent: row.job.tokensSpent ? row.job.tokensSpent.toString() : null,
    completedAt: row.job.completedAt ? row.job.completedAt.toISOString() : null,
    folderIds: row.folderItems.map((fi) => fi.folderId),
    s3Key: row.s3Key,
    outputUrl: row.outputUrl,
    previewUrl: buildPreviewUrl(row.job.section, row.s3Key, row.outputUrl, userId),
    thumbnailUrl: buildThumbnailUrl(row.thumbnailS3Key, userId),
    index: row.index,
    batchSize: row.job._count.outputs,
  };
}

type ListJobsOpts = {
  /**
   * Когда true — выводит favorite outputs первыми (sorted by job.completedAt
   * desc, затем index asc), затем остальные. Кросс-страничная пагинация: total
   * и порядок согласованы. Web-роут включает этот флаг; Telegram-роут — нет.
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

  // Where строится на уровне output'а — фильтры по section/modelId/userId
  // пробрасываются через relation `job`. Filter по `folderId` — через own
  // `folderItems`, т.к. фавориты и папки теперь output-level.
  const where = {
    job: {
      userId,
      status: "done",
      ...(section ? { section } : {}),
      ...(modelIdsArray ? { modelId: { in: modelIdsArray } } : modelId ? { modelId } : {}),
    },
    ...(folderId ? { folderItems: { some: { folderId } } } : {}),
  };

  // Сортировка: новые джобы сверху, внутри пачки — по index. Output'ы одной
  // джобы получают одинаковый `completedAt`, так что secondary key даёт
  // стабильный порядок 0,1,2,3 внутри пачки.
  const orderBy = [{ job: { completedAt: "desc" as const } }, { index: "asc" as const }];

  // Favorites-first path — только если флаг и есть default-папка.
  if (opts.favoritesFirst) {
    const favFolder = await db.galleryFolder.findFirst({
      where: { userId, isDefault: true },
      select: { id: true },
    });
    const favId = favFolder?.id;
    if (favId) {
      const favWhere = { AND: [where, { folderItems: { some: { folderId: favId } } }] };
      const nonFavWhere = { AND: [where, { folderItems: { none: { folderId: favId } } }] };

      const [favCount, nonFavCount] = await Promise.all([
        db.generationJobOutput.count({ where: favWhere }),
        db.generationJobOutput.count({ where: nonFavWhere }),
      ]);

      const rows: RawOutput[] = [];

      if (skip < favCount) {
        const favTake = Math.min(take, favCount - skip);
        const favs = await db.generationJobOutput.findMany({
          where: favWhere,
          orderBy,
          skip,
          take: favTake,
          select: OUTPUT_SELECT,
        });
        rows.push(...favs);
        if (favTake < take) {
          const rest = await db.generationJobOutput.findMany({
            where: nonFavWhere,
            orderBy,
            skip: 0,
            take: take - favTake,
            select: OUTPUT_SELECT,
          });
          rows.push(...rest);
        }
      } else {
        const rest = await db.generationJobOutput.findMany({
          where: nonFavWhere,
          orderBy,
          skip: skip - favCount,
          take,
          select: OUTPUT_SELECT,
        });
        rows.push(...rest);
      }

      return {
        items: rows.map((row) => serializeItem(row, userId)),
        total: favCount + nonFavCount,
        page,
        limit: take,
      };
    }
  }

  const [rows, total] = await Promise.all([
    db.generationJobOutput.findMany({
      where,
      orderBy,
      take,
      skip,
      select: OUTPUT_SELECT,
    }),
    db.generationJobOutput.count({ where }),
  ]);

  return {
    items: rows.map((row) => serializeItem(row, userId)),
    total,
    page,
    limit: take,
  };
}

const JOB_DETAIL_SELECT = {
  id: true,
  section: true,
  modelId: true,
  prompt: true,
  inputData: true,
  tokensSpent: true,
  completedAt: true,
  outputs: {
    orderBy: { index: "asc" as const },
    select: {
      id: true,
      index: true,
      s3Key: true,
      thumbnailS3Key: true,
      outputUrl: true,
      folderItems: { select: { folderId: true } },
    },
  },
} as const;

type RawJobDetail = {
  id: string;
  section: string;
  modelId: string;
  prompt: string;
  inputData: unknown;
  tokensSpent: { toString(): string } | null;
  completedAt: Date | null;
  outputs: Array<{
    id: string;
    index: number;
    s3Key: string | null;
    thumbnailS3Key: string | null;
    outputUrl: string | null;
    folderItems: { folderId: string }[];
  }>;
};

function serializeJobDetail(job: RawJobDetail, userId: bigint): GalleryJobDetailDto {
  const inputData = (job.inputData ?? {}) as Record<string, unknown>;
  const modelSettings = (inputData.modelSettings as Record<string, unknown> | undefined) ?? {};
  const model = AI_MODELS[job.modelId];
  const outputs: GalleryOutputDto[] = job.outputs.map((output) => ({
    id: output.id,
    s3Key: output.s3Key,
    outputUrl: output.outputUrl,
    previewUrl: buildPreviewUrl(job.section, output.s3Key, output.outputUrl, userId),
    thumbnailUrl: buildThumbnailUrl(output.thumbnailS3Key, userId),
    folderIds: output.folderItems.map((fi) => fi.folderId),
    index: output.index,
  }));
  return {
    id: job.id,
    section: job.section,
    modelId: job.modelId,
    modelName: model?.name ?? job.modelId,
    prompt: job.prompt,
    modelSettings,
    tokensSpent: job.tokensSpent ? job.tokensSpent.toString() : null,
    completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    outputs,
  };
}

async function getJobById(userId: bigint, jobId: string): Promise<GalleryJobDetailDto> {
  const job = await db.generationJob.findFirst({
    where: { id: jobId, userId, status: "done" },
    select: JOB_DETAIL_SELECT,
  });
  if (!job) throw new GalleryNotFoundError("Job not found");
  return serializeJobDetail(job, userId);
}

async function getModelCounts(
  userId: bigint,
  section?: string,
  folderId?: string,
): Promise<{ modelId: string; count: number }[]> {
  // Считаем количество outputs по модели — после refactor'а карточек.
  // Group by modelId через `job` relation: Prisma groupBy не умеет включать
  // поля через relation, поэтому делаем raw-aggregation в два прохода:
  // 1) тащим plane (outputId, modelId), 2) считаем в JS. Альтернатива —
  // raw query, но это hot path только при смене секции, объём — десятки
  // тысяч записей max, в JS быстро.
  const rows = await db.generationJobOutput.findMany({
    where: {
      job: {
        userId,
        status: "done",
        ...(section ? { section } : {}),
      },
      ...(folderId ? { folderItems: { some: { folderId } } } : {}),
    },
    select: { job: { select: { modelId: true } } },
  });
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.job.modelId, (counts.get(r.job.modelId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([modelId, count]) => ({ modelId, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Resolves a playable URL for a single output. Used by both the per-output
 * preview endpoint and the original-url endpoint (when `forceDownload` is
 * true, the S3 URL is signed with attachment-disposition).
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

  // outputs cascade-delete via the FK on GenerationJobOutput; folderItems
  // cascade-delete за outputs.
  await db.generationJob.delete({ where: { id: jobId } });
}

/**
 * Удаляет один output (картинку/видео) джобы + его S3-артефакты. Если это был
 * последний output — удаляет всю джобу целиком (`jobDeleted: true`), иначе
 * остаётся джоба с остальными output'ами.
 */
async function deleteOutput(userId: bigint, outputId: string): Promise<{ jobDeleted: boolean }> {
  const output = await db.generationJobOutput.findUnique({
    where: { id: outputId },
    select: { id: true, jobId: true, s3Key: true, thumbnailS3Key: true },
  });
  if (!output) throw new GalleryNotFoundError();

  const job = await db.generationJob.findUnique({
    where: { id: output.jobId },
    select: { id: true, userId: true, _count: { select: { outputs: true } } },
  });
  if (!job) throw new GalleryNotFoundError();
  if (job.userId !== userId) throw new GalleryForbiddenError();

  await Promise.all([
    output.s3Key ? deleteFile(output.s3Key) : Promise.resolve(),
    output.thumbnailS3Key ? deleteFile(output.thumbnailS3Key) : Promise.resolve(),
  ]);

  if (job._count.outputs <= 1) {
    await db.generationJob.delete({ where: { id: job.id } });
    return { jobDeleted: true };
  }
  await db.generationJobOutput.delete({ where: { id: outputId } });
  return { jobDeleted: false };
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

/**
 * Загружает output вместе с владельцем-job'ой; бросает 404/403 если нет/чужой.
 * Используется всеми folder/favorites операциями — выносим вверх чтобы не
 * дублировать проверку в каждой функции.
 */
async function assertOutputOwned(
  userId: bigint,
  outputId: string,
): Promise<{ outputId: string; jobUserId: bigint }> {
  const output = await db.generationJobOutput.findUnique({
    where: { id: outputId },
    select: { id: true, job: { select: { userId: true } } },
  });
  if (!output) throw new GalleryNotFoundError("Output not found");
  if (output.job.userId !== userId) throw new GalleryForbiddenError();
  return { outputId: output.id, jobUserId: output.job.userId };
}

async function addOutputToFolder(
  userId: bigint,
  folderId: string,
  outputId: string,
): Promise<void> {
  const folder = await db.galleryFolder.findUnique({ where: { id: folderId } });
  if (!folder) throw new GalleryNotFoundError();
  if (folder.userId !== userId) throw new GalleryForbiddenError();

  await assertOutputOwned(userId, outputId);

  await db.galleryFolderItem.upsert({
    where: { folderId_outputId: { folderId, outputId } },
    create: { folderId, outputId },
    update: {},
  });
}

async function removeOutputFromFolder(
  userId: bigint,
  folderId: string,
  outputId: string,
): Promise<void> {
  const folder = await db.galleryFolder.findUnique({ where: { id: folderId } });
  if (!folder) throw new GalleryNotFoundError();
  if (folder.userId !== userId) throw new GalleryForbiddenError();

  await db.galleryFolderItem.deleteMany({ where: { folderId, outputId } });
}

async function addToFavorites(userId: bigint, outputId: string): Promise<{ folderId: string }> {
  await assertOutputOwned(userId, outputId);

  let favorites = await db.galleryFolder.findFirst({ where: { userId, isDefault: true } });
  if (!favorites) {
    favorites = await db.galleryFolder.create({
      data: { userId, name: "Избранное", isDefault: true },
    });
  }

  await db.galleryFolderItem.upsert({
    where: { folderId_outputId: { folderId: favorites.id, outputId } },
    create: { folderId: favorites.id, outputId },
    update: {},
  });

  return { folderId: favorites.id };
}

async function removeFromFavorites(userId: bigint, outputId: string): Promise<void> {
  const favorites = await db.galleryFolder.findFirst({ where: { userId, isDefault: true } });
  if (!favorites) throw new GalleryNotFoundError("No favorites folder");

  await db.galleryFolderItem.deleteMany({ where: { folderId: favorites.id, outputId } });
}

export const galleryService = {
  listJobs,
  getJobById,
  getModelCounts,
  getOutputPreviewUrl,
  getOutputOriginalUrl,
  deleteJob,
  deleteOutput,
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  addOutputToFolder,
  removeOutputFromFolder,
  addToFavorites,
  removeFromFavorites,
};
