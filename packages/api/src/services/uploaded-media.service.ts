import { db } from "../db.js";
import type { UploadedMedia, Prisma } from "@prisma/client";

export interface ListUploadedMediaParams {
  userId: bigint;
  type?: string;
  cursor?: string;
  take?: number;
}

export interface UploadedMediaPage {
  items: UploadedMedia[];
  nextCursor: string | null;
}

export interface CreateUploadedMediaParams {
  userId: bigint;
  type: string;
  s3Key: string;
  name: string;
  mimeType: string;
  size: number;
  // Если задан — медиа привязано к Element'у и исключается из общего списка.
  elementId?: string;
}

export const uploadedMediaService = {
  async list(params: ListUploadedMediaParams): Promise<UploadedMediaPage> {
    const { userId, type, cursor, take = 20 } = params;

    const where: Prisma.UploadedMediaWhereInput = {
      userId,
      // Картинки, привязанные к Element'у, в общий список переиспользования
      // не попадают (питают только /web/elements).
      elementId: null,
      ...(type ? { type } : {}),
      ...(cursor ? { id: { lt: cursor } } : {}),
    };

    const items = await db.uploadedMedia.findMany({
      where,
      orderBy: { id: "desc" },
      take: take + 1,
    });

    const hasMore = items.length > take;
    if (hasMore) items.pop();

    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  async create(params: CreateUploadedMediaParams): Promise<UploadedMedia> {
    return db.uploadedMedia.create({ data: params });
  },

  /**
   * Удаляет ТОЛЬКО запись (S3-объект не трогаем — тот же s3Key может быть в
   * отправленном Message.attachments или в чужом черновике). Чужую запись
   * (userId не совпал) не удаляем — возвращаем false.
   */
  async delete(userId: bigint, id: string): Promise<boolean> {
    const existing = await db.uploadedMedia.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) return false;
    await db.uploadedMedia.delete({ where: { id } });
    return true;
  },
};
