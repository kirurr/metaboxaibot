import { db } from "../db.js";
import type { UserAvatar } from "@prisma/client";

export const userAvatarService = {
  async list(userId: bigint, provider?: string): Promise<UserAvatar[]> {
    return db.userAvatar.findMany({
      where: { userId, ...(provider ? { provider } : {}) },
      orderBy: { createdAt: "desc" },
    });
  },

  async findById(id: string): Promise<UserAvatar | null> {
    return db.userAvatar.findUnique({ where: { id } });
  },

  async create(
    userId: bigint,
    params: {
      provider: string;
      name: string;
      externalId?: string;
      status?: string;
      previewUrl?: string;
      providerKeyId?: string | null;
      /** Используется для Soul (хранение исходников до запуска worker-джобы). */
      sourceS3Keys?: string[];
    },
  ): Promise<UserAvatar> {
    return db.userAvatar.create({
      data: { userId, status: "creating", ...params },
    });
  },

  async updateStatus(
    id: string,
    params: {
      status: string;
      externalId?: string;
      previewUrl?: string;
      providerKeyId?: string | null;
    },
  ): Promise<UserAvatar> {
    return db.userAvatar.update({ where: { id }, data: params });
  },

  /**
   * Аватар привязан к ProviderKey, который удалён/отключён, либо ресурс
   * пропал из аккаунта. Помечаем status="orphaned" — UI должен показать
   * пользователю, что аватар недоступен и его нужно пересоздать.
   */
  async markOrphaned(id: string): Promise<UserAvatar> {
    return db.userAvatar.update({ where: { id }, data: { status: "orphaned" } });
  },

  async rename(id: string, userId: bigint, name: string): Promise<UserAvatar | null> {
    const avatar = await db.userAvatar.findFirst({ where: { id, userId } });
    if (!avatar) return null;
    return db.userAvatar.update({ where: { id }, data: { name } });
  },

  async delete(id: string, userId: bigint): Promise<boolean> {
    const avatar = await db.userAvatar.findFirst({ where: { id, userId } });
    if (!avatar) return false;
    await db.userAvatar.delete({ where: { id } });
    return true;
  },

  /**
   * Validates that the user owns a Higgsfield Soul avatar matching `externalId` and that it's `ready`.
   * Returns null if everything is fine, or a key for `Translations.errors` to show to the user.
   */
  async validateSoulAvatar(
    userId: bigint,
    externalId: string | null | undefined,
  ): Promise<"soulMissingAvatar" | "soulAvatarNotReady" | null> {
    if (!externalId) return "soulMissingAvatar";
    const avatar = await db.userAvatar.findFirst({
      where: { userId, provider: "higgsfield_soul", externalId },
    });
    if (!avatar) return "soulMissingAvatar";
    if (avatar.status !== "ready") return "soulAvatarNotReady";
    return null;
  },
};
