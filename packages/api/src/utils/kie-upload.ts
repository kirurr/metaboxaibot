import { randomBytes, randomUUID } from "node:crypto";
import { UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "./fetch.js";
import { centerCropToAspect } from "./image-aspect.js";

const KIE_FILE_BASE = "https://kieai.redpandaai.co";

// Kling 3.0 / KIE image upload жёсткий лимит — 10 МБ/файл (см. kling3.md
// §"File Upload Requirements"). Сверх лимита KIE возвращает 400 generic
// сообщением, юзер видит generationFailed без подсказки. Делаем pre-flight
// check после crop'а: даём явный UserFacingError ("картинка слишком большая").
const KIE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

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

/** Видео-контейнеры, принимаемые KIE Topaz / Kling (mp4 / quicktime / matroska). */
const KNOWN_VIDEO_EXTS: ReadonlyArray<string> = ["mp4", "mov", "mkv"];

/**
 * Имя для video-upload в KIE — аналог `buildKieUploadName`, но для видео.
 * `parseImageMime` знает только картиночные расширения и для `.mp4`-ссылки
 * дефолтит в `.jpg`, поэтому нужна отдельная функция. Без видео-расширения KIE
 * кладёт файл под random-именем БЕЗ extension'а, и Topaz video-upscale не
 * может определить контейнер → KIE `failCode 500` / Replicate
 * `source.container is required`. Дефолт — `mp4`.
 */
export function buildKieVideoUploadName(url: string): string {
  let ext = "mp4";
  try {
    const m = new URL(url).pathname.match(/\.([a-zA-Z0-9]+)$/);
    if (m && KNOWN_VIDEO_EXTS.includes(m[1].toLowerCase())) {
      ext = m[1].toLowerCase();
    }
  } catch {
    /* not a parseable URL — default mp4 */
  }
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
    const err = new Error(`KIE file upload failed: ${resp.status} ${txt}`) as Error & {
      status: number;
    };
    err.status = resp.status;
    throw err;
  }

  const data = (await resp.json()) as KieFileUploadResponse;
  if (!data.success || data.code !== 200 || !data.data?.downloadUrl) {
    // KIE сам пытается GET'нуть `fileUrl` (наш presigned S3 URL) и проксирует
    // ошибку upstream'а в `data.msg`. Если апстрим вернул 404 — файл удалили
    // ПОСЛЕ submit'а (юзер дропнул output из галереи) или HEAD-check на
    // bot-side fail-open'нулся. Это юзерская ситуация, не баг — кидаем
    // UserFacingError(mediaSlotExpired) вместо generic Error, чтобы юзер
    // увидел понятное «загрузите файл повторно», и notifyOps не зажигался.
    if (
      data.code === 400 &&
      typeof data.msg === "string" &&
      /File download failed[\s\S]*?404 Not Found/i.test(data.msg)
    ) {
      throw new UserFacingError(`KIE upload: source returned 404`, {
        key: "mediaSlotExpired",
      });
    }
    throw new Error(`KIE file upload failed: ${data.code} — ${data.msg}`);
  }

  return data.data.downloadUrl;
}

/**
 * Upload a binary buffer to KIE via `/api/file-stream-upload` (multipart/form-data).
 *
 * Используется когда нужно загрузить локально-обработанный buffer (например
 * центр-кропнутый кадр под целевой aspect для Kling 3.0), а не URL. URL-based
 * `uploadFileUrl` для buffer'а не подходит — KIE качает сам по URL.
 *
 * Multipart строим вручную, не через FormData/undici: см. heygen.adapter.ts
 * — undici иногда теряет per-part Content-Type для Blob/File, что не годится
 * для строгих валидаторов на стороне KIE/HeyGen.
 */
