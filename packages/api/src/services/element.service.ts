import { db } from "../db.js";
import { Prisma } from "@prisma/client";
import type { Element, UploadedMedia } from "@prisma/client";

/**
 * Element — именованный (@-тег) набор референсных изображений пользователя.
 * Картинки — это строки UploadedMedia с проставленным elementId (исключены из
 * общего списка переиспользования). Удаление элемента каскадит media-строки;
 * S3-объекты не трогаем (тот же s3Key может жить в отправленном сообщении).
 */

/** Имя элемента уже занято этим пользователем (нарушение @@unique([userId, name])). */
export class ElementNameConflictError extends Error {
  constructor() {
    super("Element name already exists");
    this.name = "ElementNameConflictError";
  }
}

export type ElementWithMedia = Element & { media: UploadedMedia[] };

export interface AddElementMediaParams {
  s3Key: string;
  name: string;
  mimeType: string;
  size: number;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

const mediaInclude = { media: { orderBy: { id: "desc" } } } as const;

export const elementService = {
  /** Все элементы юзера, newest-first, с вложенными media (тоже newest-first). */
  async list(userId: bigint): Promise<ElementWithMedia[]> {
    return db.element.findMany({
      where: { userId },
      orderBy: { id: "desc" },
      include: mediaInclude,
    });
  },

  async create(userId: bigint, name: string): Promise<ElementWithMedia> {
    try {
      return await db.element.create({ data: { userId, name }, include: mediaInclude });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ElementNameConflictError();
      throw err;
    }
  },

  /** Переименование. null — элемент не найден / чужой. Бросает конфликт при дубле. */
  async rename(userId: bigint, id: string, name: string): Promise<ElementWithMedia | null> {
    const existing = await db.element.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) return null;
    try {
      return await db.element.update({ where: { id }, data: { name }, include: mediaInclude });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ElementNameConflictError();
      throw err;
    }
  },

  async delete(userId: bigint, id: string): Promise<boolean> {
    // deleteMany с userId в where — одна проверка владения и удаление в одном
    // запросе; media каскадятся по FK. count === 0 → не найдено / чужой.
    const { count } = await db.element.deleteMany({ where: { id, userId } });
    return count > 0;
  },

  /** Добавляет картинку в элемент. null — элемент не найден / чужой. */
  async addMedia(
    userId: bigint,
    elementId: string,
    params: AddElementMediaParams,
  ): Promise<UploadedMedia | null> {
    const element = await db.element.findUnique({ where: { id: elementId } });
    if (!element || element.userId !== userId) return null;
    return db.uploadedMedia.create({
      data: { userId, type: "image", elementId, ...params },
    });
  },

  /** Удаляет картинку из элемента (только строку, S3 не трогаем). */
  async removeMedia(userId: bigint, elementId: string, mediaId: string): Promise<boolean> {
    // Все три условия в where — строка удалится только если принадлежит юзеру
    // и именно этому элементу. count === 0 → не найдено / чужое.
    const { count } = await db.uploadedMedia.deleteMany({
      where: { id: mediaId, elementId, userId },
    });
    return count > 0;
  },
};
