import type { ImageAdapter, ImageInput, ImageResult } from "./base.adapter.js";
import { config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { uploadFileUrl } from "../../utils/kie-upload.js";
import { classifyAIError } from "../../services/ai-error-classifier.service.js";

const KIE_BASE = "https://api.kie.ai";

interface KieSubmitResponse {
  code: number;
  msg: string;
  data?: { taskId?: string };
}

interface KieTaskResponse {
  code: number;
  msg: string;
  data?: {
    taskId: string;
    model: string;
    state: "waiting" | "queuing" | "generating" | "success" | "fail";
    resultJson?: string;
    failCode?: string;
    failMsg?: string;
  };
}

/** Grok Imagine: separate t2i / i2i endpoints. */
const GROK_T2I = "grok-imagine/text-to-image";
const GROK_I2I = "grok-imagine/image-to-image";

/**
 * Распознанные форматы изображений. Используем extension из URL'а провайдера,
 * чтобы корректно сохранить файл как `.png` (когда юзер выбрал PNG в настройках,
 * а не дефолтный `.jpg`). По дефолту падаем на jpg — большинство провайдеров
 * без явного output_format отдают именно его.
 */
const KNOWN_IMAGE_EXTS: ReadonlyArray<string> = ["png", "jpg", "jpeg", "webp", "gif", "svg"];
const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};
function parseImageMime(url: string): { ext: string; contentType: string } {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-zA-Z0-9]+)$/);
    if (m) {
      const ext = m[1].toLowerCase();
      if (KNOWN_IMAGE_EXTS.includes(ext)) {
        return { ext: ext === "jpeg" ? "jpg" : ext, contentType: EXT_TO_CONTENT_TYPE[ext] };
      }
    }
  } catch {
    // not a parseable URL — fallthrough
  }
  return { ext: "jpg", contentType: "image/jpeg" };
}

/**
 * Nano Banana family: single endpoint per model that accepts optional
 * `image_input` array for i2i. The `nano-banana-edit` variant requires
 * images, but we expose pro/2 which gracefully handle both modes.
 */
const NANO_BANANA_MODEL_NAMES: Record<string, string> = {
  "nano-banana-pro": "nano-banana-pro",
  "nano-banana-2": "nano-banana-2",
};

/**
 * KIE adapter for image generation.
 *
 * Endpoints:
 *  - POST /api/v1/jobs/createTask   — submit generation task
 *  - GET  /api/v1/jobs/recordInfo?taskId=X — poll task status
 *
 * Supports:
 *  - Grok Imagine (t2i / i2i)
 *  - Nano Banana Pro / Nano Banana 2 (t2i + optional i2i via image_input)
 *
 * Input images are re-uploaded through KIE's file upload API to ensure
 * KIE can fetch them (presigned S3/Telegram URLs may be blocked or expire).
 */
export class KieImageAdapter implements ImageAdapter {
  readonly isAsync = true;

  private readonly apiKeyOverride: string | undefined;
  private readonly fetchFn: typeof globalThis.fetch | undefined;

  constructor(
    readonly modelId: string,
    apiKey?: string,
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.apiKeyOverride = apiKey;
    this.fetchFn = fetchFn;
  }

  private get apiKey(): string {
    const key = this.apiKeyOverride ?? config.ai.kie;
    if (!key) throw new Error("KIE_API_KEY not configured");
    return key;
  }

