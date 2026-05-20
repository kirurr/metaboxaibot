import { apiClient } from "./client";

/**
 * Клиент для `GET /web/history` (`packages/api/src/routes/web-chat.ts`).
 * Unified-список: для gpt-секции отдаются Dialog'и (kind="dialog"),
 * для image/video/audio — GenerationJob'ы напрямую (kind="job").
 */

export type HistoryItemDto = {
  kind: "dialog" | "job";
  id: string;
  /** "gpt" | "image" | "video" | "audio". */
  section: string;
  modelId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  totalTokens: number;
  snippet: string | null;
  /** Только для kind="job": done | failed | pending | processing. */
  status?: string;
};

export type ListHistoryOptions = {
  section?: string;
  q?: string;
  signal?: AbortSignal;
};

export function listHistory(opts: ListHistoryOptions = {}): Promise<HistoryItemDto[]> {
  const query: Record<string, string> = {};
  if (opts.section) query.section = opts.section;
  if (opts.q) query.q = opts.q;
  return apiClient<HistoryItemDto[]>("/web/history", {
    query: Object.keys(query).length ? query : undefined,
    signal: opts.signal,
  });
}
