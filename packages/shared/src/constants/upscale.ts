/**
 * Pseudo-model ids under which the upscale scenarios buffer the single
 * uploaded file (`src` slot) in `UserState.mediaInputs` between the upload
 * step and the start callback.
 *
 * Live in shared/constants so both the bot scenes (write the buffer) and
 * `packages/bot/src/commands/menu.ts` (clears them on main-menu navigation)
 * reference the same key without a circular import.
 */
export const PHOTO_UPSCALE_BUFFER_MODEL_ID = "photo_upscale";
export const VIDEO_UPSCALE_BUFFER_MODEL_ID = "video_upscale";

/** Real AI_MODELS ids backing the upscale scenarios. */
export const PHOTO_UPSCALE_MODEL_ID = "image-upscale";
export const VIDEO_UPSCALE_MODEL_ID = "video-upscale";

/** Upscale factors offered to the user — video only (photo upscale is fixed 4K). */
export const VIDEO_UPSCALE_FACTORS = ["2", "4"] as const;

/*
 * ── Video output-based pricing ───────────────────────────────────────────────
 * Цена видео-апскейла считается по РЕЗУЛЬТАТУ (фактор × разрешение × fps), а не
 * по фактору: размер исходника известен в момент загрузки, поэтому на кнопке
 * выбора фактора показываем точную цену под конкретный файл.
 */

/**
 * Video output resolution tier (Replicate Topaz: 720p / 1080p / 4k) для
 * результата `высота × фактор`. Snap к БЛИЖАЙШЕМУ тиру (пороги — середины
 * между 720/1080/2160): 1440p маппится в 1080p, а не в 4k, иначе ×2 от
 * 720p-видео тарифицировался бы как 4k и Replicate-fallback отдавал бы 2160p.
 */
export function videoResolutionTier(srcHeightPx: number, factor: number): "720p" | "1080p" | "4k" {
  const outHeight = srcHeightPx * factor;
  if (outHeight <= 900) return "720p";
  if (outHeight <= 1620) return "1080p";
  return "4k";
}

/** Source fps → render/billing tier (Replicate Topaz prices at 30 и 60 fps). */
export function videoFpsTier(srcFps: number): "30" | "60" {
  return srcFps >= 45 ? "60" : "30";
}
