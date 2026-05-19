import { db } from "../db.js";
import { AI_MODELS } from "@metabox/shared";
import type { Section } from "@metabox/shared";
import type { Dialog, Message, Prisma } from "@prisma/client";
import { userStateService } from "./user-state.service.js";

/**
 * Reserved map-key для env-fallback ключа (когда acquireKey не дал DB-tracked
 * keyId, мы возвращаем acquired.keyId === null). Не пересекается с CUID'ами
 * ProviderKey.id, потому что они никогда не начинаются с подчёркивания.
 */
export const OPENAI_ENV_KEY = "_env";

/** Shape of one entry in Message.attachments JSON array. */
export interface StoredAttachment {
  s3Key: string;
  mimeType: string;
  name: string;
  size?: number;
  /**
   * OpenAI Files API file_id'ы по uploading keyId.
   *
   * file_id привязан к organization своего ключа — если ключи pool'а в разных
   * org'ах, на каждый key нужен отдельный upload. Map позволяет хранить
   * результаты всех upload'ов и переиспользовать их при rotation: при
   * повторном acquire'е старого ключа берём кэшированный file_id, не делаем
   * лишний upload.
   *
   * Map-key:
   *  - cuid из ProviderKey.id для DB-tracked keys
   *  - `OPENAI_ENV_KEY` ("_env") для env-fallback (acquireKey вернул keyId=null)
   *
   * Map-value: file_id из `/v1/files` (`file-...`).
   */
  openaiFileIds?: Record<string, string>;
  /**
   * @deprecated Используй openaiFileIds. Поля сохранены для backward-compat
   * чтения старых записей до миграции на map. На запись больше не выставляются.
   */
  openaiFileId?: string;
  /** @deprecated См. openaiFileIds. */
  openaiKeyId?: string | null;
}

/**
 * Возвращает file_id'ы attachment'а по uploading keyId, normalising legacy
 * формат (single openaiFileId + openaiKeyId) в map.
 */
export function readOpenAIFileIds(att: StoredAttachment): Record<string, string> {
  if (att.openaiFileIds && Object.keys(att.openaiFileIds).length > 0) {
    return att.openaiFileIds;
  }
  if (att.openaiFileId) {
    const key = att.openaiKeyId ?? OPENAI_ENV_KEY;
    return { [key]: att.openaiFileId };
  }
  return {};
}

/**
 * Подрезает `content` вокруг первого матча `q` до ~140 символов с эллипсами
 * по краям. Используется для history-снippet'а в UI поиска.
 */
function buildSnippet(content: string, q: string): string {
  const MAX = 140;
  if (!q) return content.length > MAX ? content.slice(0, MAX) + "…" : content;
  const idx = content.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return content.length > MAX ? content.slice(0, MAX) + "…" : content;
  const around = 60;
  const start = Math.max(0, idx - around);
  const end = Math.min(content.length, idx + q.length + around);
  const left = start > 0 ? "…" : "";
  const right = end < content.length ? "…" : "";
  return left + content.slice(start, end) + right;
}

export interface CreateDialogParams {
  userId: bigint;
  section: Section;
  modelId: string;
  title?: string;
}

