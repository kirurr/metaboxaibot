import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "@metabox/shared";
import sharp from "sharp";
import { createRequire } from "module";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "stream";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { logger } from "../logger.js";

const _require = createRequire(import.meta.url);
const ffmpegPath: string | null = _require("ffmpeg-static") as string | null;
if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

/** Seconds until a presigned GET URL expires. */
const PRESIGN_TTL = 3600;

/**
 * Run an S3 operation once, and if it throws, run it one more time after
 * a short delay. Intended for transient network/DNS blips — any error is
 * considered retryable. Logs both the failed first attempt and the final
 * outcome so silent drops are impossible.
 */
export async function withRetry<T>(
  op: string,
  ctx: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err, op, ...ctx }, "s3 operation failed, retrying once");
    await new Promise((r) => setTimeout(r, 500));
    try {
      return await fn();
    } catch (err2) {
      logger.error({ err: err2, op, ...ctx }, "s3 operation failed after retry");
      throw err2;
    }
  }
}

function makeClient(): S3Client | null {
  const { bucket, region, endpoint, accessKeyId, secretAccessKey } = config.s3;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;

  const client = new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    // Required for path-style S3 endpoints (MinIO, R2)
    forcePathStyle: !!endpoint,
    // Эти флаги контролируют ВАЛИДАЦИЮ checksum'ов на стороне SDK, но НЕ
    // убирают `x-amz-checksum-mode` из самого исходящего запроса (SDK v3.729+
    // добавляет его автоматически на каждый GetObject). Для presigned URL
    // этот query-param попадает в подпись → Wasabi 403 при скачивании из
    // внешних сервисов (e.g., OpenAI fetcher для PDF). Удаляем его через
    // middleware ниже.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  // Strip auto-added `x-amz-checksum-mode` header BEFORE signing.
  // build-step middleware вмешивается до finalizeRequest/signing — query
  // params (для presigned URL) и headers (для live requests) формируются
  // на основе headers до этого момента, поэтому хедер удаляется и из URL,
  // и из real-request'ов. Без этого presigned URL содержит
  // `?x-amz-checksum-mode=ENABLED&...` который Wasabi 403'ит.
  client.middlewareStack.add(
    (next) => async (args) => {
      const req = args.request as { headers?: Record<string, string> };
      if (req?.headers) {
        delete req.headers["x-amz-checksum-mode"];
        delete req.headers["X-Amz-Checksum-Mode"];
      }
      return next(args);
    },
    {
      step: "build",
      name: "stripChecksumModeHeader",
      priority: "high",
      override: true,
    },
  );

  return client;
}

/** Builds the S3 key for a generated file. */
export function buildS3Key(section: string, userId: string, jobId: string, ext: string): string {
  return `${section}/${userId}/${jobId}.${ext}`;
}

/** Returns the content-type and extension for a given section. */
export function sectionMeta(section: string): { ext: string; contentType: string } {
  if (section === "audio") return { ext: "mp3", contentType: "audio/mpeg" };
  if (section === "video") return { ext: "mp4", contentType: "video/mp4" };
  return { ext: "jpg", contentType: "image/jpeg" };
}

/**
 * Лёгкая проверка существования объекта в bucket'е через HeadObject.
 * Использовать при сабмите медиа-input'ов в провайдер: если файл удалили
 * (юзер дропнул генерацию из галереи, lifecycle-policy bucket'а и т.п.) —
 * провайдер пойдёт по presigned URL и получит 404, тратя время и кредиты.
 * Возвращаем `false` на 404/NoSuchKey, `true` на 200, и `null` если S3 не
 * сконфигурен или возникла иная ошибка (тогда вызывающий код предпочтёт
 * не блокировать сабмит — fail-open semantics).
 */
