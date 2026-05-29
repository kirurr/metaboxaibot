import { describe, test, expect } from "vitest";
import { stripLeadingEmoji } from "@metabox/shared-browser";

describe("stripLeadingEmoji", () => {
  test("срезает простой эмодзи-префикс", () => {
    expect(stripLeadingEmoji("💬 GPT 5.5")).toBe("GPT 5.5");
    expect(stripLeadingEmoji("🎥 Kling 3.0")).toBe("Kling 3.0");
  });

  test("срезает эмодзи с variation selector (U+FE0F)", () => {
    expect(stripLeadingEmoji("✂️ Удаление фона")).toBe("Удаление фона");
    expect(stripLeadingEmoji("🎞️ Оживить фото")).toBe("Оживить фото");
  });

  test("срезает эмодзи в именах семейств моделей", () => {
    expect(stripLeadingEmoji("⚡ FLUX")).toBe("FLUX");
    expect(stripLeadingEmoji("🍌 Nano Banana")).toBe("Nano Banana");
  });

  test("строку без эмодзи не меняет", () => {
    expect(stripLeadingEmoji("Suno (apipass fallback)")).toBe("Suno (apipass fallback)");
    expect(stripLeadingEmoji("GPT 5.5")).toBe("GPT 5.5");
  });

  test("обрезает лишние пробелы по краям", () => {
    expect(stripLeadingEmoji("  💎 Gemini 3 Pro  ")).toBe("Gemini 3 Pro");
  });
});
