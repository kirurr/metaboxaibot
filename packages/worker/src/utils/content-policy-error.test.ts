import { describe, it, expect } from "vitest";
import { UserFacingError } from "@metabox/shared";
import { isChildSafetyError, isContentPolicyError } from "./content-policy-error.js";

describe("isChildSafetyError", () => {
  it("detects HeyGen child-safety code 402007", () => {
    expect(isChildSafetyError({ code: 402007, message: "moderation failed" })).toBe(true);
  });

  it("detects child-safety markers in message", () => {
    for (const m of [
      "request involves a minor",
      "CSAM detected",
      "child sexual abuse material",
      "underage subject",
      "depiction of a kid",
      "image of a toddler",
      "pedophilia",
    ]) {
      expect(isChildSafetyError(new Error(m))).toBe(true);
    }
  });

  it("detects child-safety marker hidden in the cause chain", () => {
    const err = new UserFacingError("KIE generation failed: 430 blocked", {
      key: "contentPolicyViolation",
      cause: "I can't generate a real child from the provided photos",
    });
    expect(isChildSafetyError(err)).toBe(true);
  });

  it("returns false for non-child moderation", () => {
    expect(isChildSafetyError(new Error("prompt rejected: nudity / sexual content"))).toBe(false);
    expect(isChildSafetyError({ code: 400168, message: "inappropriate content" })).toBe(false);
    expect(isChildSafetyError(new Error("public figure depiction not allowed"))).toBe(false);
  });
});

describe("isContentPolicyError", () => {
  it("true for generic content-policy / public-figure / copyright", () => {
    expect(isContentPolicyError(new UserFacingError("x", { key: "contentPolicyViolation" }))).toBe(
      true,
    );
    expect(isContentPolicyError(new UserFacingError("x", { key: "publicFigureViolation" }))).toBe(
      true,
    );
    expect(isContentPolicyError(new UserFacingError("x", { key: "copyrightViolation" }))).toBe(
      true,
    );
  });

  it("FALSE for child-safety even when it's a content-policy error (carve-out wins)", () => {
    const err = new UserFacingError("blocked", {
      key: "contentPolicyViolation",
      cause: "real child in uploaded photo",
    });
    expect(isContentPolicyError(err)).toBe(false);
  });

  it("FALSE for HeyGen child-safety code (402007)", () => {
    expect(isContentPolicyError({ code: 402007, message: "child safety moderation failed" })).toBe(
      false,
    );
  });

  it("false for non-moderation errors", () => {
    expect(isContentPolicyError(new Error("some unrelated provider failure"))).toBe(false);
    expect(isContentPolicyError(new UserFacingError("too long", { key: "promptTooLong" }))).toBe(
      false,
    );
  });
});
