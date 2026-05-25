import { apiClient, postMultipartFile } from "./client";

/**
 * Загружает один файл в `/web/chat-uploads` (multipart). Бэк кладёт его в S3
 * и возвращает s3Key + метаданные. Фронт хранит результат локально, пока юзер
 * не нажмёт «Отправить» — тогда передаёт массив s3Key'ев через streamMessage.
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
  const res = await postMultipartFile(ENDPOINT, file);
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
