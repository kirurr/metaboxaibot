import { describe, it, expect, vi } from "vitest";

vi.mock("./user-state.service.js", () => ({
  userStateService: {
    getModelSettings: vi.fn(async () => ({})),
  },
}));

import { costPreviewService } from "./cost-preview.service.js";

const MODELS = [
  "flux",
  "image-upscale",
  "object-removal",
  "bg-removal",
  "face-swap-classic",
  "clothing-tryon",
  "photo-create",
  "nano-banana-pro",
];

describe("previewImage repro", () => {
  for (const modelId of MODELS) {
    it(`previewImage(${modelId}) returns finite cost`, async () => {
      const res = await costPreviewService.previewImage({
        userId: 1n,
        modelId,
        prompt: "test",
        telegramChatId: null,
      } as never);
      // eslint-disable-next-line no-console
      console.log(modelId, JSON.stringify(res));
      expect(Number.isFinite(res.cost)).toBe(true);
      expect(Number.isFinite(res.numImages)).toBe(true);
    });
  }
});
