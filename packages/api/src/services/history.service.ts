import { db } from "../db.js";

/**
 * Сервис для страницы /history (`packages/web/src/pages/History.tsx`).
 *
 * Сочетает два источника данных:
 *  - **gpt-секция**: записи берутся из `Dialog` (привычная история чатов).
 *  - **image/video/audio**: записи — это `GenerationJob` напрямую по `userId`.
 *    Через Dialog их тянуть нельзя: большинство media-джобов создаются с
 *    пустым `dialogId` (см. `services/video-generation.service.ts:169`,
 *    `services/audio-generation.service.ts:109`, `services/generation.service.ts:138`).
 *
 * Результаты сортируются по `updatedAt` desc, без пагинации (соответствует
 * текущему решению по AIBOX-22).
 */

export type HistoryItem = {
  kind: "dialog" | "job";
  id: string;
  /** "gpt" | "image" | "video" | "audio". Для UI: "design" нормализуется в "image". */
  section: string;
  modelId: string;
  /** Dialog.title (nullable) или обрезанный prompt джобы. */
  title: string | null;
  createdAt: string;
  updatedAt: string;
  totalTokens: number;
  snippet: string | null;
  /** Только для kind='job' — done | failed | pending | processing. */
  status?: string;
};

export type ListHistoryOptions = {
  section?: string;
  q?: string;
};

const MEDIA_SECTIONS = ["image", "video", "audio"] as const;
const TITLE_PROMPT_MAX = 80;

/**
 * Подрезает контент вокруг матча `q` до ~140 символов с эллипсами.
 * Дублирует `buildSnippet` из dialog.service — оба места узкоспециализированы,
 * вытаскивать в shared util оверкилл.
 */
function buildSnippet(content: string, q: string): string {
  const MAX = 140;
  if (!q) return content.length > MAX ? content.slice(0, MAX) + "…" : content;
  const idx = content.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return content.length > MAX ? content.slice(0, MAX) + "…" : content;
  const around = 60;
  const start = Math.max(0, idx - around);
  const end = Math.min(content.length, idx + q.length + around);
  return (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
}

/** "design" → "image": фронт может слать любое из двух. См. `web-generation.ts:117`. */
function normalizeSection(section: string | undefined): string | undefined {
  if (!section) return undefined;
  return section === "design" ? "image" : section;
}

export const historyService = {
  async list(userId: bigint, opts: ListHistoryOptions = {}): Promise<HistoryItem[]> {
    const q = opts.q?.trim() ?? "";
    const section = normalizeSection(opts.section);

    const wantsGpt = !section || section === "gpt";
    const wantsMedia = !section || section !== "gpt";

    const [dialogs, jobs] = await Promise.all([
      wantsGpt ? loadGptDialogs(userId, q) : Promise.resolve([] as HistoryItem[]),
      wantsMedia
        ? loadMediaJobs(userId, q, section === "gpt" ? undefined : section)
        : Promise.resolve([] as HistoryItem[]),
    ]);

    return [...dialogs, ...jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
};

async function loadGptDialogs(userId: bigint, q: string): Promise<HistoryItem[]> {
  const where = {
    userId,
    isDeleted: false,
    section: "gpt",
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
    select: {
      id: true,
      section: true,
      modelId: true,
      title: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (dialogs.length === 0) return [];

  const ids = dialogs.map((d) => d.id);
  const [totals, snippets] = await Promise.all([
    db.message.groupBy({
      by: ["dialogId"],
      where: { dialogId: { in: ids } },
      _sum: { tokensUsed: true },
    }),
    q
      ? db.message.findMany({
          where: {
            dialogId: { in: ids },
            failed: false,
            content: { contains: q, mode: "insensitive" as const },
          },
          orderBy: { createdAt: "desc" },
          distinct: ["dialogId"],
          select: { dialogId: true, content: true },
        })
      : Promise.resolve([] as Array<{ dialogId: string; content: string }>),
  ]);

  const totalsByDialog = new Map<string, number>(
    totals.map((t) => [t.dialogId, Number(t._sum.tokensUsed ?? 0)]),
  );
  const snippetsByDialog = new Map<string, string>(
    snippets.map((s) => [s.dialogId, buildSnippet(s.content, q)]),
  );

  return dialogs.map<HistoryItem>((d) => ({
    kind: "dialog",
    id: d.id,
    section: d.section,
    modelId: d.modelId,
    title: d.title ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    totalTokens: totalsByDialog.get(d.id) ?? 0,
    snippet: q ? (snippetsByDialog.get(d.id) ?? null) : null,
  }));
}

async function loadMediaJobs(
  userId: bigint,
  q: string,
  section: string | undefined,
): Promise<HistoryItem[]> {
  const sectionFilter = section ? { section } : { section: { in: [...MEDIA_SECTIONS] } };

  const jobs = await db.generationJob.findMany({
    where: {
      userId,
      ...sectionFilter,
      ...(q ? { prompt: { contains: q, mode: "insensitive" as const } } : {}),
    },
    // completedAt — завершённые/упавшие; updatedAt — pending/processing.
    // Дополнительный orderBy createdAt стабилизирует выдачу для джобов с
    // одинаковым updatedAt.
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      section: true,
      modelId: true,
      prompt: true,
      status: true,
      tokensSpent: true,
      createdAt: true,
      updatedAt: true,
      completedAt: true,
    },
  });

  return jobs.map<HistoryItem>((j) => {
    const ts = (j.completedAt ?? j.updatedAt).toISOString();
    const prompt = j.prompt ?? "";
    const title = prompt
      ? prompt.length > TITLE_PROMPT_MAX
        ? prompt.slice(0, TITLE_PROMPT_MAX) + "…"
        : prompt
      : null;
    return {
      kind: "job",
      id: j.id,
      section: j.section,
      modelId: j.modelId,
      title,
      createdAt: j.createdAt.toISOString(),
      updatedAt: ts,
      totalTokens: Number(j.tokensSpent ?? 0),
      snippet: q && prompt ? buildSnippet(prompt, q) : null,
      status: j.status,
    };
  });
}
