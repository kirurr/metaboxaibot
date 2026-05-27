/**
 * Лимиты и хелперы мультишота (Kling). Web не зависит от `@metabox/shared`
 * (там node-зависимости), поэтому значения зеркалят
 * `packages/shared/src/constants/multishot.ts` — держим их в синхроне руками,
 * как и `elementMentions.ts` зеркалит `AT_TOKEN_RE` из shared.
 */

export type ShotEntry = { prompt: string; duration: number };

export const MULTISHOT_MAX_SHOTS = 5;
export const MULTISHOT_SHOT_DURATION_MIN = 1;
export const MULTISHOT_SHOT_DURATION_MAX = 12;
export const MULTISHOT_TOTAL_DURATION_MIN = 3;
export const MULTISHOT_TOTAL_DURATION_MAX = 15;
export const MULTISHOT_PROMPT_MAX_LENGTH = 500;

/** Narrow an unknown setting value into a list of valid shots. */
export function parseShots(value: unknown): ShotEntry[] {
  if (!Array.isArray(value)) return [];
  const out: ShotEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { prompt, duration } = item as { prompt?: unknown; duration?: unknown };
    if (typeof prompt !== "string" || typeof duration !== "number") continue;
    out.push({ prompt, duration });
  }
  return out;
}

export function sumShotDuration(shots: ShotEntry[]): number {
  return shots.reduce((acc, s) => acc + (Number.isFinite(s.duration) ? s.duration : 0), 0);
}

/** Причина, по которой список шотов невалиден (ключ i18n), либо null если ок. */
export function multishotBlocker(shots: ShotEntry[]): string | null {
  if (shots.length === 0) return "generate.multishot.errEmpty";
  if (shots.length > MULTISHOT_MAX_SHOTS) return "generate.multishot.errTooMany";
  if (shots.some((s) => s.prompt.trim().length === 0)) return "generate.multishot.errEmptyPrompt";
  const total = sumShotDuration(shots);
  if (total < MULTISHOT_TOTAL_DURATION_MIN || total > MULTISHOT_TOTAL_DURATION_MAX) {
    return "generate.multishot.errTotal";
  }
  return null;
}
