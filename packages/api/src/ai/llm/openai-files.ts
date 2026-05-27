/**
 * OpenAI Files API helpers (`/v1/files`, purpose: "user_data").
 *
 * Зачем: OpenAI Responses API кэширует input по `previous_response_id`. Если
 * мы отправляем `file_url` (presigned S3), URL попадает в кэш у OpenAI.
 * При следующем turn'е они re-fetch'ят URL — а наш presigned 1ч TTL уже мог
 * протухнуть → 403 на их стороне → 400 у нас. См. видеоадаптер commit/issue.
 *
 * Решение: загружаем файл один раз через Files API, получаем `file_id`,
 * передаём его в input_file блоке вместо file_url. file_id stable forever
 * (до явного DELETE), нет TTL.
 *
 * Sticky-binding: file_id видит только organization того ключа, что аплоадил.
 * Если в нашем key pool ключи разных org → нужно re-uploadить при rotation.
 * Хранится `openaiKeyId` на attachment'е, при mismatch'е перезагружаем.
 */

import OpenAI, { toFile, type ClientOptions as OpenAIClientOptions } from "openai";
import { logger } from "../../logger.js";

/**
 * Build OpenAI client с опциональным fetch (для proxy). Симметрично тому
 * как это делает OpenAIAdapter — все file-API вызовы должны идти через
 * тот же канал что и chat-completions, иначе при IP-binding'е ключа на
 * proxy сервер OpenAI отдаст 401/403.
 */
function makeClient(apiKey: string, fetchFn?: typeof globalThis.fetch): OpenAI {
  return new OpenAI({
    apiKey,
    ...(fetchFn ? { fetch: fetchFn as unknown as OpenAIClientOptions["fetch"] } : {}),
  });
}

/**
 * Upload a file buffer to OpenAI Files API with `purpose: "user_data"`.
 * Returns the resulting `file_id` (e.g. "file-abc123") for use in
 * `input_file` blocks of Responses API.
 */
export async function uploadFileToOpenAI(
  apiKey: string,
  bytes: Buffer,
  filename: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<string> {
  const client = makeClient(apiKey, fetchFn);
  // OpenAI валидирует extension case-sensitive: `.pdf` принимает, `.PDF` 400-ит.
  // Юзер из Telegram присылает файл как есть; нормализуем последнее расширение.
  const normalizedFilename = filename.replace(
    /\.([A-Za-z0-9]+)$/,
    (_, ext) => `.${ext.toLowerCase()}`,
  );
  const fileObj = await toFile(bytes, normalizedFilename);
  const result = await client.files.create({
    file: fileObj,
    purpose: "user_data",
  });
  return result.id;
}

/**
 * Delete a file from OpenAI's storage. Best-effort — logs and swallows errors
 * (file might already be gone, key might be invalid, org mismatch и т.п.).
 */
export async function deleteFileFromOpenAI(
  apiKey: string,
  fileId: string,
  fetchFn?: typeof globalThis.fetch,
): Promise<void> {
  const client = makeClient(apiKey, fetchFn);
  try {
    await client.files.del(fileId);
  } catch (err) {
    logger.warn({ err, fileId }, "openai-files: delete failed (best-effort)");
  }
}

/**
 * Mime-types которые поддерживаются Responses API через `input_file`
 * (purpose=user_data). Изображения сюда НЕ входят — они идут через `input_image`
 * + image_url напрямую (S3 presigned URL'ы для image_url не кэшируются OpenAI'ем
 * между turn'ами в той же мере, и обычно укладываются в 1ч TTL).
 */
const OPENAI_FILE_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/msword", // .doc
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/comma-separated-values",
  "text/html",
  "text/xml",
  "application/json",
]);

export function isOpenAIFileSupportedMime(mimeType: string): boolean {
  return OPENAI_FILE_MIME_TYPES.has(mimeType);
}
