import { apiClient } from "./client";
import {
  promptExamplesPageSchema,
  promptExampleSchema,
  type PromptExamplesPage,
  type PromptExample,
  type ListPromptExamplesQuery,
  type CreatePromptExampleBody,
  type UpdatePromptExampleBody,
} from "@metabox/shared-browser/dto";

export type { PromptExamplesPage, PromptExample, ListPromptExamplesQuery };

export async function listPromptExamples(
  params: ListPromptExamplesQuery = {},
  signal?: AbortSignal,
) {
  const data = await apiClient("/web/prompts", {
    signal,
    query: { section: params.section, cursor: params.cursor, take: params.take },
  });
  return promptExamplesPageSchema.parse(data);
}

// ── Admin ──────────────────────────────────────────────────────────────────

export async function adminListPromptExamples(params: ListPromptExamplesQuery = {}) {
  const data = await apiClient("/admin/prompts", {
    query: { section: params.section, cursor: params.cursor, take: params.take },
  });
  return promptExamplesPageSchema.parse(data);
}

export async function adminCreatePromptExample(body: CreatePromptExampleBody) {
  const data = await apiClient("/admin/prompts", { method: "POST", body });
  return promptExampleSchema.parse(data);
}

export async function adminUpdatePromptExample(id: string, body: UpdatePromptExampleBody) {
  const data = await apiClient(`/admin/prompts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
  return promptExampleSchema.parse(data);
}

export async function adminDeletePromptExample(id: string) {
  return apiClient<{ success: boolean }>(`/admin/prompts/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