export async function objectExists(key: string): Promise<boolean | null> {
  const client = makeClient();
  if (!client) {
    return null;
  }
  try {
    await client.send(new HeadObjectCommand({ Bucket: config.s3.bucket!, Key: key }));
    return true;
  } catch (err) {
    const status =
      (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? null;
    const name = (err as { name?: string })?.name;
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") return false;
    logger.warn({ err, key, status }, "objectExists: HEAD failed unexpectedly");
    return null;
  }
}

/**
 * Download an object from S3 as a Buffer. Returns null if S3 is not configured
 * or the object isn't accessible. Used when we need raw bytes server-side
 * (e.g., to upload to OpenAI Files API).
 */
export async function downloadBuffer(key: string): Promise<Buffer | null> {
  const client = makeClient();
  if (!client) {
    logger.warn({ key }, "downloadBuffer: S3 not configured");
    return null;
  }

  try {
    const res = await client.send(new GetObjectCommand({ Bucket: config.s3.bucket!, Key: key }));
    if (!res.Body) return null;
    const stream = res.Body as unknown as { transformToByteArray(): Promise<Uint8Array> };
    const bytes = await stream.transformToByteArray();
    return Buffer.from(bytes);
  } catch (err) {
    logger.error({ err, key }, "downloadBuffer: failed");
    return null;
  }
}

/**
 * Upload a Buffer to S3. Retries once on transient errors.
 * Returns the S3 key on success, null if S3 is not configured.
 * Throws after two failed attempts — callers decide how to recover.
 */
export async function uploadBuffer(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<string | null> {
  const client = makeClient();
  if (!client) {
    logger.warn({ key }, "uploadBuffer: S3 not configured, skipping");
    return null;
  }

  await withRetry("uploadBuffer", { key, contentType, size: buffer.byteLength }, () =>
    client.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket!,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    ),
  );

  return key;
}

/**
 * Fetch a remote URL and upload the response body to S3. Retries the
 * fetch+upload pipeline once on failure. Returns the S3 key on success,
 * null if S3 is not configured. Throws if the remote fetch or upload
 * keeps failing after the retry.
 */
export async function uploadFromUrl(
  key: string,
  url: string,
  contentType: string,
): Promise<string | null> {
  const client = makeClient();
  if (!client) {
    logger.warn({ key, url }, "uploadFromUrl: S3 not configured, skipping");
    return null;
  }

  return withRetry("uploadFromUrl", { key, url, contentType }, async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch file for S3 upload: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.byteLength) {
      throw new Error(`Fetched body is empty for S3 upload: ${url}`);
    }
    await client.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket!,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
    return key;
  });
}

/**
 * Returns a presigned GET URL for an object in the PRIVATE bucket
 * (valid for PRESIGN_TTL seconds). Returns null if S3 is not configured.
 *
 * For publicly served assets, use `publicS3Service.getFileUrl` instead.
 *
 * Pass `downloadFilename` to force browser download via Content-Disposition: attachment.
 */
export async function getFileUrl(key: string, downloadFilename?: string): Promise<string | null> {
  const { bucket } = config.s3;
  if (!bucket) {
    logger.warn({ key }, "getFileUrl: S3 bucket not configured");
    return null;
  }

  const client = makeClient();
  if (!client) {
    logger.warn({ key }, "getFileUrl: S3 client not configured");
    return null;
  }

  try {
    return await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(downloadFilename
          ? { ResponseContentDisposition: `attachment; filename="${downloadFilename}"` }
          : {}),
      }),
      { expiresIn: PRESIGN_TTL },
    );
  } catch (err) {
    logger.error({ err, key }, "getFileUrl: failed to sign URL");
    return null;
  }
}

/**
 * Derives the S3 key for a thumbnail from the original S3 key.
 * e.g. "image/123/abc.jpg" → "image/123/abc_thumb.webp"
 */
export function buildThumbnailKey(s3Key: string): string {
  const dot = s3Key.lastIndexOf(".");
  const base = dot !== -1 ? s3Key.slice(0, dot) : s3Key;
  return `${base}_thumb.webp`;
}

/**
 * Fetches an image URL and returns its size in megapixels
 * (width × height / 1_000_000). Throws on fetch/decode failures so
 * the caller can decide whether to fall back to a default.
 */
export async function measureImageMegapixels(imageUrl: string): Promise<number> {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image for measurement: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) throw new Error("Could not read image dimensions");
  return (meta.width * meta.height) / 1_000_000;
}

export interface NormalizedImageUpload {
  /** S3 key of the uploaded normalized JPEG. */
  key: string;
  /** Megapixels of the normalized image. */
  megapixels: number;
  /** Width of the normalized image, px. */
  width: number;
  /** Height of the normalized image, px. */
  height: number;
}

