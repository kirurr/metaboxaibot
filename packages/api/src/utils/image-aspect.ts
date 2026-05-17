import sharp from "sharp";
import { logger } from "../logger.js";
import { fetchWithLog } from "./fetch.js";
import { uploadBuffer, getFileUrl } from "../services/s3.service.js";

/**
 * Aspect ratios that Kling 3.0 returns as native output dimensions. Pre-crop
 * makes sense ONLY for these — other ratios (4:3, 21:9 …) Kling rejects with
 * 400 anyway, so cropping for them just wastes CPU. Shared between every
 * provider that pre-crops Kling frame inputs (KIE primary + evolink/fal
 * fallback).
 */
export const KLING_SUPPORTED_ASPECTS: readonly string[] = ["16:9", "9:16", "1:1"];

/**
 * Hard cap on source-image bytes we'll fetch+decode for cropping. JPEG q=95
 * mozjpeg типично сжимает PNG ~3×, так что ставим source-cap = 3× output-cap.
 * Сейчас output-cap у каждого call site свой (KIE = 10MB), но 30MB как
 * common ceiling for source — безопасный default. Превышение → degrade to
 * uncropped source URL (consistent с остальными failure paths этого модуля —
 * crop best-effort, submit не должен ломаться из-за оверсайз source'а).
 */
const SOURCE_MAX_BYTES = 30 * 1024 * 1024;

/**
 * Center-crop image buffer to a target aspect ratio.
 *
 * Use case: Kling 3.0 (kie provider) auto-adapts output video aspect to input
 * image dimensions when `image_urls` is set, ignoring the explicit
 * `aspect_ratio` parameter (see docs/schema/kie/kling3.md §"Aspect Ratio
 * Auto-Adaptation"). To force the user-selected aspect to win we pre-crop
 * frame inputs before upload — then Kling's auto-adapt produces exactly the
 * ratio the user chose.
 *
 * EXIF orientation is honoured: if `meta.orientation` swaps width/height
 * (codes 5–8), the swapped dimensions are used for the aspect comparison
 * and `sharp().rotate().extract()` materialises the rotation before extract,
 * so coordinates are in post-rotation space.
 *
 * Returns the original buffer (same reference) when the image is already in
 * the target aspect (±1%) or metadata can't be read — callers can use the
 * reference identity to skip a redundant re-upload.
 */

const RATIO_TOLERANCE = 0.01;

export function parseAspectRatio(ratio: string): number | null {
  if (ratio === "16:9") return 16 / 9;
  if (ratio === "9:16") return 9 / 16;
  if (ratio === "1:1") return 1;
  const m = ratio.match(/^(\d+):(\d+)$/);
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!num || !den) return null;
  return num / den;
}

export async function centerCropToAspect(buf: Buffer, aspectRatio: string): Promise<Buffer> {
  const target = parseAspectRatio(aspectRatio);
  if (target === null) return buf;

  let meta: sharp.Metadata;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    return buf;
  }
  if (!meta.width || !meta.height) return buf;

  // EXIF orientation 5..8 swap width/height визуально. Сравнение должно идти
  // в post-rotation пространстве, иначе портретное фото с EXIF rotate-90
  // (raw 4032×3024 но displayed 3024×4032) ошибочно считается landscape.
  const swap = meta.orientation !== undefined && meta.orientation >= 5 && meta.orientation <= 8;
  const w = swap ? meta.height : meta.width;
  const h = swap ? meta.width : meta.height;

  const src = w / h;
  if (Math.abs(src - target) / target < RATIO_TOLERANCE) {
    // Aspect уже совпадает. Если у картинки нет EXIF-rotation (swap=false) —
    // возвращаем оригинальный buffer reference, чтобы caller мог опознать
    // no-op и делегировать URL-upload без re-encode.
    //
    // Если orientation 5–8 (swap=true) — байты содержат raw dimensions,
    // визуальный aspect получается из EXIF-тэга. Downstream (KIE/Kling)
    // не обязан honor'ить EXIF при auto-adapt'е (judges по raw decoded
    // dimensions), поэтому нужно ОБЯЗАТЕЛЬНО запечь rotation в пиксели,
    // иначе портретное фото с rotate-90 EXIF трактуется как landscape
    // → Kling выдаст не тот aspect. Re-encode без extract'а — pipeline
    // сохраняет full размер, просто применяет .rotate().
    if (!swap) return buf;
    return sharp(buf)
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 95, mozjpeg: true })
      .toBuffer();
  }

  let cropW: number;
  let cropH: number;
  if (src > target) {
    cropH = h;
    cropW = Math.round(h * target);
  } else {
    cropW = w;
    cropH = Math.round(w / target);
  }
  const left = Math.round((w - cropW) / 2);
  const top = Math.round((h - cropH) / 2);

  return sharp(buf)
    .rotate()
    .extract({ left, top, width: cropW, height: cropH })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer();
}

