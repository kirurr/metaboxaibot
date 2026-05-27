import type { VideoValidationError } from "../ai/video/base.adapter.js";
import { AT_TOKEN_RE } from "@metabox/shared";
import type { PromptRefCapabilities } from "@metabox/shared";

export type { PromptRefCapabilities };

interface ParsedToken {
  raw: string;
  kind: "element" | "image" | "video" | "word_element" | "indexed_video" | "unknown";
  index?: number;
}

function parseAtToken(raw: string): ParsedToken {
  const name = raw.slice(1); // strip leading @

  if (/^element_\w+$/i.test(name)) {
    return { raw, kind: "word_element" };
  }

  const elemMatch = name.match(/^element(\d+)$/i);
  if (elemMatch) return { raw, kind: "element", index: Number(elemMatch[1]) };

  const imgMatch = name.match(/^image(\d+)$/i);
  if (imgMatch) return { raw, kind: "image", index: Number(imgMatch[1]) };

  if (/^video\d+$/i.test(name)) return { raw, kind: "indexed_video" };

  if (/^video$/i.test(name)) return { raw, kind: "video" };

  return { raw, kind: "unknown" };
}

export interface ValidatePromptRefsParams {
  prompt: string;
  mediaInputs: Record<string, string[]>;
  capabilities: PromptRefCapabilities | undefined;
}

/**
 * Validates @-references in a video prompt before submission.
 *
 * Case variants (@element1, @IMAGE2) are treated as correct canonical refs —
 * the translator normalises them silently. Errors are only raised for
 * structurally wrong tokens: word names (@element_dog), indexed @Video,
 * out-of-range indices, missing media slots, or refs on a model that does
 * not support them at all.
 *
 * Returns the first encountered error, or null when the prompt is valid.
 */
export function validatePromptRefs(params: ValidatePromptRefsParams): VideoValidationError | null {
  const { prompt, mediaInputs, capabilities } = params;

  const tokens: string[] = [];
  const re = new RegExp(AT_TOKEN_RE.source, AT_TOKEN_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    tokens.push(m[0]);
  }

  if (tokens.length === 0) return null;

  // Models without promptRefs don't use @-refs — skip all validation.
  if (!capabilities) return null;

  for (const raw of tokens) {
    const parsed = parseAtToken(raw);

    if (parsed.kind === "word_element") {
      const max = capabilities.elements?.max ?? 1;
      return {
        key: "promptRefElementWordName",
        params: { raw, max },
      };
    }

    if (parsed.kind === "indexed_video") {
      if (capabilities.elements && !capabilities.video) return { key: "promptRefVideoUseElements" };
      return { key: "promptRefVideoIndexed", params: { raw } };
    }

    if (parsed.kind === "unknown") {
      if (!capabilities.elements && !capabilities.images && !capabilities.video) {
        return { key: "promptRefUnsupportedByModel", params: { raw } };
      }
      const parts: string[] = [];
      if (capabilities.elements?.max) parts.push(`@Element1..@Element${capabilities.elements.max}`);
      if (capabilities.images?.max) parts.push(`@Image1..@Image${capabilities.images.max}`);
      if (capabilities.video) parts.push("@Video");
      return { key: "promptRefUnknownToken", params: { raw, available: parts.join(", ") } };
    }

    if (parsed.kind === "element") {
      if (!capabilities?.elements) {
        return { key: "promptRefUnsupportedByModel", params: { raw } };
      }
      const n = parsed.index!;
      if (n < 1 || n > capabilities.elements.max) {
        return { key: "promptRefElementOutOfRange", params: { n, max: capabilities.elements.max } };
      }
      const slotKey = `ref_element_${n}`;
      if (!mediaInputs[slotKey]?.length) {
        return { key: "promptRefElementMissing", params: { n } };
      }
    }

    if (parsed.kind === "image") {
      if (!capabilities?.images) {
        return { key: "promptRefUnsupportedByModel", params: { raw } };
      }
      const n = parsed.index!;
      if (n < 1 || n > capabilities.images.max) {
        return { key: "promptRefImageOutOfRange", params: { n, max: capabilities.images.max } };
      }
      const images = mediaInputs["ref_images"] ?? [];
      if (n > images.length) {
        return { key: "promptRefImageMissing", params: { n } };
      }
    }

    if (parsed.kind === "video") {
      if (!capabilities?.video) {
        if (capabilities?.elements) return { key: "promptRefVideoUseElements" };
        return { key: "promptRefUnsupportedByModel", params: { raw } };
      }
      const hasVideo =
        (mediaInputs["motion_video"]?.length ?? 0) > 0 ||
        (mediaInputs["ref_videos"]?.length ?? 0) > 0;
      if (!hasVideo) {
        return { key: "promptRefVideoMissing" };
      }
    }
  }

  return null;
}
