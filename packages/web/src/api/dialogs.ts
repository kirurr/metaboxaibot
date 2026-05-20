import { apiClient, ApiError, API_BASE } from "./client";
import { useAuthStore } from "@/stores/authStore";

/**
 * Эндпоинты `/web/dialogs/*` — те же, что юзает мини-аппа и бот.
 * История полностью синхронизирована: создал диалог в боте — увидишь его здесь.
 *
 * Все эндпоинты требуют привязанного Telegram. На 403 TELEGRAM_NOT_LINKED
 * `apiClient` сам открывает модалку через `useUIStore` — отдельной обработки
 * не нужно.
 */

export type DialogDto = {
  id: string;
  section: string;
  modelId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  /** Возвращается только при `listDialogs({ withStats: true })`. */
  totalTokens?: number;
  /** Возвращается только при `listDialogs({ q })` — сниппет первого матч-сообщения. */
  snippet?: string | null;
  /**
   * id последнего done-job в этом диалоге (для image/video/audio секций).
   * Используется страницей /history для навигации в `/gallery/:jobId`.
   * Для gpt-диалогов и для не-media диалогов без завершённых джобов = `null`.
   */
  latestJobId?: string | null;
};

export type MessageAttachmentDto = {
  s3Key: string;
  mimeType: string;
  name: string;
  size: number | null;
  /** Presigned URL для превью; может быть null если ссылка не сгенерировалась. */
  url: string | null;
  kind: "image" | "document" | string;
};

export type MessageDto = {
  id: string;
  role: "user" | "ai" | "system" | string;
  content: string;
  mediaUrl: string | null;
  mediaType: string | null;
  createdAt: string;
  /** Прикреплённые файлы (картинки + документы), `null` если их нет. */
  attachments?: MessageAttachmentDto[] | null;
  /** Raw input tokens (для assistant-сообщений; 0 для user). */
  inputTokens?: number;
  /** Raw output tokens (для assistant-сообщений; 0 для user). */
  outputTokens?: number;
};

/** Payload для streamMessage — документы как в chatService.SendMessageParams. */
export type SendDocumentAttachment = {
  s3Key: string;
  mimeType: string;
  name: string;
  size?: number;
};

export type ListDialogsOptions = {
  section?: string;
  /** Поиск по title + содержимому сообщений (server-side). */
  q?: string;
  /** Включить агрегированные `totalTokens` per dialog (легче `withStats=false`). */
  withStats?: boolean;
  /** AbortSignal — TanStack Query прокидывает свой при смене queryKey. */
  signal?: AbortSignal;
};

export function listDialogs(opts: ListDialogsOptions | string = {}): Promise<DialogDto[]> {
  // Backward-compat: некоторые места передают section строкой.
  const o = typeof opts === "string" ? { section: opts } : opts;
  const query: Record<string, string> = {};
  if (o.section) query.section = o.section;
  if (o.q) query.q = o.q;
  if (o.withStats) query.withStats = "1";
  return apiClient<DialogDto[]>("/web/dialogs", {
    query: Object.keys(query).length ? query : undefined,
    signal: o.signal,
  });
}

export function createDialog(input: { section: string; modelId: string; title?: string }) {
  return apiClient<DialogDto, typeof input>("/web/dialogs", { method: "POST", body: input });
}

export function renameDialog(id: string, title: string) {
  return apiClient<{ id: string; title: string }, { title: string }>(
    `/web/dialogs/${encodeURIComponent(id)}`,
    { method: "PATCH", body: { title } },
  );
}

export function deleteDialog(id: string) {
  return apiClient<{ success: true }>(`/web/dialogs/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function getMessages(id: string) {
  return apiClient<MessageDto[]>(`/web/dialogs/${encodeURIComponent(id)}/messages`);
}

// ── Send + SSE streaming ─────────────────────────────────────────────────────
// `/web/dialogs/:id/send` отдаёт server-sent events, нативный EventSource не
// подходит (он умеет только GET + не передаёт Authorization). Парсим стрим
// руками через fetch + ReadableStream.

export type StreamBalance = {
  tokenBalance: string;
  subscriptionTokenBalance: string;
};
export type StreamCallbacks = {
  onChunk: (text: string) => void;
  onDone: (info: {
    tokensUsed: number;
    inputTokens: number;
    outputTokens: number;
    balance: StreamBalance;
  }) => void;
  onError: (err: { code: string; message: string }) => void;
};

const SEND_ENDPOINT = (id: string) => `/web/dialogs/${encodeURIComponent(id)}/send`;

export type StreamPayload = {
  content: string;
  imageS3Keys?: string[];
  documentAttachments?: SendDocumentAttachment[];
};

export async function streamMessage(
  dialogId: string,
  payload: StreamPayload,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  // Делаем сами fetch (apiClient не поддерживает SSE). Перед первым запросом
  // освежаем access если кончился, чтобы не словить mid-stream 401.
  const auth = useAuthStore.getState();
  if (auth.accessTokenExpiresAt && auth.accessTokenExpiresAt - Date.now() < 5_000) {
    await auth.tryRefresh();
  }

  const doFetch = async () => {
    const token = useAuthStore.getState().accessToken;
    const csrf = useAuthStore.getState().csrfToken;
    return fetch(API_BASE.replace(/\/$/, "") + SEND_ENDPOINT(dialogId), {
      method: "POST",
      credentials: "include",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: JSON.stringify(payload),
    });
  };

  let res = await doFetch();
  if (res.status === 401) {
    const refreshed = await useAuthStore.getState().tryRefresh();
    if (refreshed) res = await doFetch();
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let parsed: { code?: string; error?: string } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      /* ignore */
    }
    throw new ApiError(
      res.status,
      parsed.code,
      parsed.error || `stream failed: ${res.status}`,
      parsed,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE event blocks разделяются "\n\n"; последний хвост может быть неполным.
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        processEvent(block, callbacks);
      }
    }
    // Хвост после `done` обычно пустой; если что осталось — парсим как event.
    if (buf.trim()) processEvent(buf, callbacks);
  } finally {
    reader.releaseLock();
  }
}

function processEvent(block: string, callbacks: StreamCallbacks) {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }
  if (dataLines.length === 0) return;
  const dataRaw = dataLines.join("\n");
  let data: unknown;
  try {
    data = JSON.parse(dataRaw);
  } catch {
    return; // malformed event — пропускаем тихо
  }
  if (eventName === "chunk") {
    const text = (data as { text?: string }).text;
    if (typeof text === "string") callbacks.onChunk(text);
  } else if (eventName === "done") {
    const d = data as {
      tokensUsed?: number;
      inputTokens?: number;
      outputTokens?: number;
      balance?: StreamBalance;
    };
    callbacks.onDone({
      tokensUsed: d.tokensUsed ?? 0,
      inputTokens: d.inputTokens ?? 0,
      outputTokens: d.outputTokens ?? 0,
      balance: d.balance ?? { tokenBalance: "0", subscriptionTokenBalance: "0" },
    });
  } else if (eventName === "error") {
    const e = data as { code?: string; message?: string };
    callbacks.onError({
      code: e.code ?? "UNKNOWN",
      message: e.message ?? "Что-то пошло не так",
    });
  }
}