export const dialogService = {
  async create(params: CreateDialogParams): Promise<Dialog> {
    const model = AI_MODELS[params.modelId];
    if (!model) throw new Error(`Unknown model: ${params.modelId}`);

    const dialog = await db.dialog.create({
      data: {
        userId: params.userId,
        section: params.section,
        modelId: params.modelId,
        title: params.title ?? null,
        contextStrategy: model.contextStrategy,
      },
    });

    // Copy settings from the most recent non-deleted dialog with the same model
    const donor = await db.dialog.findFirst({
      where: {
        userId: params.userId,
        modelId: params.modelId,
        isDeleted: false,
        id: { not: dialog.id },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (donor) {
      const donorSettings = await userStateService.getDialogSettings(params.userId, donor.id);
      if (Object.keys(donorSettings).length > 0) {
        await userStateService.setDialogSettings(params.userId, dialog.id, donorSettings);
      }
    }

    return dialog;
  },

  async findById(dialogId: string): Promise<Dialog | null> {
    return db.dialog.findUnique({ where: { id: dialogId } });
  },

  async listByUser(userId: bigint, section?: Section): Promise<Dialog[]> {
    return db.dialog.findMany({
      where: { userId, ...(section ? { section } : {}), isDeleted: false },
      orderBy: { updatedAt: "desc" },
    });
  },

  /**
   * История с опциональным поиском (title + содержимое сообщений) и
   * агрегацией токенов. Используется страницей /history.
   *
   * - Без `q` и `withStats` поведение совпадает с listByUser (плюс возвращается
   *   расширенный тип с `null` extras), регрессий для существующих вызовов нет.
   * - С `q` ищем по `title ILIKE %q%` ИЛИ по содержимому non-failed сообщений,
   *   плюс одним батчем достаём первый matching snippet на диалог.
   * - С `withStats` одним groupBy суммируем `tokensUsed` всех сообщений.
   *
   * Возвращает плоский список — пагинация пока не нужна (см. AIBOX-22 plan).
   */
  async listForHistory(
    userId: bigint,
    opts: { section?: Section; q?: string; withStats?: boolean } = {},
  ): Promise<
    Array<
      Dialog & {
        totalTokens?: number;
        snippet?: string | null;
        latestJobId?: string | null;
      }
    >
  > {
    const q = opts.q?.trim() ?? "";
    const where = {
      userId,
      isDeleted: false,
      ...(opts.section ? { section: opts.section } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" as const } },
              {
                messages: {
                  some: {
                    failed: false,
                    content: { contains: q, mode: "insensitive" as const },
                  },
                },
              },
            ],
          }
        : {}),
    };

    const dialogs = await db.dialog.findMany({
      where,
      orderBy: { updatedAt: "desc" },
    });
    if (dialogs.length === 0) return [];

    const ids = dialogs.map((d) => d.id);
    // Параллельно: токены сообщений (gpt) + токены generation-job'ов
    // (image/video/audio) + сниппеты по q + latest done-job per dialog для
    // навигации /gallery/:jobId со страницы /history.
    const [messageTotals, jobTotals, snippets, latestJobs] = await Promise.all([
      opts.withStats
        ? db.message.groupBy({
            by: ["dialogId"],
            where: { dialogId: { in: ids } },
            _sum: { tokensUsed: true },
          })
        : Promise.resolve([] as Array<{ dialogId: string; _sum: { tokensUsed: unknown } }>),
      opts.withStats
        ? db.generationJob.groupBy({
            by: ["dialogId"],
            where: { dialogId: { in: ids } },
            _sum: { tokensSpent: true },
          })
        : Promise.resolve([] as Array<{ dialogId: string; _sum: { tokensSpent: unknown } }>),
      q
        ? db.message.findMany({
            where: {
              dialogId: { in: ids },
              failed: false,
              content: { contains: q, mode: "insensitive" as const },
            },
            // `distinct` + `orderBy` дают по одному (последнему) сообщению per
            // dialog — этого хватает для UI-сниппета.
            orderBy: { createdAt: "desc" },
            distinct: ["dialogId"],
            select: { dialogId: true, content: true },
          })
        : Promise.resolve([] as Array<{ dialogId: string; content: string }>),
      // latestJobId — последний завершённый job per dialog. Для gpt-диалогов
      // вернётся пустой набор. Дёргаем всегда: дёшево (индекс по dialogId)
      // и нужен для роутинга в UI.
      db.generationJob.findMany({
        where: { dialogId: { in: ids }, status: "done" },
        orderBy: { createdAt: "desc" },
        distinct: ["dialogId"],
        select: { dialogId: true, id: true },
      }),
    ]);

    const messageTotalsByDialog = new Map<string, number>(
      messageTotals.map((t) => [t.dialogId, Number(t._sum.tokensUsed ?? 0)]),
    );
    const jobTotalsByDialog = new Map<string, number>(
      jobTotals.map((t) => [t.dialogId, Number(t._sum.tokensSpent ?? 0)]),
    );
    const snippetsByDialog = new Map<string, string>(
      snippets.map((s) => [s.dialogId, buildSnippet(s.content, q)]),
    );
    const latestJobByDialog = new Map<string, string>(
      latestJobs.map((j) => [j.dialogId, j.id]),
    );

    return dialogs.map((d) => ({
      ...d,
      ...(opts.withStats
        ? {
            totalTokens:
              (messageTotalsByDialog.get(d.id) ?? 0) + (jobTotalsByDialog.get(d.id) ?? 0),
          }
        : {}),
      ...(q ? { snippet: snippetsByDialog.get(d.id) ?? null } : {}),
      latestJobId: latestJobByDialog.get(d.id) ?? null,
    }));
  },

  async softDelete(dialogId: string, userId: bigint): Promise<void> {
    // Best-effort cleanup OpenAI Files (uploaded для provider_chain attachments).
    // Делается ДО update'а isDeleted, чтобы при ошибке БД мы не оставили
    // orphan-файлы в OpenAI (повторный вызов softDelete пере-cleanup'нет их).
    // Импорт через dynamic require чтобы избежать circular import (chat.service
    // импортирует dialogService).
    const { cleanupOpenAIFilesForDialog } = await import("./chat.service.js");
    await cleanupOpenAIFilesForDialog(dialogId).catch(
      (err) =>
        // err уже залогирован внутри helper'а — здесь просто глотаем чтобы
        // остальные cleanup-шаги выполнились.
        void err,
    );

    await db.dialog.update({ where: { id: dialogId }, data: { isDeleted: true } });
    await db.userState
      .update({
        where: { userId, gptDialogId: dialogId },
        data: { gptDialogId: null },
      })
      .catch(() => void 0);
    await userStateService.deleteDialogSettings(userId, dialogId);
  },

  async rename(dialogId: string, title: string): Promise<Dialog> {
    return db.dialog.update({ where: { id: dialogId }, data: { title } });
  },

  /** Save a user or assistant message to the dialog. */
  async saveMessage(
    dialogId: string,
    role: "user" | "assistant",
    content: string,
    extras?: {
      tokensUsed?: number;
      inputTokens?: number;
      outputTokens?: number;
      providerMessageId?: string;
      mediaUrl?: string;
      mediaType?: string;
      attachments?: StoredAttachment[];
    },
  ): Promise<Message> {
    return db.message.create({
      data: {
        dialogId,
        role,
        content,
        tokensUsed: extras?.tokensUsed ?? 0,
        inputTokens: extras?.inputTokens ?? 0,
        outputTokens: extras?.outputTokens ?? 0,
        providerMessageId: extras?.providerMessageId,
        mediaUrl: extras?.mediaUrl,
        mediaType: extras?.mediaType,
        attachments: extras?.attachments?.length
          ? (extras.attachments as unknown as Prisma.InputJsonValue)
          : undefined,
      },
    });
  },

  /** Mark a message as failed so it is excluded from future LLM history. */
  async markMessageFailed(messageId: string): Promise<void> {
    await db.message.update({ where: { id: messageId }, data: { failed: true } });
  },

  /** Fetch a single message by ID (used for img2img reference lookup). */
  async getMessageById(id: string): Promise<Pick<Message, "id" | "mediaUrl" | "mediaType"> | null> {
    return db.message.findUnique({
      where: { id },
      select: { id: true, mediaUrl: true, mediaType: true },
    });
  },

  /** Fetch all messages for a dialog (for webapp history view). */
  async getMessages(dialogId: string) {
    return db.message.findMany({
      where: { dialogId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        role: true,
        content: true,
        mediaUrl: true,
        mediaType: true,
        attachments: true,
        inputTokens: true,
        outputTokens: true,
        createdAt: true,
      },
    });
  },

  /** Fetch last N messages for db_history strategy (excludes failed messages). */
  async getHistory(
    dialogId: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
      mediaUrl: string | null;
      mediaType: string | null;
      attachments?: StoredAttachment[];
    }>
  > {
    const messages = await db.message.findMany({
      where: { dialogId, failed: false },
      orderBy: { createdAt: "desc" },
      take: limit,
      // mediaUrl/mediaType — legacy backward-compat поля для одиночного
      // изображения. Новые сообщения пишут изображения в attachments[],
      // augmentHistoryMessage'у нужны оба для bridge'а старых записей.
      select: {
        id: true,
        role: true,
        content: true,
        mediaUrl: true,
        mediaType: true,
        attachments: true,
      },
    });
    return messages.reverse().map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      mediaUrl: m.mediaUrl,
      mediaType: m.mediaType,
      attachments: Array.isArray(m.attachments)
        ? (m.attachments as unknown as StoredAttachment[])
        : undefined,
    }));
  },

  /**
   * Update provider-side context pointers after a response.
   *
   * `providerLastResponseKeyId` фиксирует ключ который создал response_id —
   * на следующем turn'е chat-сервис проверяет совпадение с acquired keyId
   * и при mismatch'е дропает previousResponseId (response_id привязан к
   * организации OpenAI, между разными аккаунтами не работает).
   */
  async updateProviderContext(
    dialogId: string,
    updates: {
      providerLastResponseId?: string;
      providerLastResponseKeyId?: string | null;
      providerThreadId?: string;
    },
  ): Promise<void> {
    await db.dialog.update({ where: { id: dialogId }, data: updates });
  },
};