  private get jsonHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async submit(input: ImageInput): Promise<string> {
    const ms = input.modelSettings ?? {};
    const mi = input.mediaInputs ?? {};
    const editImages = mi.edit ?? [];
    const imageUrls = editImages.length > 0 ? editImages : input.imageUrl ? [input.imageUrl] : [];

    const nanoBananaModel = NANO_BANANA_MODEL_NAMES[this.modelId];

    let body: { model: string; input: Record<string, unknown> };

    if (this.modelId === "nano-banana-1") {
      // ── Google Nano Banana v1: t2i / i2i via separate endpoints ────────────
      const isI2I = imageUrls.length > 0;
      const inputPayload: Record<string, unknown> = {
        prompt: input.prompt,
      };

      const imageSize = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio ?? "1:1";
      inputPayload.image_size = imageSize;

      const rawFormat = (ms.output_format as string | undefined) ?? "png";
      inputPayload.output_format = rawFormat === "jpg" ? "jpeg" : rawFormat;

      if (isI2I) {
        const uploaded = await Promise.all(
          imageUrls.slice(0, 10).map((url) => uploadFileUrl(this.apiKey, url)),
        );
        inputPayload.image_urls = uploaded;
      }

      body = {
        model: isI2I ? "google/nano-banana-edit" : "google/nano-banana",
        input: inputPayload,
      };
    } else if (nanoBananaModel) {
      // ── Nano Banana Pro / Nano Banana 2 ────────────────────────────────────
      const inputPayload: Record<string, unknown> = {
        prompt: input.prompt,
      };

      const aspectRatio = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio ?? "1:1";
      inputPayload.aspect_ratio = aspectRatio;

      const resolution = (ms.resolution as string | undefined) ?? "1K";
      inputPayload.resolution = resolution;

      // KIE accepts only png/jpg; map jpeg → jpg for compatibility with shared settings.
      const rawFormat = (ms.output_format as string | undefined) ?? "png";
      const outputFormat = rawFormat === "jpeg" ? "jpg" : rawFormat;
      inputPayload.output_format = outputFormat;

      if (imageUrls.length > 0) {
        const maxImages = this.modelId === "nano-banana-2" ? 14 : 8;
        const uploaded = await Promise.all(
          imageUrls.slice(0, maxImages).map((url) => uploadFileUrl(this.apiKey, url)),
        );
        inputPayload.image_input = uploaded;
      }

      body = { model: nanoBananaModel, input: inputPayload };
    } else if (this.modelId === "gpt-image-2") {
      // ── GPT Image 2 via KIE: t2i / i2i via separate endpoints ──────────────
      // Временно проксируем gpt-image-2 через KIE, чтобы не зависеть от прямого
      // OpenAI Images API. Реализация на OpenAI сохранена закомментированной в
      // packages/shared/.../design.models.ts — для отката достаточно вернуть
      // provider:"openai" и снять комменты.
      const isI2I = imageUrls.length > 0;
      const aspectRatio = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio ?? "auto";
      // KIE-схема: aspect_ratio "auto" поддерживает только 1K; aspect_ratio "1:1"
      // не поддерживает 4K. Несовместимые комбинации createTask отклонит — НЕ
      // даунгрейдим client-side, иначе списали бы за выбранное разрешение, а
      // получили бы более низкое (overcharge без feedback'а).
      const resolution = (ms.resolution as string | undefined) ?? "1K";
      const inputPayload: Record<string, unknown> = {
        prompt: input.prompt,
        nsfw_checker: ms.nsfw_checker !== undefined ? ms.nsfw_checker : false,
        aspect_ratio: aspectRatio,
        resolution,
      };

      if (isI2I) {
        const uploaded = await Promise.all(
          imageUrls.slice(0, 16).map((url) => uploadFileUrl(this.apiKey, url)),
        );
        inputPayload.input_urls = uploaded;
      }

      body = {
        model: isI2I ? "gpt-image-2-image-to-image" : "gpt-image-2-text-to-image",
        input: inputPayload,
      };
    } else if (this.modelId === "grok-imagine-image") {
      // ── Grok Imagine ───────────────────────────────────────────────────────
      const isI2I = imageUrls.length > 0;
      const inputPayload: Record<string, unknown> = {
        prompt: input.prompt,
        nsfw_checker: ms.nsfw_checker !== undefined ? ms.nsfw_checker : false,
      };
      inputPayload.aspect_ratio =
        (ms.aspect_ratio as string | undefined) ?? input.aspectRatio ?? "1:1";
      inputPayload.enable_pro = (ms.enable_pro as boolean | undefined) ?? false;

      if (isI2I) {
        inputPayload.image_urls = await Promise.all(
          imageUrls.map((url) => uploadFileUrl(this.apiKey, url)),
        );
      }

      body = { model: isI2I ? GROK_I2I : GROK_T2I, input: inputPayload };
    } else {
      throw new Error(`KIE image: unknown model ${this.modelId}`);
    }

    const resp = await fetchWithLog(
      `${KIE_BASE}/api/v1/jobs/createTask`,
      {
        method: "POST",
        headers: this.jsonHeaders,
        body: JSON.stringify(body),
      },
      this.fetchFn,
    );

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`KIE image submit error ${resp.status}: ${txt}`);
    }

    const data = (await resp.json()) as KieSubmitResponse;
    if (data.code !== 200 || !data.data?.taskId) {
      throw new Error(`KIE image submit failed: ${data.code} — ${data.msg}`);
    }
    return data.data.taskId;
  }

  async poll(taskId: string): Promise<ImageResult[] | null> {
    const resp = await fetchWithLog(
      `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
      this.fetchFn,
    );

    if (!resp.ok) throw new Error(`KIE image poll error ${resp.status}`);

    const data = (await resp.json()) as KieTaskResponse;
    if (data.code !== 200 || !data.data) {
      throw new Error(`KIE image poll failed: ${data.code} — ${data.msg}`);
    }

    const task = data.data;

    if (task.state === "fail") {
      const failMsg = task.failMsg ?? "unknown error";
      const failCode = task.failCode;
      const technicalMessage = `KIE ${this.modelId} generation failed: ${failCode ?? ""} ${failMsg}`;
      const isCopyright = failCode === "501" || /copyright/i.test(failMsg);
      // KIE/evolink content moderation: "Request blocked: ... prominent public figure"
      // → отдельный мессадж про публичные лица (юзер часто пытается грузить фото
      // знаменитостей или просит их в промпте — copyright-сообщение неточно).
      const isPublicFigure = /public figure|public person|prominent figure|celebrity/i.test(
        failMsg,
      );
      const isPolicy =
        failCode === "430" ||
        failCode === "431" ||
        /sensitive|restrict|policy|prohibited|nsfw|violat|inappropriate|safety|content moderation|blocked/i.test(
          failMsg,
        );
      // Generic "model couldn't generate for this prompt" — Gemini (KIE
      // nano-banana backend) и подобные шлют 500 с message типа
      // "Gemini could not generate an image with the given prompt. Please
      // try again with a different prompt." Это user-facing (юзер должен
      // переформулировать), а НЕ tech 5xx — иначе попало бы в poll-stage
      // KIE-fallback re-submit логику, которая зря сожгла бы fallback
      // attempt и user не понял бы что нужно сделать.
      //
      // Также сюда попадает случай когда gpt-image-2 (KIE) вместо генерации
      // возвращает chat-style ответ ассистента ("Вот несколько вариантов на
      // английском..."). Легитимные upstream-ошибки KIE всегда на английском,
      // поэтому кириллица в failMsg = модель ушла в clarification-режим.
      const hasCyrillic = /[Ѐ-ӿ]/.test(failMsg);
      const isNoResult =
        /could not generate (an? )?(image|video|result)|failed to generate|no image (was )?generated|unable to generate/i.test(
          failMsg,
        ) || hasCyrillic;
      if (isNoResult) {
        throw new UserFacingError(technicalMessage, { key: "generationNoResult" });
      }
      if (isPublicFigure)
        throw new UserFacingError(technicalMessage, { key: "publicFigureViolation" });
      if (isCopyright) throw new UserFacingError(technicalMessage, { key: "copyrightViolation" });
      if (isPolicy) throw new UserFacingError(technicalMessage, { key: "contentPolicyViolation" });

      const classified = await classifyAIError(`${failCode ?? ""} ${failMsg}`.trim());
      if (classified?.shouldShow) {
        throw new UserFacingError(technicalMessage, {
          key: "aiClassifiedError",
          params: { messageRu: classified.messageRu, messageEn: classified.messageEn },
          notifyOps: true,
        });
      }
      throw new Error(technicalMessage);
    }
    if (task.state !== "success") return null;

    if (!task.resultJson) throw new Error("KIE: no resultJson in completed image task");
    const result = JSON.parse(task.resultJson) as { resultUrls?: string[] };
    const urls = result.resultUrls;
    if (!urls?.length) throw new Error("KIE: no image URLs in resultJson");

    return urls.map((url, i) => {
      const { ext, contentType } = parseImageMime(url);
      return {
        url,
        filename: `${this.modelId}-${i}.${ext}`,
        contentType,
      };
    });
  }
}
