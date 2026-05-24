import { apiClient, ApiError, API_BASE } from "./client";
import { useAuthStore } from "@/stores/authStore";

/**
 * Загружает один файл в `/web/chat-uploads` (multipart). Бэк кладёт его в S3
 * и возвращает s3Key + метаданные. Фронт хранит результат локально, пока юзер
 * не нажмёт «Отправить» — тогда передаёт массив s3Key'ев через streamMessage.
 *
 * Использует тот же auth/refresh flow что `apiClient`: освежает access перед
 * запросом, на 401 один раз ретраит через tryRefresh.
 */

export type ChatUploadKind = "image" | "document" | "video" | "audio";

export type ChatUploadDto = {
  s3Key: string;
  name: string;
  mimeType: string;
  size: number;
  kind: ChatUploadKind;
  /** Presigned URL для превью в pending-chip; может быть null если S3 не вернул. */
  url: string | null;
};

const ENDPOINT = "/web/chat-uploads";

export async function uploadChatFile(file: File): Promise<ChatUploadDto> {
  const auth = useAuthStore.getState();
  if (auth.accessTokenExpiresAt && auth.accessTokenExpiresAt - Date.now() < 5_000) {
    await auth.tryRefresh();
  }

  const form = new FormData();
  form.append("file", file, file.name);

  const doFetch = async () => {
    const token = useAuthStore.getState().accessToken;
    const csrf = useAuthStore.getState().csrfToken;
    return fetch(API_BASE.replace(/\/$/, "") + ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: {
        // НЕ выставляем Content-Type — браузер сам добавит multipart boundary.
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: form,
    });
  };

  let res = await doFetch();
  if (res.status === 401) {
    const refreshed = await useAuthStore.getState().tryRefresh();
    if (refreshed) res = await doFetch();
  }
  if (!res.ok) {
    let body: { code?: string; error?: string } = {};
    try {
      body = (await res.json()) as { code?: string; error?: string };
    } catch {
      /* ignore */
    }
    // Глобальный handler 403 TELEGRAM_NOT_LINKED уже разруливается в apiClient,
    // здесь не подключаем — uploads и так под webTelegramLinkedPreHandler.
    throw new ApiError(res.status, body.code, body.error || `upload failed: ${res.status}`, body);
  }
  return (await res.json()) as ChatUploadDto;
}

/**
 * Перевыпускает presigned URL'ы для уже загруженных файлов по их s3Key.
 * Возвращает мапу s3Key → url|null (null если ключ чужой или getFileUrl упал).
 */
export async function signChatUploads(s3Keys: string[]): Promise<Record<string, string | null>> {
  if (s3Keys.length === 0) return {};
  const { urls } = await apiClient<{ urls: Record<string, string | null> }, { s3Keys: string[] }>(
    ENDPOINT + "/sign",
    { method: "POST", body: { s3Keys } },
  );
  return urls ?? {};
}
