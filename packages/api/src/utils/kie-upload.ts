import { randomUUID } from "node:crypto";
import { fetchWithLog } from "./fetch.js";

const KIE_FILE_BASE = "https://kieai.redpandaai.co";

interface KieFileUploadResponse {
  success: boolean;
  code: number;
  msg: string;
  data?: {
    fileName: string;
    filePath: string;
    downloadUrl: string;
    fileSize: number;
    mimeType: string;
    uploadedAt: string;
  };
}

/**
 * Распознанные форматы изображений. Используем extension из URL'а провайдера,
 * чтобы корректно сохранить файл как `.png` (когда юзер выбрал PNG в настройках,
 * а не дефолтный `.jpg`). По дефолту падаем на jpg — большинство провайдеров
 * без явного output_format отдают именно его.
 */
const KNOWN_IMAGE_EXTS: ReadonlyArray<string> = ["png", "jpg", "jpeg", "webp", "gif", "svg"];
const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

export function parseImageMime(url: string): { ext: string; contentType: string } {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-zA-Z0-9]+)$/);
    if (m) {
      const ext = m[1].toLowerCase();
      if (KNOWN_IMAGE_EXTS.includes(ext)) {
        return { ext: ext === "jpeg" ? "jpg" : ext, contentType: EXT_TO_CONTENT_TYPE[ext] };
      }
    }
  } catch {
    // not a parseable URL — fallthrough
  }
  return { ext: "jpg", contentType: "image/jpeg" };
}

/**
 * KIE требует у `fileName` extension, иначе сохраняет файл с
 * randomly-generated именем без расширения, и downstream-модели валидируют
 * тип по URL extension'у. См. uploadFileUrl jsdoc.
 *
 * UUID, не `Date.now()+idx`: KIE-доке «identical filenames overwriting old
 * files» — два параллельных submit'а в одну миллисекунду перезатёрли бы
 * друг друга, и юзер A мог бы получить картинку юзера B.
 */
export function buildKieUploadName(url: string): string {
  const { ext } = parseImageMime(url);
  return `metabox-${randomUUID()}.${ext}`;
}

/**
 * Upload a file to KIE's temporary storage via URL.
 * KIE downloads the file from the given URL and returns a public download link.
 * Files are automatically deleted after 3 days.
 *
 * Used to make S3 presigned URLs / Telegram file URLs accessible to KIE's
 * generation endpoints (which cannot reach private/expiring URLs).
 *
 * Опциональный `fileName` (обязательно с extension'ом) — пробрасывается в KIE,
 * чтобы downloadUrl содержал понятное расширение. Без этого KIE кладёт файл
 * под randomly-generated именем, а downstream-модели (nano-banana-2, kling и др.)
 * валидируют тип по URL extension'у и отбрасывают extensionless ссылки с
 * `"File type not supported"` / `"Only jpeg/jpg/png image formats are supported"`.
 */
export async function uploadFileUrl(
  apiKey: string,
  fileUrl: string,
  fileName?: string,
): Promise<string> {
  const resp = await fetchWithLog(`${KIE_FILE_BASE}/api/file-url-upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fileUrl,
      uploadPath: "metabox/media",
      ...(fileName ? { fileName } : {}),
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`KIE file upload failed: ${resp.status} ${txt}`);
  }

  const data = (await resp.json()) as KieFileUploadResponse;
  if (!data.success || data.code !== 200 || !data.data?.downloadUrl) {
    throw new Error(`KIE file upload failed: ${data.code} — ${data.msg}`);
  }

  return data.data.downloadUrl;
}