/**
 * Fetch a remote image URL → center-crop to `aspectRatio` → upload the
 * cropped JPEG to PRIVATE S3 → return a presigned URL (valid PRESIGN_TTL sec,
 * currently 1h — see s3.service.ts).
 *
 * Used by video adapters that hand image URLs to a provider directly (FAL,
 * evolink) — the provider downloads via presigned URL, so the cropped bytes
 * never leave our private bucket as a long-lived public asset. KIE goes
 * through its own `uploadFileStream` to KIE's namespace — see
 * `kie-upload.ts:uploadFileUrlCroppedToAspect`.
 *
 * Storage shape: `crop/${userId}/${syntheticJobKey}-${aspect}.jpg`. Matches
 * the `runway-input/...` convention (runway.adapter.ts:resolvePromptImage)
 * so the same S3 lifecycle policy on the `crop/` prefix can reap old
 * objects (must be configured out-of-band on the bucket). `userId` defaults
 * to "anonymous" when not provided. `syntheticJobKey` mirrors runway's
 * `${Date.now()}-${randomHex}` approach — adapter API doesn't carry jobId.
 *
 * Returns the original `srcUrl` unchanged when:
 *   - aspect is not in `KLING_SUPPORTED_ASPECTS` (Kling rejects them anyway)
 *   - the image is already at the target aspect (`centerCropToAspect`
 *     returned the same buffer reference) — saves a redundant re-upload
 *   - S3 isn't configured / upload fails / presign fails (graceful
 *     degradation: warn + uncropped URL — provider may still succeed,
 *     cropping is best-effort UX, not a hard requirement)
 *   - source fetch / decode fails (warn + uncropped URL)
 *   - source exceeds SOURCE_MAX_BYTES (warn + uncropped URL — consistent
 *     with the other failure paths; submission shouldn't hard-fail on
 *     oversized source)
 *
 * Never throws. Caller relies on this contract.
 */
export async function cropImageUrlAndMaterialize(
  srcUrl: string,
  aspectRatio: string,
  opts: { userId?: bigint } = {},
): Promise<string> {
  if (!KLING_SUPPORTED_ASPECTS.includes(aspectRatio)) {
    return srcUrl;
  }

  let resp: Response;
  try {
    resp = await fetchWithLog(srcUrl);
  } catch (err) {
    logger.warn(
      { err, srcUrl, aspectRatio },
      "cropImageUrlAndMaterialize: source fetch failed, returning uncropped URL",
    );
    return srcUrl;
  }
  if (!resp.ok) {
    resp.body?.cancel().catch(() => {});
    logger.warn(
      { status: resp.status, srcUrl, aspectRatio },
      "cropImageUrlAndMaterialize: source HTTP error, returning uncropped URL",
    );
    return srcUrl;
  }

  const contentLength = Number(resp.headers.get("content-length") ?? 0);
  if (contentLength > SOURCE_MAX_BYTES) {
    resp.body?.cancel().catch(() => {});
    logger.warn(
      { contentLength, srcUrl, aspectRatio },
      "cropImageUrlAndMaterialize: source too large, returning uncropped URL",
    );
    return srcUrl;
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(await resp.arrayBuffer());
  } catch (err) {
    logger.warn(
      { err, srcUrl, aspectRatio },
      "cropImageUrlAndMaterialize: source body read failed, returning uncropped URL",
    );
    return srcUrl;
  }

  let cropped: Buffer;
  try {
    cropped = await centerCropToAspect(raw, aspectRatio);
  } catch (err) {
    logger.warn(
      { err, srcUrl, aspectRatio },
      "cropImageUrlAndMaterialize: crop failed, returning uncropped URL",
    );
    return srcUrl;
  }
  if (cropped === raw) {
    return srcUrl;
  }

  const userKey = opts.userId !== undefined ? opts.userId.toString() : "anonymous";
  const jobKey = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const aspectKey = aspectRatio.replace(":", "x");
  const key = `crop/${userKey}/${jobKey}-${aspectKey}.jpg`;

  let storedKey: string | null;
  try {
    storedKey = await uploadBuffer(key, cropped, "image/jpeg");
  } catch (err) {
    logger.warn(
      { err, key, srcUrl, aspectRatio },
      "cropImageUrlAndMaterialize: S3 upload failed, returning uncropped URL",
    );
    return srcUrl;
  }
  if (!storedKey) {
    return srcUrl;
  }

  let presignedUrl: string | null;
  try {
    presignedUrl = await getFileUrl(storedKey);
  } catch (err) {
    logger.warn(
      { err, key: storedKey, srcUrl, aspectRatio },
      "cropImageUrlAndMaterialize: presign failed, returning uncropped URL",
    );
    return srcUrl;
  }
  if (!presignedUrl) {
    return srcUrl;
  }
  return presignedUrl;
}
