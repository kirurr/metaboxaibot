import { describe, it, expect } from "vitest";
import { computeSeedance2BillableUsd, SEEDANCE2_RATES_WITH_VIDEO } from "./seedance2-billing.js";

describe("computeSeedance2BillableUsd", () => {
  it("returns null когда нет input videos (no-video кейс — caller должен идти через calculateCost)", () => {
    const usd = computeSeedance2BillableUsd({
      modelId: "seedance-2",
      resolution: "720p",
      outputDuration: 5,
      inputVideoDurations: [],
    });
    expect(usd).toBeNull();
  });

  it("returns null для неизвестного разрешения (e.g. fast + 1080p — отсутствует в матрице)", () => {
    const usd = computeSeedance2BillableUsd({
      modelId: "seedance-2-fast",
      resolution: "1080p",
      outputDuration: 5,
      inputVideoDurations: [3],
    });
    expect(usd).toBeNull();
  });

  it("returns null для неизвестной модели — defensively", () => {
    const usd = computeSeedance2BillableUsd({
      modelId: "seedance-99" as "seedance-2",
      resolution: "720p",
      outputDuration: 5,
      inputVideoDurations: [3],
    });
    expect(usd).toBeNull();
  });

  it("billable_input = max(total_input, output): когда input короче output", () => {
    // output = 5s, input = 2s → billable_input = 5 (output wins)
    // total_sec = 5 + 5 = 10. rate(720p, seedance-2) = 0.121
    const usd = computeSeedance2BillableUsd({
      modelId: "seedance-2",
      resolution: "720p",
      outputDuration: 5,
      inputVideoDurations: [2],
    });
    expect(usd).toBeCloseTo(0.121 * 10, 6);
  });

  it("billable_input = max(total_input, output): когда input длиннее output", () => {
    // output = 4s, inputs = [3, 5] → total=8, billable_input = 8
    // total_sec = 4 + 8 = 12. rate(480p, seedance-2) = 0.056
    const usd = computeSeedance2BillableUsd({
      modelId: "seedance-2",
      resolution: "480p",
      outputDuration: 4,
      inputVideoDurations: [3, 5],
    });
    expect(usd).toBeCloseTo(0.056 * 12, 6);
  });

  it("аккумулирует длительности нескольких ref videos", () => {
    // output = 6s, inputs = [1, 1, 1] → total=3, billable_input = max(3, 6) = 6
    // total_sec = 6 + 6 = 12. rate(1080p, seedance-2) = 0.302
    const usd = computeSeedance2BillableUsd({
      modelId: "seedance-2",
      resolution: "1080p",
      outputDuration: 6,
      inputVideoDurations: [1, 1, 1],
    });
    expect(usd).toBeCloseTo(0.302 * 12, 6);
  });

  it("seedance-2-fast 720p: понижение rate vs обычной seedance-2", () => {
    // fast 720p = 0.096, обычная seedance-2 720p = 0.121 → fast дешевле
    const fastRate = SEEDANCE2_RATES_WITH_VIDEO["seedance-2-fast"]!["720p"];
    const regularRate = SEEDANCE2_RATES_WITH_VIDEO["seedance-2"]!["720p"];
    expect(fastRate).toBeLessThan(regularRate);

    const usd = computeSeedance2BillableUsd({
      modelId: "seedance-2-fast",
      resolution: "720p",
      outputDuration: 5,
      inputVideoDurations: [4],
    });
    // billable_input = max(4, 5) = 5; total_sec = 5 + 5 = 10
    expect(usd).toBeCloseTo(0.096 * 10, 6);
  });
});
