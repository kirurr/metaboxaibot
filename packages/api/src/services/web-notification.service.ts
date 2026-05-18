import type { JobNotificationMessage } from "@metabox/shared";
import type { WebNotificationDTO, WebNotificationType } from "@metabox/shared-browser/ws";
import type { Prisma, WebNotification } from "@prisma/client";
import { db } from "../db.js";
import { logger } from "../logger.js";
import { emitToUser } from "./ws-bus.service.js";
import { getFileUrl } from "./s3.service.js";

export interface CreateWebNotificationParams {
  userId: bigint;
  type: string;
  title: string;
  message: string;
  jobId?: string | null;
  data?: Prisma.InputJsonValue;
}

export const webNotificationService = {
  /**
   * Все уведомления юзера, новые сверху. Отдаются фронту в WS-snapshot'е
   * при подключении; статус `isSeen` фронт отображает у себя.
   */
  async listByUser(userId: bigint): Promise<WebNotification[]> {
    return db.webNotification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  },

  async create(params: CreateWebNotificationParams): Promise<WebNotification> {
    return db.webNotification.create({
      data: {
        userId: params.userId,
        type: params.type,
        title: params.title,
        message: params.message,
        jobId: params.jobId ?? null,
        data: params.data,
      },
    });
  },

  /**
   * Удаление scope'ится по userId — нельзя удалить чужое уведомление, даже
   * зная его id. Возвращает true, если запись была удалена.
   */
  async delete(id: string, userId: bigint): Promise<boolean> {
    const { count } = await db.webNotification.deleteMany({ where: { id, userId } });
    return count > 0;
  },

  /**
   * Помечает несколько уведомлений как прочитанные одним запросом.
   * Scope по userId — чужие записи не трогаем. Уже прочитанные исключаем,
   * чтобы не бампать updatedAt зря. Возвращает количество обновлённых строк.
   */
  async markAsSeen(ids: string[], userId: bigint): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await db.webNotification.updateMany({
      where: { id: { in: ids }, userId, isSeen: false },
      data: { isSeen: true },
    });
    return count;
  },
};

/** Prisma WebNotification → WS DTO (без userId/updatedAt; createdAt в ISO). */
export function toWebNotificationDTO(row: WebNotification): WebNotificationDTO {
  return {
    id: row.id,
    jobId: row.jobId,
    type: row.type as WebNotificationType,
    title: row.title,
    message: row.message,
    isSeen: row.isSeen,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
  };
}

const SECTION_LABEL_RU: Record<JobNotificationMessage["section"], string> = {
  image: "изображения",
  video: "видео",
  audio: "аудио",
  avatar: "аватара",
};

function buildText(msg: JobNotificationMessage): { title: string; message: string } {
  const section = SECTION_LABEL_RU[msg.section];
  if (msg.kind === "error") {
    return { title: `Ошибка генерации ${section}`, message: msg.userMessage };
  }
  if (msg.partial) {
    return {
      title: `Генерация ${section} частично готова`,
      message: `Готово ${msg.partial.success} из ${msg.partial.total}`,
    };
  }
  return { title: `Генерация ${section} готова`, message: "Результат готов" };
}

async function buildData(msg: JobNotificationMessage): Promise<Prisma.InputJsonValue> {
  if (msg.kind === "success") {
    // Заменяем provider-URL на presigned S3 URL ещё на этапе диспатча: фронт
    // получает стабильную ссылку на наш storage, а не временный provider-link
    // (последний может быть закрыт CDN'ом или экспайрнуться к моменту клика).
    // s3Key оставляем — фронт может перепресайнить через `/web/generations`.
    const outputs = await Promise.all(
      msg.outputs.map(async (o) => {
        const presigned = o.s3Key ? await getFileUrl(o.s3Key).catch(() => null) : null;
        return {
          id: o.id,
          s3Key: o.s3Key,
          outputUrl: presigned ?? o.outputUrl,
        };
      }),
    );
    return {
      outputs,
      ...(msg.partial ? { partial: msg.partial } : {}),
    } as unknown as Prisma.InputJsonValue;
  }
  return (msg.errorCode ? { errorCode: msg.errorCode } : {}) as unknown as Prisma.InputJsonValue;
}

/**
 * Принимает событие из Redis-канала `job-notifications`, записывает persistent
 * уведомление в БД и пушит его в WS-комнату юзера (`notification:new`).
 *
 * Вызывается из callback'а `startJobNotificationsSubscriber` в index.ts. Если
 * io ещё не инициализирован — emit залогируется и пропустится, но запись в БД
 * всё равно есть → юзер получит её при следующем `notification:snapshot`.
 */
export async function dispatchJobNotification(msg: JobNotificationMessage): Promise<void> {
  const userId = BigInt(msg.userId);
  const type = `${msg.section}_${msg.kind}` as WebNotificationType;
  const { title, message } = buildText(msg);

  // Аватар не пишется в `generation_jobs`, поэтому FK `WebNotification.jobId`
  // ставим в null, а сам `userAvatarId` (приходит как msg.dbJobId) сохраняем
  // внутри `data` — фронту хватит его для навигации/обновления карточки.
  const isAvatar = msg.section === "avatar";
  const baseData = await buildData(msg);
  const row = await webNotificationService.create({
    userId,
    jobId: isAvatar ? null : msg.dbJobId,
    type,
    title,
    message,
    data: isAvatar
      ? ({
          ...(baseData as Record<string, unknown>),
          userAvatarId: msg.dbJobId,
        } as Prisma.InputJsonValue)
      : baseData,
  });

  emitToUser(userId, "notification:new", toWebNotificationDTO(row));
  logger.info(
    { userId: userId.toString(), type, jobId: row.jobId, id: row.id },
    "web-notification dispatched",
  );
}
