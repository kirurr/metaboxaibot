/**
 * Integration tests for /web/generation/* in packages/api/src/routes/web-generation.ts.
 *
 * Покрывает 5 эндпоинтов:
 *  - GET  /web/generations          — список истории (sections, modelIds csv, limit)
 *  - POST /web/generation/image     — submit image, 400 unknown model, 402 insufficient
 *  - POST /web/generation/video     — submit video
 *  - POST /web/generation/audio     — submit audio
 *  - POST /web/generation/preview   — preview cost для design / video / audio
 *
 * Стратегия моков: 4 generation/preview сервиса — `generation.service`,
 * `video-generation.service`, `audio-generation.service`, `cost-preview.service`.
 * Мокаем на module-level через `vi.mock`. Это позволяет тестировать роутинг
 * и error-маппинг без зависимости от реальных провайдеров.
 *
 * `getFileUrl` мокаем как identity, чтобы `resolveMediaInputs` не падал на
 * unconfigured S3 — он зовётся даже когда mediaInputs пуст.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type * as S3ServiceModule from "../src/services/s3.service.js";
import type * as GenerationServiceModule from "../src/services/generation.service.js";
import type * as VideoGenerationServiceModule from "../src/services/video-generation.service.js";
import type * as AudioGenerationServiceModule from "../src/services/audio-generation.service.js";
import type * as CostPreviewServiceModule from "../src/services/cost-preview.service.js";

vi.mock("../src/services/s3.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof S3ServiceModule>();
  return {
    ...actual,
    getFileUrl: vi.fn(async (key: string): Promise<string | null> => `https://s3.test/${key}`),
  };
});

vi.mock("../src/services/generation.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GenerationServiceModule>();
  return {
    ...actual,
    generationService: {
      ...actual.generationService,
      submitImage: vi.fn(async () => ({ dbJobId: "job-img-1" })),
    },
  };
});

vi.mock("../src/services/video-generation.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof VideoGenerationServiceModule>();
  return {
    ...actual,
    videoGenerationService: {
      ...actual.videoGenerationService,
      validateVideoRequest: vi.fn(() => null),
      submitVideo: vi.fn(async () => ({ dbJobId: "job-vid-1" })),
    },
  };
});

vi.mock("../src/services/audio-generation.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AudioGenerationServiceModule>();
  return {
    ...actual,
    audioGenerationService: {
      ...actual.audioGenerationService,
      submitAudio: vi.fn(async () => ({ dbJobId: "job-aud-1" })),
    },
  };
});

vi.mock("../src/services/cost-preview.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CostPreviewServiceModule>();
  return {
    ...actual,
    costPreviewService: {
      ...actual.costPreviewService,
      previewImage: vi.fn(async () => ({ cost: 5, numImages: 1 })),
      previewVideo: vi.fn(async () => ({
        cost: 12,
        pricingMode: "per_second" as const,
        effectiveDuration: 5,
      })),
      previewAudio: vi.fn(async () => ({ cost: 3 })),
    },
  };
});

import { buildTestApp } from "./helpers/build-app.js";
import { db } from "./helpers/db.js";
import { bearer, createTestUser } from "./fixtures/users.js";
import { generationService } from "../src/services/generation.service.js";
import { videoGenerationService } from "../src/services/video-generation.service.js";
import { audioGenerationService } from "../src/services/audio-generation.service.js";

const IMAGE_MODEL = "flux"; // section: "design"
const VIDEO_MODEL = "kling"; // section: "video"
const AUDIO_MODEL = "suno"; // section: "audio"

describe("/web/generation/* routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.mocked(generationService.submitImage).mockClear();
    vi.mocked(videoGenerationService.submitVideo).mockClear();
    vi.mocked(audioGenerationService.submitAudio).mockClear();
    vi.mocked(videoGenerationService.validateVideoRequest).mockClear();
    vi.mocked(videoGenerationService.validateVideoRequest).mockReturnValue(null);
  });

  // ── GET /web/generations ────────────────────────────────────────────────
  describe("GET /web/generations", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/web/generations" });
      expect(res.statusCode).toBe(401);
    });

    it("returns an empty items array for a fresh user", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "GET",
        url: "/web/generations",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [] });
    });

    it("filters by section (design → matches image jobs)", async () => {
      const { user, accessToken } = await createTestUser();
      await db.generationJob.create({
        data: {
          userId: user.id!,
          dialogId: "test-dialog-gen",
          section: "image",
          modelId: IMAGE_MODEL,
          status: "done",
          prompt: "an image",
          tokensSpent: "10",
        },
      });
      await db.generationJob.create({
        data: {
          userId: user.id!,
          dialogId: "test-dialog-gen",
          section: "video",
          modelId: VIDEO_MODEL,
          status: "done",
          prompt: "a video",
          tokensSpent: "20",
        },
      });
      const res = await app.inject({
        method: "GET",
        url: "/web/generations?section=design",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ section: string; modelId: string }> };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].section).toBe("image");
    });

    it("filters by modelIds csv", async () => {
      const { user, accessToken } = await createTestUser();
      await db.generationJob.create({
        data: {
          userId: user.id!,
          dialogId: "d",
          section: "image",
          modelId: IMAGE_MODEL,
          status: "done",
          prompt: "p1",
        },
      });
      await db.generationJob.create({
        data: {
          userId: user.id!,
          dialogId: "d",
          section: "image",
          modelId: "midjourney",
          status: "done",
          prompt: "p2",
        },
      });
      const res = await app.inject({
        method: "GET",
        url: `/web/generations?modelIds=${IMAGE_MODEL}`,
        headers: bearer(accessToken),
      });
      const body = res.json() as { items: Array<{ modelId: string }> };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].modelId).toBe(IMAGE_MODEL);
    });
  });

  // ── POST /web/generation/image ──────────────────────────────────────────
  describe("POST /web/generation/image", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/image",
        payload: { modelId: IMAGE_MODEL, prompt: "x" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 BAD_REQUEST for unknown modelId", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/image",
        payload: { modelId: "no-such-model", prompt: "x" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "BAD_REQUEST" });
    });

    it("returns 400 when prompt is empty for a non-promptOptional model", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/image",
        payload: { modelId: IMAGE_MODEL, prompt: "   " },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 200 and dbJobId on happy path", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/image",
        payload: { modelId: IMAGE_MODEL, prompt: "a happy unicorn" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ dbJobId: "job-img-1" });
      expect(generationService.submitImage).toHaveBeenCalledTimes(1);
    });

    it("returns 402 INSUFFICIENT_BALANCE when service throws 'insufficient balance'", async () => {
      vi.mocked(generationService.submitImage).mockRejectedValueOnce(
        new Error("Insufficient balance for generation"),
      );
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/image",
        payload: { modelId: IMAGE_MODEL, prompt: "expensive" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    });
  });

  // ── POST /web/generation/video ──────────────────────────────────────────
  describe("POST /web/generation/video", () => {
    it("returns 400 BAD_REQUEST for unknown modelId", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/video",
        payload: { modelId: "no-such-vid", prompt: "x" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when validateVideoRequest reports an adapter-level issue", async () => {
      vi.mocked(videoGenerationService.validateVideoRequest).mockReturnValueOnce({
        key: "veoImageRequired",
        params: {},
      });
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/video",
        payload: { modelId: VIDEO_MODEL, prompt: "test" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "BAD_REQUEST", error: "veoImageRequired" });
    });

    it("returns 200 and dbJobId on happy path", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/video",
        payload: { modelId: VIDEO_MODEL, prompt: "a dancing robot" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ dbJobId: "job-vid-1" });
    });
  });

  // ── POST /web/generation/audio ──────────────────────────────────────────
  describe("POST /web/generation/audio", () => {
    it("returns 400 BAD_REQUEST for unknown modelId", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/audio",
        payload: { modelId: "no-such-aud", prompt: "x" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 200 and dbJobId on happy path", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/audio",
        payload: { modelId: AUDIO_MODEL, prompt: "synth jazz" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ dbJobId: "job-aud-1" });
    });
  });

  // ── POST /web/generation/preview ────────────────────────────────────────
  describe("POST /web/generation/preview", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/preview",
        payload: { modelId: IMAGE_MODEL },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 BAD_REQUEST for unknown modelId", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/preview",
        payload: { modelId: "no-such" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns image preview shape (total + numImages)", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/preview",
        payload: { modelId: IMAGE_MODEL, prompt: "p" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ cost: 5, pricingMode: "total", numImages: 1 });
    });

    it("returns video preview shape (per_second + durationSec)", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/preview",
        payload: { modelId: VIDEO_MODEL, prompt: "p" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ cost: 12, pricingMode: "per_second", durationSec: 5 });
    });

    it("returns audio preview shape (total)", async () => {
      const { accessToken } = await createTestUser();
      const res = await app.inject({
        method: "POST",
        url: "/web/generation/preview",
        payload: { modelId: AUDIO_MODEL, prompt: "p" },
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ cost: 3, pricingMode: "total" });
    });
  });
});
