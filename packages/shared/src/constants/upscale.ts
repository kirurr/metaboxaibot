/**
 * Pseudo-model ids under which the upscale scenarios buffer the single
 * uploaded file (`src` slot) in `UserState.mediaInputs` between the upload
 * step and the factor-selection callback.
 *
 * Live in shared/constants so both the bot scenes (write the buffer) and
 * `packages/bot/src/commands/menu.ts` (clears them on main-menu navigation)
 * reference the same key without a circular import.
 */
export const PHOTO_UPSCALE_BUFFER_MODEL_ID = "photo_upscale";
export const VIDEO_UPSCALE_BUFFER_MODEL_ID = "video_upscale";

/** Real AI_MODELS ids backing the upscale scenarios (KIE Topaz). */
export const PHOTO_UPSCALE_MODEL_ID = "image-upscale";
export const VIDEO_UPSCALE_MODEL_ID = "video-upscale";

/** Upscale factors offered to the user per scenario (KIE Topaz `upscale_factor`). */
export const PHOTO_UPSCALE_FACTORS = ["2", "4", "8"] as const;
export const VIDEO_UPSCALE_FACTORS = ["2", "4"] as const;
