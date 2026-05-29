import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  class FakeDelayed extends Error {}
  return {
    FakeDelayed,
    mockFindUnique: vi.fn(),
    mockUpdate: vi.fn(),
    mockDelayJob: vi.fn(() => {
      throw new h.FakeDelayed("delayed");
    }),
    mockNotifyFallback: vi.fn(),
    mockGetFallbackCandidates: vi.fn(() => [] as Array<{ provider: string }>),
    mockIsFallbackCompatible: vi.fn(() => true),
  };
});

vi.mock("@metabox/api/db", () => ({
  db: { generationJob: { findUnique: h.mockFindUnique, update: h.mockUpdate } },
}));
vi.mock("./delay-job.js", () => ({ delayJob: h.mockDelayJob }));
vi.mock("./notify-error.js", () => ({ notifyFallback: h.mockNotifyFallback }));
vi.mock("@metabox/shared", () => ({
  getFallbackCandidates: h.mockGetFallbackCandidates,
  isFallbackCompatible: h.mockIsFallbackCompatible,
}));

import { handleContentPolicyRetryFallback } from "./content-policy-retry.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const job = { data: { foo: "bar", stage: "poll" } } as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const modelMeta = { provider: "kie" } as any;

function call(): Promise<void> {
  return handleContentPolicyRetryFallback({
    job,
    dbJobId: "job-1",
    modelId: "gpt-image-2",
    modelMeta,
    fallbackSection: "design",
    notifySection: "image",
  });
}

function lastWrite(): Record<string, unknown> {
  const data = h.mockUpdate.mock.calls.at(-1)?.[0]?.data as Record<string, unknown>;
  return data.inputData as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.mockDelayJob.mockImplementation(() => {
    throw new h.FakeDelayed("delayed");
  });
  h.mockGetFallbackCandidates.mockReturnValue([]);
  h.mockIsFallbackCompatible.mockReturnValue(true);
});

describe("handleContentPolicyRetryFallback", () => {
  it("same-provider retry: removes currentEff from attemptedProviders so submit re-picks it", async () => {
    h.mockFindUnique.mockResolvedValue({
      inputData: { fallback: { effectiveProvider: "kie", attemptedProviders: ["kie"] } },
    });

    await expect(call()).rejects.toBeInstanceOf(h.FakeDelayed);

    const written = lastWrite();
    // currentEff (kie) removed → submit's skipProviders won't skip it → real retry on kie.
    expect((written.fallback as { attemptedProviders: string[] }).attemptedProviders).toEqual([]);
    expect((written.contentPolicy as { retries: Record<string, number> }).retries).toEqual({
      kie: 1,
    });
    const updateData = h.mockUpdate.mock.calls.at(-1)?.[0]?.data as Record<string, unknown>;
    expect(updateData.providerJobId).toBeNull();
    expect(updateData.providerKeyId).toBeNull();
    expect(h.mockDelayJob).toHaveBeenCalledTimes(1);
  });

  it("no-fallback model with retry used up: terminal (no delayJob, no re-enqueue, no crash)", async () => {
    h.mockFindUnique.mockResolvedValue({
      inputData: {
        fallback: { effectiveProvider: "kie", attemptedProviders: ["kie"] },
        contentPolicy: { retries: { kie: 1 } },
      },
    });

    await expect(call()).resolves.toBeUndefined();

    expect(h.mockDelayJob).not.toHaveBeenCalled();
    expect(h.mockUpdate).not.toHaveBeenCalled();
    expect(h.mockNotifyFallback).not.toHaveBeenCalled();
  });

  it("retry used up + fallback available: switches provider and notifies", async () => {
    h.mockGetFallbackCandidates.mockReturnValue([{ provider: "evolink" }]);
    h.mockFindUnique.mockResolvedValue({
      inputData: {
        fallback: { effectiveProvider: "kie", attemptedProviders: ["kie"] },
        contentPolicy: { retries: { kie: 1 } },
      },
    });

    await expect(call()).rejects.toBeInstanceOf(h.FakeDelayed);

    const written = lastWrite();
    expect((written.fallback as { attemptedProviders: string[] }).attemptedProviders).toEqual([
      "kie",
    ]);
    expect(h.mockNotifyFallback).toHaveBeenCalledTimes(1);
    expect(h.mockDelayJob).toHaveBeenCalledTimes(1);
  });

  it("circuit breaker: stops re-enqueueing past the bound (terminal)", async () => {
    // No fallbacks → maxReenqueues = (0+1)*(1+1) = 2. totalReenqueues already at 2.
    h.mockFindUnique.mockResolvedValue({
      inputData: {
        fallback: { effectiveProvider: "kie", attemptedProviders: ["kie"] },
        contentPolicy: { retries: {}, totalReenqueues: 2 },
      },
    });

    await expect(call()).resolves.toBeUndefined();

    expect(h.mockDelayJob).not.toHaveBeenCalled();
    expect(h.mockUpdate).not.toHaveBeenCalled();
  });
});
