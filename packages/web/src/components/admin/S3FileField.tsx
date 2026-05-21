import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { uploadAdminFile } from "@/api/admin-uploads";
import { useUIStore } from "@/stores/uiStore";
import type { AdminUploadKind, AdminUploadSection } from "@metabox/shared-browser/dto";

type S3FileFieldProps = {
  label: string;
  kind: AdminUploadKind;
  section: AdminUploadSection;
  /** Текущий s3Key (контролируемое значение формы). Пусто = «не задан». */
  value: string;
  /**
   * Presigned URL ранее сохранённого файла (приходит из promptQuery в edit-mode).
   * Показывается, пока пользователь не загрузил новый файл.
   */
  currentPreviewUrl?: string | null;
  onChange: (s3Key: string) => void;
  disabled?: boolean;
};

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const IMAGE_AND_VIDEO_ACCEPT = `${IMAGE_ACCEPT},video/mp4,video/webm,video/quicktime`;

export function S3FileField({
  label,
  kind,
  section,
  value,
  currentPreviewUrl,
  onChange,
  disabled,
}: S3FileFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "error">("idle");
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [uploadedPreview, setUploadedPreview] = useState<string | null>(null);
  const [localIsVideo, setLocalIsVideo] = useState<boolean>(false);
  const pushToast = useUIStore((s) => s.pushToast);

  // Освобождаем objectURL последнего локального превью при unmount. При замене
  // файла внутри `handleFiles` старый URL revokе'ается явно.
  useEffect(() => {
    return () => {
      if (localPreview) URL.revokeObjectURL(localPreview);
    };
  }, [localPreview]);

  // thumbnail — всегда только картинки; media + section=video дополнительно
  // принимает видео-MIME. Совпадает с whitelist'ом на бэке.
  const accept =
    kind === "thumbnail" || section !== "video" ? IMAGE_ACCEPT : IMAGE_AND_VIDEO_ACCEPT;

  async function handleFiles(fileList: FileList) {
    const file = fileList[0];
    if (!file) return;

    const isVideo = file.type.startsWith("video/");
    if (localPreview) URL.revokeObjectURL(localPreview);
    const objectUrl = URL.createObjectURL(file);
    setLocalPreview(objectUrl);
    setLocalIsVideo(isVideo);
    setStatus("uploading");

    try {
      const dto = await uploadAdminFile(file, section, kind);
      setUploadedPreview(dto.url);
      setStatus("idle");
      onChange(dto.s3Key);
    } catch (e) {
      setStatus("error");
      pushToast({
        type: "error",
        message: (e as Error).message || "Не удалось загрузить файл",
      });
      URL.revokeObjectURL(objectUrl);
      setLocalPreview(null);
    }
  }

  function handleClear() {
    if (localPreview) URL.revokeObjectURL(localPreview);
    setLocalPreview(null);
    setUploadedPreview(null);
    setStatus("idle");
    onChange("");
    if (inputRef.current) inputRef.current.value = "";
  }

  // Приоритет источников: только что выбранный локальный файл → presigned URL,
  // вернувшийся от бэка после загрузки → URL уже сохранённого файла из БД.
  const previewSrc = localPreview ?? uploadedPreview ?? currentPreviewUrl ?? null;

  // Для локального превью знаем точно по File.type. Для URL'ов с бэка — эвристика:
  // media + section=video считаем видео (та же логика, что в исходной форме).
  const showAsVideo = localPreview ? localIsVideo : kind === "media" && section === "video";

  const uploading = status === "uploading";

  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-text-secondary">{label}</label>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        disabled={disabled || uploading}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) handleFiles(e.target.files);
        }}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || uploading}
          className="px-3 py-1.5 rounded text-sm bg-bg-elevated text-text-secondary hover:text-text border border-border disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {value ? "Заменить файл" : "Выбрать файл"}
        </button>
        {value && (
          <button
            type="button"
            onClick={handleClear}
            disabled={disabled || uploading}
            className="px-3 py-1.5 rounded text-sm bg-bg-elevated text-text-secondary hover:text-text border border-border disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Очистить
          </button>
        )}
        {uploading && (
          <span className="inline-flex items-center gap-1 text-xs text-text-hint">
            <Loader2 size={14} className="animate-spin" /> Загрузка…
          </span>
        )}
      </div>

      {previewSrc && (
        <div className="mt-1 relative inline-block">
          {showAsVideo ? (
            <video
              src={previewSrc}
              controls
              className="max-w-[360px] max-h-[240px] rounded border border-border bg-bg-elevated"
            />
          ) : (
            <img
              src={previewSrc}
              alt={label}
              className={
                kind === "thumbnail"
                  ? "max-w-[180px] max-h-[120px] rounded border border-border object-cover"
                  : "max-w-[360px] max-h-[240px] rounded border border-border object-contain bg-bg-elevated"
              }
            />
          )}
          {uploading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded">
              <Loader2 className="animate-spin text-white" size={24} />
            </div>
          )}
        </div>
      )}

      {value && (
        <div className="text-[11px] text-text-hint break-all">
          s3Key: <code>{value}</code>
        </div>
      )}
    </div>
  );
}
