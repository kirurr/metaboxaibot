import z from "zod";
import { modelSettingDefSchema } from "./model-setting.js";

// section: known values are "image" | "video" | "audio"
// kept as string for forward compatibility with new sections

export const promptExampleModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  section: z.string(),
  provider: z.string(),
  settings: z.array(modelSettingDefSchema).nullable(),
});

export const promptExampleSchema = z.object({
  id: z.string(),
  model: promptExampleModelSchema.nullable(),
  modelSettings: z.unknown().nullable(),
  prompt: z.string(),
  mediaUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  section: z.string(),
  createdAt: z.string(),
});

export const promptExamplesPageSchema = z.object({
  items: z.array(promptExampleSchema),
  nextCursor: z.string().nullable(),
});

export const listPromptExamplesQuerySchema = z.object({
  section: z.string().optional(),
  cursor: z.string().optional(),
  take: z.coerce.number().int().min(1).max(100).optional(),
});

export const createPromptExampleBodySchema = z.object({
  modelId: z.string().min(1),
  modelSettings: z.any().optional(),
  prompt: z.string().min(1),
  mediaS3Key: z.string().optional(),
  thumbnailS3Key: z.string().optional(),
  section: z.string().min(1),
});

export const updatePromptExampleBodySchema = z.object({
  modelId: z.string().min(1).optional(),
  modelSettings: z.any().optional(),
  prompt: z.string().min(1).optional(),
  mediaS3Key: z.string().nullable().optional(),
  thumbnailS3Key: z.string().nullable().optional(),
  section: z.string().min(1).optional(),
});

export type PromptExample = z.infer<typeof promptExampleSchema>;
export type PromptExamplesPage = z.infer<typeof promptExamplesPageSchema>;
export type ListPromptExamplesQuery = z.infer<typeof listPromptExamplesQuerySchema>;
export type CreatePromptExampleBody = z.infer<typeof createPromptExampleBodySchema>;
export type UpdatePromptExampleBody = z.infer<typeof updatePromptExampleBodySchema>;
