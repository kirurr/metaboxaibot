import type { ChatUploadDto } from "@/api/uploads";
import type { MessageAttachmentDto } from "@/api/dialogs";

export type Msg = {
  role: "user" | "ai";
  text: string;
  meta?: string;
  /** Иконка модели-автора (assistant-only) — рендерится рядом с `meta`. `null` → буква. */
  modelIcon?: string | null;
  /** Имя модели-автора (assistant-only) — буква-фолбек для иконки. */
  modelName?: string;
  /** Локальный id для оптимистичных user-сообщений (бэк не возвращает их id до done). */
  localId?: string;
  /** Прикреплённые файлы — рендерятся над bubble. */
  attachments?: MessageAttachmentDto[];
  /** Raw input tokens (для assistant; latest assistant сообщение — источник current-context для composer'а). */
  inputTokens?: number;
  /** Raw output tokens (для assistant). */
  outputTokens?: number;
};

/** Pending-аттач до отправки: либо в процессе загрузки, либо уже в S3. */
export type PendingAttachment =
  | { id: string; status: "uploading"; file: File }
  | { id: string; status: "ready"; file: File; dto: ChatUploadDto }
  | { id: string; status: "error"; file: File; error: string };
