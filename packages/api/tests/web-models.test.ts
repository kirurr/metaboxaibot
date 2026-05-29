/**
 * Integration tests for packages/api/src/routes/web-models.ts.
 *
 * Покрывает auth-гард (`webAuthPreHandler` — только 401, web-only юзеры
 * допускаются), фильтр `?section=`, приоритет языка
 * (`?lang=` > `user.language` > `"ru"`), и сериализацию модели в WebModelDto
 * (нормализация claude-прокси → `anthropic`, корректный `tokenCostUnit`,
 * сохранение опциональных полей вроде `supportedDurations`).
 *
 * Маркер для assertions по языку — локализованный label `modelModes.t2v`:
 * "Text → video" в en, "Текст → видео" в ru.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { AI_MODELS, MODELS_BY_SECTION, getT } from "@metabox/shared";
import { WEB_PRESET_MODEL_IDS } from "../src/routes/web-models.js";
import { buildTestApp } from "./helpers/build-app.js";
import { bearer, createTestUser } from "./fixtures/users.js";
import { db } from "./helpers/db.js";

interface WebModelDto {
  id: string;
  name: string;
  webName: string;
  webIconPath: string | null;
  description: string;
  shortDescription: string | null;
  section: string;
  provider: string;
  modes: Array<{ id: string; label: string }> | null;
  mediaInputs: Array<{ slotKey: string; label: string }>;
  tokenCostApprox: number;
  tokenCostUnit: string;
  supportedDurations: unknown[] | null;
}

function findT2vLabel(body: WebModelDto[]): string | undefined {
  const video = body.find((m) => m.section === "video" && m.modes?.some((x) => x.id === "t2v"));
  return video?.modes?.find((x) => x.id === "t2v")?.label;
}

describe("GET /web/models", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Auth ──────────────────────────────────────────────────────────────────
  describe("auth", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/web/models" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Unauthorized" });
    });

    it("returns 200 for a web-only user (no Telegram linked)", async () => {
      // Подтверждает что роут использует webAuthPreHandler, а не telegram-linked гард.
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "GET",
        url: "/web/models",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json())).toBe(true);
    });

    it("returns 200 for a Telegram-linked user", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "GET",
        url: "/web/models",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ── Section filter ────────────────────────────────────────────────────────
  describe("section filter", () => {
    it("returns all non-hidden models without ?section", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "GET",
        url: "/web/models",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as WebModelDto[];
      expect(body.length).toBeGreaterThan(0);
      // Ни одна `hiddenFromCarousel`-модель не должна течь в каталог — КРОМЕ
      // preset-exposed (WEB_PRESET_MODEL_IDS), которые веб активирует через
      // URL-пресеты (/image/upscale, /image/bg-removal и т.п.).
      const leaked = body.filter(
        (m) => AI_MODELS[m.id]?.hiddenFromCarousel === true && !WEB_PRESET_MODEL_IDS.has(m.id),
      );
      expect(leaked).toEqual([]);
    });

    it("exposes preset-only hidden models (WEB_PRESET_MODEL_IDS) with hiddenFromCarousel flag", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "GET",
        url: "/web/models",
        headers: bearer(accessToken),
      });
      const body = res.json() as Array<WebModelDto & { hiddenFromCarousel?: boolean }>;
      // image-upscale помечена hiddenFromCarousel, но отдаётся (preset-exposed) с флагом.
      const upscale = body.find((m) => m.id === "image-upscale");
      expect(upscale).toBeDefined();
      expect(upscale!.hiddenFromCarousel).toBe(true);
    });

    it("filters by ?section=gpt", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "GET",
        url: "/web/models?section=gpt",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as WebModelDto[];
      expect(body.length).toBeGreaterThan(0);
      expect(body.every((m) => m.section === "gpt")).toBe(true);
    });

    it("returns an empty array for an unknown section", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "GET",
        url: "/web/models?section=does-not-exist",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });
  });

  // ── Language priority ─────────────────────────────────────────────────────
  describe("language priority", () => {
    it("?lang=en overrides user.language='ru'", async () => {
      const { user, accessToken } = await createTestUser({ withTelegram: true });
      await db.user.update({ where: { id: user.id! }, data: { language: "ru" } });
      const res = await app.inject({
        method: "GET",
        url: "/web/models?lang=en",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(findT2vLabel(res.json() as WebModelDto[])).toBe("Text → video");
    });

    it("uses user.language from DB when ?lang= is not provided", async () => {
      // createTestUser не выставляет language → Prisma-дефолт "en".
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "GET",
        url: "/web/models",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(findT2vLabel(res.json() as WebModelDto[])).toBe("Text → video");
    });

    it("falls back to 'ru' for a web-only user without ?lang=", async () => {
      // У web-only юзера нет User-row → роут пропускает DB-lookup → fallback 'ru'.
      const { accessToken } = await createTestUser({ withTelegram: false });
      const res = await app.inject({
        method: "GET",
        url: "/web/models",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(findT2vLabel(res.json() as WebModelDto[])).toBe("Текст → видео");
    });

    it("ignores ?lang=fr (unsupported) and falls back to user.language", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      // user.language = "en" (default) → fallback при unsupported lang.
      const res = await app.inject({
        method: "GET",
        url: "/web/models?lang=fr",
        headers: bearer(accessToken),
      });
      expect(res.statusCode).toBe(200);
      expect(findT2vLabel(res.json() as WebModelDto[])).toBe("Text → video");
    });
  });

  // ── Serialization shape ───────────────────────────────────────────────────
  describe("serialization shape", () => {
    it("normalizes claude-proxy provider (kie-claude/evolink-claude) to 'anthropic'", async () => {
      const claudeProxyModel = Object.values(AI_MODELS).find(
        (m) =>
          !m.hiddenFromCarousel && (m.provider === "kie-claude" || m.provider === "evolink-claude"),
      );
      expect(claudeProxyModel).toBeDefined();
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "GET",
        url: "/web/models",
        headers: bearer(accessToken),
      });
      const body = res.json() as WebModelDto[];
      const serialized = body.find((m) => m.id === claudeProxyModel!.id);
      expect(serialized).toBeDefined();
      expect(serialized!.provider).toBe("anthropic");
    });

    it("serializes LLM models with tokenCostUnit='1k_tok' and tokenCostApprox > 0", async () => {
      const llm = (MODELS_BY_SECTION.gpt ?? []).find(
        (m) => !m.hiddenFromCarousel && m.inputCostUsdPerMToken > 0,
      );
      expect(llm).toBeDefined();
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "GET",
        url: "/web/models?section=gpt",
        headers: bearer(accessToken),
      });
      const body = res.json() as WebModelDto[];
      const serialized = body.find((m) => m.id === llm!.id);
      expect(serialized).toBeDefined();
      expect(serialized!.tokenCostUnit).toBe("1k_tok");
      expect(serialized!.tokenCostApprox).toBeGreaterThan(0);
    });

    it("exposes webName (без эмодзи) и webIconPath для каждой модели", async () => {
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "GET",
        url: "/web/models",
        headers: bearer(accessToken),
      });
      const body = res.json() as WebModelDto[];
      expect(body.length).toBeGreaterThan(0);
      for (const m of body) {
        expect(typeof m.webName).toBe("string");
        expect(m.webName.length).toBeGreaterThan(0);
        // webName не должен начинаться с эмодзи (срезается на сервере).
        expect(/^[\p{Extended_Pictographic}]/u.test(m.webName)).toBe(false);
        // webIconPath — либо строковый путь, либо null.
        expect(m.webIconPath === null || typeof m.webIconPath === "string").toBe(true);
      }
    });

    it("localizes description (EN full) and shortDescription via modelDescriptions i18n", async () => {
      // Берём модель, у которой в en-локали есть и full, и short, и без
      // descriptionOverride (чтобы RU-фоллбек был ровно `m.description`).
      const enMd = getT("en").modelDescriptions;
      const modelId = Object.keys(enMd).find(
        (id) =>
          enMd[id]?.full &&
          enMd[id]?.short &&
          AI_MODELS[id] &&
          !AI_MODELS[id]!.hiddenFromCarousel &&
          !AI_MODELS[id]!.descriptionOverride,
      );
      expect(modelId).toBeDefined();

      const { accessToken } = await createTestUser({ withTelegram: true });
      const [enRes, ruRes] = await Promise.all([
        app.inject({ method: "GET", url: "/web/models?lang=en", headers: bearer(accessToken) }),
        app.inject({ method: "GET", url: "/web/models?lang=ru", headers: bearer(accessToken) }),
      ]);
      const enM = (enRes.json() as WebModelDto[]).find((m) => m.id === modelId)!;
      const ruM = (ruRes.json() as WebModelDto[]).find((m) => m.id === modelId)!;
      expect(enM).toBeDefined();
      expect(ruM).toBeDefined();

      // EN: description = full-перевод из i18n, shortDescription = short из i18n.
      expect(enM.description).toBe(enMd[modelId!]!.full);
      expect(enM.shortDescription).toBe(enMd[modelId!]!.short);

      // RU: full в i18n не дублируется → description фоллбекает на константу.
      expect(ruM.description).toBe(AI_MODELS[modelId!]!.description);
      // short локализован отдельно для RU и отличается от EN.
      expect(ruM.shortDescription).toBeTruthy();
      expect(ruM.shortDescription).not.toBe(enM.shortDescription);
    });

    it("falls back to constant description with null shortDescription when no i18n key", async () => {
      // Модель без записи в modelDescriptions (ни в en, ни в ru) — но отдаётся
      // каталогом (не hidden или preset-exposed). Описание = константа, short = null.
      const enMd = getT("en").modelDescriptions;
      const candidate = Object.values(AI_MODELS).find(
        (m) =>
          (!m.hiddenFromCarousel || WEB_PRESET_MODEL_IDS.has(m.id)) &&
          !enMd[m.id]?.full &&
          !enMd[m.id]?.short,
      );
      // Если все отдаваемые модели покрыты i18n — кейс нечего проверять (skip).
      if (!candidate) return;

      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "GET",
        url: "/web/models?lang=en",
        headers: bearer(accessToken),
      });
      const serialized = (res.json() as WebModelDto[]).find((m) => m.id === candidate.id)!;
      expect(serialized).toBeDefined();
      expect(serialized.shortDescription).toBeNull();
      expect(serialized.description).toBe(candidate.descriptionOverride ?? candidate.description);
    });

    it("preserves supportedDurations for a video model", async () => {
      const withDurations = Object.values(AI_MODELS).find(
        (m) =>
          !m.hiddenFromCarousel &&
          Array.isArray(m.supportedDurations) &&
          m.supportedDurations.length > 0,
      );
      expect(withDurations).toBeDefined();
      const { accessToken } = await createTestUser({ withTelegram: true });
      const res = await app.inject({
        method: "GET",
        url: "/web/models",
        headers: bearer(accessToken),
      });
      const body = res.json() as WebModelDto[];
      const serialized = body.find((m) => m.id === withDurations!.id);
      expect(serialized).toBeDefined();
      expect(serialized!.supportedDurations).toEqual(withDurations!.supportedDurations);
    });
  });
});
