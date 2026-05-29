import { apiClient, API_BASE } from "./client";
import { useAuthStore } from "@/stores/authStore";

export interface DialogDto {
  id: string;
  section: string;
  modelId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDto {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  mediaUrl: string | null;
  mediaType: string | null;
  createdAt: string;
}

export interface ModelDto {
  id: string;
  name: string;
  /** Имя для веб-UI без эмодзи. */
  webName: string;
  /** Путь к монохромной SVG-иконке бренда (`/icons/*.svg`); `null` → буква-аватар. */
  webIconPath: string | null;
  description: string;
  section: string;
  provider: string;
  familyId: string | null;
  familyName: string | null;
  familyDefaultModelId: string | null;
  versionLabel: string | null;
  variantLabel: string | null;
  supportsImages: boolean;
  supportsDocuments: boolean;
}

export interface BalanceDto {
  tokenBalance: string;
  subscriptionTokenBalance: string;
  subscription: {
    planName: string;
    period: string;
    endDate: string;
    tokensGranted: number;
  } | null;
}

export function listModels(section?: string) {
  return apiClient<ModelDto[]>("/web/models", { query: section ? { section } : undefined });
}

export function getBalance() {
  return apiClient<BalanceDto>("/web/balance");
}

export function listDialogs(section?: string) {
  return apiClient<DialogDto[]>("/web/dialogs", { query: section ? { section } : undefined });
}

export function createDialog(body: { section: string; modelId: string; title?: string }) {
  return apiClient<DialogDto, typeof body>("/web/dialogs", { method: "POST", body });
}

export function renameDialog(id: string, title: string) {
  return apiClient<{ id: string; title: string | null }, { title: string }>(
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

// ── SSE send ────────────────────────────────────────────────────────────────

export interface SendChunkEvent {
  type: "chunk";
  text: string;
}
export interface SendDoneEvent {
  type: "done";
  tokensUsed: number;
  balance: { tokenBalance: string; subscriptionTokenBalance: string };
}
export interface SendErrorEvent {
  type: "error";
  code: string;
  message: string;
}
export type SendEvent = SendChunkEvent | SendDoneEvent | SendErrorEvent;

/**
 * Отправляет сообщение и подписывается на SSE-поток.
 * Возвращает async-generator, который yield'ит события в порядке получения.
 * Использует fetch с keepalive — поддерживается всеми современными браузерами.
 */
export async function* sendMessageStream(
  dialogId: string,
  content: string,
  signal?: AbortSignal,
): AsyncGenerator<SendEvent, void, unknown> {
  const token = useAuthStore.getState().accessToken;
  const csrf = useAuthStore.getState().csrfToken;
  const url = `${API_BASE.replace(/\/$/, "")}/web/dialogs/${encodeURIComponent(dialogId)}/send`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    credentials: "include",
    body: JSON.stringify({ content }),
    signal,
  });

  if (!res.ok) {
    let errBody: { error?: string; code?: string } = {};
    try {
      errBody = await res.json();
    } catch {
      /* ignore */
    }
    yield {
      type: "error",
      code: errBody.code ?? "HTTP_ERROR",
      message: errBody.error ?? `HTTP ${res.status}`,
    };
    return;
  }

  if (!res.body) {
    yield { type: "error", code: "NO_STREAM", message: "SSE-поток недоступен" };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Разбор SSE: события разделены "\n\n"
      let sepIdx: number;
      while ((sepIdx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, sepIdx);
        buf = buf.slice(sepIdx + 2);
        const lines = raw.split("\n");
        let event = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);
          if (event === "chunk") {
            yield { type: "chunk", text: parsed.text ?? "" };
          } else if (event === "done") {
            yield { type: "done", tokensUsed: parsed.tokensUsed ?? 0, balance: parsed.balance };
          } else if (event === "error") {
            yield { type: "error", code: parsed.code ?? "ERROR", message: parsed.message ?? "" };
          }
        } catch {
          /* malformed chunk — skip */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
