import type { VideoShot } from "../types/ai.js";

/**
 * Kling 3.0 multi-shot limits (см. docs/schema/kie/kling3.md + актуальные доки
 * kie). Держим в одном месте, чтобы фронт-валидация, cost-preview и адаптер
 * согласованно применяли границы.
 *
 * - до 5 шотов в `multi_prompt`;
 * - длительность каждого шота — целое 1–12 секунд;
 * - суммарная длительность видео (top-level `duration`) — целое 3–15 секунд;
 * - промпт шота ≤ 500 символов (каждый `@elementN` занимает ~37 символов).
 */
export const MULTISHOT_MAX_SHOTS = 5;
export const MULTISHOT_SHOT_DURATION_MIN = 1;
export const MULTISHOT_SHOT_DURATION_MAX = 12;
export const MULTISHOT_TOTAL_DURATION_MIN = 3;
export const MULTISHOT_TOTAL_DURATION_MAX = 15;
export const MULTISHOT_PROMPT_MAX_LENGTH = 500;

/** Narrow an `unknown` modelSettings value into a list of valid shots. */
export function parseVideoShots(value: unknown): VideoShot[] {
  if (!Array.isArray(value)) return [];
  const out: VideoShot[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { prompt, duration } = item as { prompt?: unknown; duration?: unknown };
    if (typeof prompt !== "string" || typeof duration !== "number") continue;
    out.push({ prompt, duration });
  }
  return out;
}

/** Sum of shot durations, clamped to the total-duration window. */
export function sumShotDuration(shots: VideoShot[]): number {
  const total = shots.reduce((acc, s) => acc + (Number.isFinite(s.duration) ? s.duration : 0), 0);
  return Math.min(MULTISHOT_TOTAL_DURATION_MAX, Math.max(MULTISHOT_TOTAL_DURATION_MIN, total));
}
