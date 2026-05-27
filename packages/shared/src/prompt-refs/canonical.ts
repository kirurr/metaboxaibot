/**
 * Canonical @-reference syntax for video generation prompts.
 *
 * User-facing canonical forms:
 *   @Element1..@ElementN  — references kling_elements / ref_element_N slots
 *   @Image1..@ImageN      — references ref_images slot entries
 *   @Video                — references a single uploaded reference video
 *
 * Adapters translate from canonical to their provider-specific format.
 * Users always write the canonical form; the bot normalises case variants silently.
 */

/** Extracts @word tokens that are NOT preceded by a word character (avoids email addresses). */
export const AT_TOKEN_RE = /(?<!\w)@([A-Za-z_]\w*)/g;

// ── Provider-specific output patterns (used by translators) ──────────────────

/**
 * Matches @ElementN в любом регистре (`@Element3`, `@element3`, `@ELEMENT3`,
 * `@eLeMeNt3` …) для трансляции. `/i`-флаг ловит весь спектр case-вариантов,
 * не только первую букву — без него юзер с CapsLock или typo проходит мимо
 * валидатора, потом ловит generic 422 от провайдера.
 */
export const ELEMENT_CI_RE = /(?<!\w)@element(\d+)/gi;
/** Matches @ImageN в любом регистре для трансляции. См. ELEMENT_CI_RE. */
export const IMAGE_CI_RE = /(?<!\w)@image(\d+)/gi;
/** Matches @Video в любом регистре (без trailing числа). См. ELEMENT_CI_RE. */
export const VIDEO_CI_RE = /(?<!\w)@video\b(?!\d)/gi;

// ── Capabilities type (embedded in AIModel.promptRefs) ───────────────────────

/**
 * Declares what kinds of @-references a model supports in its prompt.
 * Used by the pre-flight validator to catch bad references before API submission.
 */
export interface PromptRefCapabilities {
  /** @Element1..@ElementN refs → ref_element_N media slots. */
  elements?: { max: number };
  /** @Image1..@ImageN refs → ref_images media slot array. */
  images?: { max: number };
  /** @Video ref → motion_video or ref_videos slot. */
  video?: boolean;
}