/**
 * Fetches an image, normalizes it to a provider-safe JPEG and uploads to S3.
 *
 * Re-encoding through sharp fixes inputs that AI upscale providers (Topaz)
 * reject with "Image format error" — HEIC, CMYK, 16-bit, progressive JPEG,
 * animated/odd WebP, broken ICC/EXIF. EXIF orientation is baked in (`.rotate()`)
 * and alpha is flattened on white (JPEG has no alpha channel).
 *
 * Returns the S3 key and the normalized image's megapixels (single fetch +
 * decode — caller doesn't need a separate `measureImageMegapixels` call).
 * Throws on fetch/decode/upload failure so the caller can surface an error.
 */
export async function uploadNormalizedImage(
  key: string,
  sourceUrl: string,
): Promise<NormalizedImageUpload> {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`Failed to fetch image for normalization: ${res.status}`);
  const srcBuf = Buffer.from(await res.arrayBuffer());
  const { data, info } = await sharp(srcBuf)
    .rotate()
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 92 })
    .toBuffer({ resolveWithObject: true });
  const uploaded = await uploadBuffer(key, data, "image/jpeg");
  // uploadBuffer возвращает null если S3 не сконфигурирован — НЕ выдаём
  // фейковый success с несуществующим ключом, иначе вызывающий код пойдёт
  // дальше с мёртвым S3-ключом. Бросаем — caller обработает как сбой.
  if (!uploaded) throw new Error("uploadNormalizedImage: S3 upload failed (not configured?)");
  return {
    key: uploaded,
    megapixels: (info.width * info.height) / 1_000_000,
    width: info.width,
    height: info.height,
  };
}

export interface ImageProbeInfo {
  width: number;
  height: number;
  fileSizeBytes: number;
}

/**
 * Fetches an image URL and reads width/height via sharp, plus the byte length.
 * Throws on fetch/decode failures so the caller can decide how to surface the error.
 */
export async function probeImageMetadata(imageUrl: string): Promise<ImageProbeInfo> {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to fetch image for probe: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) throw new Error("Could not read image dimensions");
  return { width: meta.width, height: meta.height, fileSizeBytes: buf.byteLength };
}

/**
 * Generates a 400px-wide WebP thumbnail from an image buffer.
 * Returns null for SVG or non-image content types.
 *
 * `.rotate()` without arguments applies EXIF orientation so phone photos
 * come out right-side-up in the thumbnail.
 *
 * The content-type guard treats unknown types (e.g. `application/octet-stream`)
 * as potentially valid images — sharp will reject them safely if they aren't.
 */
