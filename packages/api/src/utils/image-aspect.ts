import sharp from "sharp";

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
