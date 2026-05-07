/**
 * One-shot fields that leak into `modelSettings` today (HeyGen / D-ID video)
 * but logically belong to a single generation, not the user's per-model
 * configuration. Kept in a single place so every producer / consumer strips
 * them consistently:
 *
 * - `generation.service.ts` drops them before snapshotting `modelSettings`
 *   into `GenerationJob.inputData.modelSettings` (no leak into history).
 * - The gallery modal hides them from the settings list and skips them when
 *   the user taps "Apply settings".
 */
export const ONE_SHOT_SETTING_KEYS: ReadonlySet<string> = new Set(["talking_photo_id"]);