export async function generateThumbnail(buf: Buffer, contentType: string): Promise<Buffer | null> {
  if (contentType === "image/svg+xml") return null;
  if (
    contentType &&
    !contentType.startsWith("image/") &&
    contentType !== "application/octet-stream"
  )
    return null;
  try {
    return await sharp(buf)
      .rotate() // honour EXIF orientation
      .resize({ width: 400, withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
  } catch (err) {
    logger.warn({ err, contentType }, "generateThumbnail failed");
    return null;
  }
}

/**
 * Re-encodes an image to a JPEG small enough for Telegram sendPhoto.
 * Telegram rejects photos over ~10MB and dimensions whose sum exceeds 10000.
 * Scales down to max 4096 on the longest side and steps JPEG quality down
 * until the result fits `targetBytes`. Halves dimensions as last resort.
 */
export async function compressForTelegramPhoto(
  input: Buffer,
  targetBytes: number = 9 * 1024 * 1024,
): Promise<Buffer> {
  const MAX_DIM = 4096;
  const meta = await sharp(input).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const needsResize = width > MAX_DIM || height > MAX_DIM;
  const base = () => {
    const p = sharp(input).rotate();
    return needsResize
      ? p.resize({ width: MAX_DIM, height: MAX_DIM, fit: "inside", withoutEnlargement: true })
      : p;
  };

  let quality = 90;
  let out = await base().jpeg({ quality, mozjpeg: true }).toBuffer();
  while (out.byteLength > targetBytes && quality > 30) {
    quality -= 15;
    out = await base().jpeg({ quality, mozjpeg: true }).toBuffer();
  }
  if (out.byteLength > targetBytes && width > 0) {
    out = await sharp(input)
      .rotate()
      .resize({ width: Math.max(512, Math.floor(width / 2)) })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
  }
  return out;
}

/**
 * Extracts a single frame (~1s in) from a video buffer and returns a
 * 400px-wide WebP thumbnail. Returns null on any failure.
 *
 * We write the buffer to a temp file first instead of piping via stdin
 * because ffmpeg's `-ss` seek requires a seekable input — non-seekable
 * stdin streams silently produce zero frames, which is what made every
 * previous video job end up with thumbnailS3Key=null.
 */
export async function generateVideoThumbnail(buf: Buffer): Promise<Buffer | null> {
  const tmpFile = join(tmpdir(), `vid-${randomUUID()}.mp4`);
  try {
    await writeFile(tmpFile, buf);

    const rawFrame: Buffer = await new Promise((resolve, reject) => {
      const output = new PassThrough();
      const chunks: Buffer[] = [];
      output.on("data", (c: Buffer) => chunks.push(c));
      output.on("end", () => resolve(Buffer.concat(chunks)));
      output.on("error", reject);

      ffmpeg(tmpFile)
        .inputOptions(["-ss", "1"])
        .outputOptions(["-frames:v", "1", "-f", "image2", "-vcodec", "mjpeg"])
        .on("error", reject)
        .pipe(output, { end: true });
    });

    if (!rawFrame.length) {
      logger.warn("generateVideoThumbnail: ffmpeg produced zero-byte frame");
      return null;
    }

    return await sharp(rawFrame)
      .resize({ width: 400, withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();
  } catch (err) {
    logger.warn({ err }, "generateVideoThumbnail failed");
    return null;
  } finally {
    await unlink(tmpFile).catch(() => void 0);
  }
}

/**
 * Extracts a single frame (~1s in) and returns a JPEG ≤320px wide at quality
 * tuned to stay under Telegram's 200KB thumbnail limit. JPEG (not WebP) is
 * required by Telegram's `thumbnail` field on sendVideo/sendDocument.
 */
export async function generateVideoJpegThumbnail(buf: Buffer): Promise<Buffer | null> {
  const tmpFile = join(tmpdir(), `vidthumb-${randomUUID()}.mp4`);
  try {
    await writeFile(tmpFile, buf);
    const rawFrame: Buffer = await new Promise((resolve, reject) => {
      const output = new PassThrough();
      const chunks: Buffer[] = [];
      output.on("data", (c: Buffer) => chunks.push(c));
      output.on("end", () => resolve(Buffer.concat(chunks)));
      output.on("error", reject);
      ffmpeg(tmpFile)
        .inputOptions(["-ss", "1"])
        .outputOptions(["-frames:v", "1", "-f", "image2", "-vcodec", "mjpeg"])
        .on("error", reject)
        .pipe(output, { end: true });
    });
    if (!rawFrame.length) return null;

    let quality = 80;
    let out = await sharp(rawFrame)
      .resize({ width: 320, withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer();
    while (out.byteLength > 200 * 1024 && quality > 40) {
      quality -= 15;
      out = await sharp(rawFrame)
        .resize({ width: 320, withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "generateVideoJpegThumbnail failed");
    return null;
  } finally {
    await unlink(tmpFile).catch(() => void 0);
  }
}

/**
 * Remuxes an MP4 with `-movflags +faststart` so the moov atom is at the front.
 * Stream-copies video/audio (no re-encoding). Returns the original buffer on
 * any failure — Telegram may still render it, just without a reliable probe.
 *
 * Purpose: Telegram's inline preview runs a partial probe that reads only the
 * head of the file. When moov is at the end (common for several AI video
 * providers), the probe returns wrong dimensions, which is what breaks the
 * aspect ratio in chat. Downloading plays fine because the client reads the
 * whole file.
 */
export async function remuxToFaststart(buf: Buffer): Promise<Buffer> {
  const inFile = join(tmpdir(), `remux-in-${randomUUID()}.mp4`);
  const outFile = join(tmpdir(), `remux-out-${randomUUID()}.mp4`);
  try {
    await writeFile(inFile, buf);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inFile)
        .outputOptions(["-c", "copy", "-movflags", "+faststart"])
        .on("error", reject)
        .on("end", () => resolve())
        .save(outFile);
    });
    const { readFile } = await import("fs/promises");
    const out = await readFile(outFile);
    return out.byteLength > 0 ? out : buf;
  } catch (err) {
    logger.warn({ err }, "remuxToFaststart failed, using original buffer");
    return buf;
  } finally {
    await unlink(inFile).catch(() => void 0);
    await unlink(outFile).catch(() => void 0);
  }
}

/**
 * Delete an object from S3. Returns true on success (or if S3 is not
 * configured — nothing to clean up), false on failure. Missing keys are
 * treated as success since the goal state (object gone) is already met.
 */
export async function deleteFile(key: string): Promise<boolean> {
  const client = makeClient();
  if (!client) {
    logger.warn({ key }, "deleteFile: S3 not configured, treating as success");
    return true;
  }

  try {
    await withRetry("deleteFile", { key }, () =>
      client.send(
        new DeleteObjectCommand({
          Bucket: config.s3.bucket!,
          Key: key,
        }),
      ),
    );
    return true;
  } catch (err) {
    logger.error({ err, key }, "deleteFile: failed to delete after retry");
    return false;
  }
}

/**
 * Fetched image bytes plus an optional public/presigned URL pointing at the
 * same bytes in S3. `url` is null when the bucket is not configured or the
 * upload failed — callers must be prepared to fall back (e.g. inline base64).
 */
export interface MaterializedImageInput {
  /** Public or presigned URL when the upload succeeded; null when caller must fall back. */
  url: string | null;
  /** Raw bytes of the source image. Always present — buffered once. */
  buffer: Buffer;
  /** Resolved image content type (`image/jpeg` if the source response did not provide one). */
  contentType: string;
}

/**
 * Materialise an arbitrary image URL (typically a short-lived Telegram file
 * URL) into a stable S3 URL suitable for AI providers that cannot fetch from
 * `api.telegram.org` directly. Designed for one-shot inputs whose lifetime
 * does not need to outlive the generation: callers are expected to clean up
 * via an S3 lifecycle rule on the chosen `keyPrefix` (e.g. delete after 2
 * days), not via explicit deletion.
 *
 * The source URL is fetched exactly once. The resulting buffer is returned
 * to the caller alongside the URL so a base64 fallback path does not need
 * to refetch when S3 is unavailable.
 *
 * Throws only on the initial fetch failure (no point falling back if we
 * cannot read the source). S3 upload failures are logged and surfaced as
 * `url = null` so the caller can pick its own fallback strategy.
 */
export async function materializeImageInput(
  srcUrl: string,
  opts: { keyPrefix: string; userId: string | bigint; jobId: string },
): Promise<MaterializedImageInput> {
  const res = await fetch(srcUrl);
  if (!res.ok) {
    throw new Error(`materializeImageInput: failed to fetch source: ${res.status}`);
  }
  const rawType = res.headers.get("content-type") ?? "";
  const contentType = rawType.startsWith("image/") ? rawType.split(";")[0]!.trim() : "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.byteLength) {
    throw new Error(`materializeImageInput: source returned empty body: ${srcUrl}`);
  }

  const ext =
    contentType
      .slice("image/".length)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "jpg";
  const normalizedPrefix = opts.keyPrefix.replace(/\/+$/, "");
  const key = `${normalizedPrefix}/${opts.userId}/${opts.jobId}.${ext}`;

  let url: string | null = null;
  try {
    const uploaded = await uploadBuffer(key, buffer, contentType);
    if (uploaded) {
      url = await getFileUrl(uploaded);
    }
  } catch (err) {
    logger.warn({ err, key }, "materializeImageInput: S3 upload failed, falling back to inline");
  }

  return { url, buffer, contentType };
}

export const s3Service = {
  buildS3Key,
  buildThumbnailKey,
  sectionMeta,
  uploadBuffer,
  uploadFromUrl,
  uploadNormalizedImage,
  getFileUrl,
  deleteFile,
  generateThumbnail,
  generateVideoThumbnail,
  materializeImageInput,
};
