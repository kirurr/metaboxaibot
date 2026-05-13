import { db } from "../db.js";
import type { PromptExample, Prisma } from "@prisma/client";

export interface ListPromptExamplesParams {
  section?: string;
  cursor?: string;
  take?: number;
}

export interface PromptExamplesPage {
  items: PromptExample[];
  nextCursor: string | null;
}

export interface CreatePromptExampleParams {
  modelId: string;
  modelSettings?: unknown;
  prompt: string;
  mediaS3Key?: string;
  thumbnailS3Key?: string;
  section: string;
}

export interface UpdatePromptExampleParams {
  modelId?: string;
  modelSettings?: unknown;
  prompt?: string;
  mediaS3Key?: string | null;
  thumbnailS3Key?: string | null;
  section?: string;
}

export const promptExamplesService = {
  async list(params: ListPromptExamplesParams = {}): Promise<PromptExamplesPage> {
    const { section, cursor, take = 20 } = params;

    const where: Prisma.PromptExampleWhereInput = {
      ...(section ? { section } : {}),
      ...(cursor ? { id: { lt: cursor } } : {}),
    };

    const items = await db.promptExample.findMany({
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

  async findById(id: string): Promise<PromptExample | null> {
    return db.promptExample.findUnique({ where: { id } });
  },

  async create(params: CreatePromptExampleParams): Promise<PromptExample> {
    const { modelSettings, ...rest } = params;
    return db.promptExample.create({
      data: { ...rest, modelSettings: modelSettings as Prisma.InputJsonValue },
    });
  },

  async update(id: string, params: UpdatePromptExampleParams): Promise<PromptExample | null> {
    const existing = await db.promptExample.findUnique({ where: { id } });
    if (!existing) return null;
    const { modelSettings, ...rest } = params;
    const data: Prisma.PromptExampleUpdateInput = {
      ...rest,
      ...(modelSettings !== undefined
        ? { modelSettings: modelSettings as Prisma.InputJsonValue }
        : {}),
    };
    return db.promptExample.update({ where: { id }, data });
  },

  async delete(id: string): Promise<boolean> {
    const existing = await db.promptExample.findUnique({ where: { id } });
    if (!existing) return false;
    await db.promptExample.delete({ where: { id } });
    return true;
  },
};
