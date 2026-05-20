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

/**
 * Жёсткий лимит KIE Topaz image-upscale: самая длинная сторона входного
 * изображения × upscale_factor не должна превышать 20 000 px (правило из
 * KIE playground; превышение → 422 «The image exceeds the limit after
 * scaling»). Превентивно валидируем по нему — не предлагаем юзеру фактор,
 * который заведомо упадёт.
 */
export const UPSCALE_MAX_LONGEST_SIDE_PX = 20_000;

/** True если результат `factor` укладывается в лимит Topaz по длинной стороне. */
export function photoFactorFits(longestSidePx: number, factor: number): boolean {
  return longestSidePx * factor <= UPSCALE_MAX_LONGEST_SIDE_PX;
}

/*
 * ── Dynamic output-based pricing ─────────────────────────────────────────────
 * Цена апскейла считается по РЕЗУЛЬТАТУ, а не по фактору: размер исходника
 * известен в момент загрузки, поэтому на кнопке выбора фактора показываем
 * точную цену под конкретный файл. Это покрывает обоих провайдеров —
 * KIE (фикс за фактор) и Replicate (по разрешению/мегапикселям результата) —
 * и не даёт уйти в минус на fallback.
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

/**
 * Output-megapixel tiers фото-апскейла (по прайс-таблице Replicate Topaz,
 * выше 512 — линейная экстраполяция ~$0.0016/MP). По возрастанию.
 */
export const PHOTO_MP_TIERS = [
  "12",
  "24",
  "36",
  "48",
  "60",
  "96",
  "132",
  "168",
  "336",
  "512",
  "768",
  "1152",
  "1600",
] as const;

/**
 * Минимальный MP-тир на фактор — покрывает фикс-цену KIE за фактор
 * (×2 $0.05 = тир «12», ×4 $0.10 = «36», ×8 $0.20 = «96»), чтобы при работе
 * через KIE на мелком фото не взять с юзера меньше нашей KIE-себестоимости.
 */
const PHOTO_MP_FLOOR: Record<string, string> = { "2": "12", "4": "36", "8": "96" };

/** MP-тир для результата (`вход × фактор²`), snap вверх, cap на максимум. */
function photoMpTier(srcMegapixels: number, factor: number): string {
  const outMp = srcMegapixels * factor * factor;
  for (const tier of PHOTO_MP_TIERS) {
    if (outMp <= Number(tier)) return tier;
  }
  return PHOTO_MP_TIERS[PHOTO_MP_TIERS.length - 1];
}

/** Эффективный MP-тир: max(тир результата, KIE-floor для фактора). */
export function photoEffectiveMpTier(srcMegapixels: number, factor: string): string {
  const outTier = photoMpTier(srcMegapixels, Number(factor));
  const floorTier = PHOTO_MP_FLOOR[factor] ?? PHOTO_MP_TIERS[0];
  const idx = (t: string): number => PHOTO_MP_TIERS.indexOf(t as (typeof PHOTO_MP_TIERS)[number]);
  return idx(outTier) >= idx(floorTier) ? outTier : floorTier;
}