export async function uploadFileStream(
  apiKey: string,
  buf: Buffer,
  fileName: string,
  mimeType: string = "image/jpeg",
  uploadPath: string = "metabox/media",
): Promise<string> {
  const boundary = `----metabox${randomBytes(16).toString("hex")}`;
  const CRLF = "\r\n";

  const filePart = Buffer.concat([
    Buffer.from(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}` +
        `Content-Type: ${mimeType}${CRLF}${CRLF}`,
    ),
    buf,
    Buffer.from(CRLF),
  ]);
  const pathPart = Buffer.from(
    `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="uploadPath"${CRLF}${CRLF}${uploadPath}${CRLF}`,
  );
  const nameField = Buffer.from(
    `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="fileName"${CRLF}${CRLF}${fileName}${CRLF}`,
  );
  const closing = Buffer.from(`--${boundary}--${CRLF}`);
  const body = Buffer.concat([filePart, pathPart, nameField, closing]);

  const resp = await fetchWithLog(`${KIE_FILE_BASE}/api/file-stream-upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!resp.ok) {
    const txt = await resp.text();
    const err = new Error(`KIE file-stream-upload failed: ${resp.status} ${txt}`) as Error & {
      status: number;
    };
    err.status = resp.status;
    throw err;
  }

  const data = (await resp.json()) as KieFileUploadResponse;
  if (!data.success || data.code !== 200 || !data.data?.downloadUrl) {
    throw new Error(`KIE file-stream-upload failed: ${data.code} — ${data.msg}`);
  }

  return data.data.downloadUrl;
}

/**
 * Fetch URL → центр-кроп под target aspect → upload в KIE.
 *
 * Если картинка уже в нужном aspect (±1%) — `centerCropToAspect` вернёт тот же
 * buffer reference, и мы делегируем оригинальному URL-based uploadFileUrl
 * (без перекодирования и лишнего raw-upload через stream).
 *
 * Используется для Kling 3.0 frame inputs (`image_urls`): KIE auto-адаптирует
 * output video aspect под dimensions image_urls, игнорируя явный
 * `aspect_ratio`. Pre-crop гарантирует что Kling'овский auto-adapt даст
 * именно выбранный юзером ratio.
 */
export async function uploadFileUrlCroppedToAspect(
  apiKey: string,
  fileUrl: string,
  aspectRatio: string,
  fileName: string,
): Promise<string> {
  // fetchWithLog: пишет debug-лог, тегает network failures `fetch GET <url>
  // failed (<code>)` чтобы isTransientNetworkError / virtual-batch fallback
  // ловили их корректно. Голый fetch потерял бы и observability, и cause-chain.
  let resp: Response;
  try {
    resp = await fetchWithLog(fileUrl);
  } catch (err) {
    // Префикс `KIE` — чтобы isKieTransientError ([utils/kie-error.ts]) словил
    // network ошибку (DNS / ECONNRESET / 5xx) на стадии fetch source-image и
    // запустил virtual-batch fallback resubmit вместо мгновенного отказа.
    throw new Error(`KIE crop-fetch failed: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  if (!resp.ok) {
    // Drain тело — иначе огромный HTML error-page от прокси/CDN остаётся
    // в памяти до GC. resp.body.cancel() освобождает сразу.
    resp.body?.cancel().catch(() => {});
    // 404/410 на presigned URL обычно значит "ссылка протухла" или "файл
    // удалён" — даём конкретный UserFacingError, иначе юзер видит generic
    // generationFailed и думает что бот сломан. Паттерн совпадает с тем как
    // kie.adapter.ts маппит `chatInvalidImage` на input-format-ошибки KIE.
    if (resp.status === 404 || resp.status === 410) {
      throw new UserFacingError(`Source image not found (HTTP ${resp.status})`, {
        key: "chatInvalidImage",
      });
    }
    throw new Error(`KIE crop-fetch failed: HTTP ${resp.status}`);
  }

  // Pre-check по content-length: 50МБ raw PNG скачивать → 1-2с CPU на decode+
  // crop+encode → выяснить что > 10МБ → throw. Лимит на raw устанавливаем как
  // 3× KIE_IMAGE_MAX_BYTES — JPEG q=95 mozjpeg обычно сжимает PNG в ~3 раза,
  // запас покрывает крайние случаи. Если content-length не указан (chunked
  // transfer) — пропускаем и проверяем post-crop.
  const SOURCE_MAX_BYTES = KIE_IMAGE_MAX_BYTES * 3;
  const contentLength = Number(resp.headers.get("content-length") ?? 0);
  if (contentLength > SOURCE_MAX_BYTES) {
    resp.body?.cancel().catch(() => {});
    throw new UserFacingError(
      `Source image too large (${contentLength} bytes, max ${SOURCE_MAX_BYTES})`,
      { key: "chatInvalidImage" },
    );
  }

  const raw = Buffer.from(await resp.arrayBuffer());

  const cropped = await centerCropToAspect(raw, aspectRatio);
  if (cropped === raw) {
    return uploadFileUrl(apiKey, fileUrl, fileName);
  }

  if (cropped.byteLength > KIE_IMAGE_MAX_BYTES) {
    throw new UserFacingError(
      `Image too large after crop (${cropped.byteLength} bytes, max ${KIE_IMAGE_MAX_BYTES})`,
      { key: "chatInvalidImage" },
    );
  }

  // После crop пайплайн сохраняет JPEG (см. centerCropToAspect). Приводим
  // имя к `.jpg`, чтобы downstream KIE-модели валидирующие тип по extension'у
  // не ругались на mismatch (например nano-banana-2 принимает только
  // jpeg/jpg/png — см. kie-upload jsdoc).
  const jpgName = fileName.replace(/\.[a-zA-Z0-9]+$/, "") + ".jpg";
  return uploadFileStream(apiKey, cropped, jpgName, "image/jpeg");
}
