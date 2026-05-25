/**
 * Допустимые типы загрузок и маппинг mime → расширение. Используется в
 * `POST /web/chat-uploads` (web-chat.ts) и `POST /web/elements/:id/media`
 * (web-elements.ts) — единый список, чтобы не дублировать.
 */

export const CHAT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024; // 25 MB — покрывает обычные PDF/изображения

export const IMAGE_MIMES = new Set<string>(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DOCUMENT_MIMES = new Set<string>([
  "application/pdf",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "text/comma-separated-values",
]);
const VIDEO_MIMES = new Set<string>(["video/mp4", "video/quicktime", "video/webm"]);
const AUDIO_MIMES = new Set<string>([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "audio/webm",
  "audio/ogg",
]);

export type UploadKind = "image" | "document" | "video" | "audio";

export function isAllowedUploadMime(mime: string): UploadKind | null {
  if (IMAGE_MIMES.has(mime)) return "image";
  if (DOCUMENT_MIMES.has(mime)) return "document";
  if (VIDEO_MIMES.has(mime)) return "video";
  if (AUDIO_MIMES.has(mime)) return "audio";
  // Прочие text/* (plain, csv, markdown, ...) — text-class, идут как document.
  if (mime.startsWith("text/")) return "document";
  return null;
}

export function extFromMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "application/pdf":
      return "pdf";
    case "application/json":
      return "json";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "docx";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return "xlsx";
    case "text/comma-separated-values":
    case "text/csv":
      return "csv";
    case "text/markdown":
      return "md";
    case "text/plain":
      return "txt";
    case "video/mp4":
      return "mp4";
    case "video/quicktime":
      return "mov";
    case "video/webm":
      return "webm";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    default:
      return "bin";
  }
}
