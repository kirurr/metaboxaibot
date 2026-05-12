import type { ImageAdapter, ImageInput, ImageResult } from "./base.adapter.js";
import { config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { classifyAIError } from "../../services/ai-error-classifier.service.js";

const EVOLINK_BASE = "https://api.evolink.ai";

/**
 * Маппинг наших внутренних `modelId` на названия моделей evolink.
 * - nano-banana-1   → nano-banana-beta
 * - nano-banana-2   → gemini-3.1-flash-image-preview
 * - nano-banana-pro → gemini-3-pro-image-preview
 * - gpt-image-2     → gpt-image-2 (fallback при недоступности KIE)
 */
const EVOLINK_MODEL_NAMES: Record<string, string> = {
  "nano-banana-1": "nano-banana-beta",
  "nano-banana-2": "gemini-3.1-flash-image-preview",
  "nano-banana-pro": "gemini-3-pro-image-preview",
  "gpt-image-2": "gpt-image-2",
};

/** Максимум референс-изображений за запрос — отличается между моделями. */
const MAX_REF_IMAGES: Record<string, number> = {
  "nano-banana-1": 5,
  "nano-banana-2": 14,
  "nano-banana-pro": 14,
  "gpt-image-2": 16,
};

/**
 * Извлекает реальный image-формат из URL'а провайдера. Provider-hosted URL'ы
 * обычно заканчиваются на `.png`/`.jpg`/`.webp` — берём это, чтобы не сохранять
 * PNG-файл как `.jpg` (юзер потом скачивает «оригинал» с неправильным расш.).
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
    // not a parseable URL
  }
  return { ext: "png", contentType: "image/png" };
}

interface EvolinkSubmitResponse {
  id?: string;
  status?: string;
  // ErrorResponse при не-2xx
  error?: { code?: string; message?: string; type?: string };
}

interface EvolinkTaskResponse {
  id?: string;
  status?: "pending" | "processing" | "completed" | "failed";
  progress?: number;
  results?: string[];
  error?: { code?: string; message?: string; type?: string };
}

/** Per Evolink docs for Gemini-3 family — prompt token limit (treat as char limit). */
const NANO_BANANA_PROMPT_MAX_CHARS = 2000;
/** Per Evolink errors.md — invalid_parameters "file size exceeds 10MB". */
const NANO_BANANA_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
/** Per nanobanana{2,pro}.md image_urls notes — JPG/PNG/WebP supported (+ GIF tolerated). */
const NANO_BANANA_SUPPORTED_FORMATS = "JPG, PNG, WebP";
const NANO_BANANA_UNSUPPORTED_CT_RE = /^image\/(heic|heif|avif|tiff?)$/i;
const NANO_BANANA_UNSUPPORTED_EXT_RE = /\.(heic|heif|avif|tiff?)(?:[?#]|$)/i;

/**
 * Pre-flight для nano-banana семейства через Evolink. Отсекает 3 из 4 sub-типов
 * invalid_parameters до сабмита (per docs/schema/evolink/errors.md):
 *  - prompt too long (>2000 chars) — string check, без сети
 *  - unsupported file type (HEIC/AVIF/TIFF) — по Content-Type и URL extension
 *  - file size exceeds 10MB — по Content-Length
 *
 * Dimensions (240..7680 px) НЕ проверяем — sharp-probe требует full download
 * каждого ref'а (до 14 шт. × до 10 МБ = 140 МБ трафика на каждый submit). Их
 * ловим post-flight через parsing error.message в handleTaskFailure.
 *
 * HEAD-запросы параллельно через Promise.all; если HEAD упал/не поддерживается
 * (некоторые CDN'ы) — silent skip конкретного ref'а, не блокируем юзера ради
 * нашей сетевой ошибки. Лучше дать Evolink сказать своё слово, чем зря отказать.
 */
async function validateNanoBananaInput(
  prompt: string,
  imageUrls: string[],
  fetchFn: typeof globalThis.fetch | undefined,
): Promise<void> {
  if (prompt.length > NANO_BANANA_PROMPT_MAX_CHARS) {
    throw new UserFacingError(
      `Prompt is ${prompt.length} chars (max ${NANO_BANANA_PROMPT_MAX_CHARS})`,
      { key: "promptTooLong", params: { limit: NANO_BANANA_PROMPT_MAX_CHARS } },
    );
  }
  if (imageUrls.length === 0) return;

  const fetcher = fetchFn ?? globalThis.fetch;
  const checks = await Promise.all(
    imageUrls.map(async (url) => {
      // URL-extension check сначала — мгновенно, ловит HEIC/AVIF/TIFF из имени.
      const urlExtMatch = url.match(NANO_BANANA_UNSUPPORTED_EXT_RE);
      if (urlExtMatch) {
        return { format: urlExtMatch[1].toLowerCase(), tooLarge: false } as const;
      }
      try {
        const resp = await fetcher(url, { method: "HEAD" });
        if (!resp.ok) return null;
        const ct = resp.headers.get("content-type")?.toLowerCase() ?? "";
        const ctMatch = ct.match(NANO_BANANA_UNSUPPORTED_CT_RE);
        if (ctMatch) {
          return { format: ctMatch[1].toLowerCase(), tooLarge: false } as const;
        }
        const cl = Number(resp.headers.get("content-length") ?? "0");
        if (cl > NANO_BANANA_MAX_FILE_SIZE_BYTES) {
          return { format: null, tooLarge: true, sizeBytes: cl } as const;
        }
        return null;
      } catch {
        return null;
      }
    }),
  );

  const formatViolation = checks.find((c) => c?.format);
  if (formatViolation?.format) {
    throw new UserFacingError(`Unsupported image format: ${formatViolation.format}`, {
      key: "imageFormatUnsupported",
      params: {
        format: formatViolation.format.toUpperCase(),
        supported: NANO_BANANA_SUPPORTED_FORMATS,
      },
    });
  }
  const sizeViolation = checks.find((c) => c?.tooLarge);
  if (sizeViolation?.tooLarge && "sizeBytes" in sizeViolation) {
    const actualMb = (sizeViolation.sizeBytes / (1024 * 1024)).toFixed(1);
    throw new UserFacingError(
      `Reference image too large: ${actualMb} MB (max ${NANO_BANANA_MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB)`,
      {
        key: "mediaSlotFileTooLarge",
        params: { actualMb, maxMb: String(NANO_BANANA_MAX_FILE_SIZE_BYTES / (1024 * 1024)) },
      },
    );
  }
}

/**
 * Evolink image adapter (provider="evolink") — fallback для nano-banana-* моделей.
 *
 * Endpoints:
 *  - POST /v1/images/generations — submit
 *  - GET  /v1/tasks/{task_id}     — poll
 *
 * Auth: Bearer токен в Authorization header'е.
 *
 * Семантически зеркалит KIE-адаптер для тех же концептуальных моделей: один
 * endpoint, async-режим, статусы pending → processing → completed/failed.
 * Поэтому adapter возвращает массив URL'ов одинаково с KIE — image processor
 * обрабатывает results[] идентично.
 */
export class EvolinkImageAdapter implements ImageAdapter {
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
    const key = this.apiKeyOverride ?? config.ai.evolink;
    if (!key) throw new Error("EVOLINK_API_KEY not configured");
    return key;
  }

  private get jsonHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async submit(input: ImageInput): Promise<string> {
    const evolinkModel = EVOLINK_MODEL_NAMES[this.modelId];
    if (!evolinkModel) {
      throw new Error(`Evolink: unknown model ${this.modelId}`);
    }
    // Зеркалит up-front проверку у KIE-адаптера. Без prompt'а evolink/KIE
    // под капотом отвечает 500 «This field is required»; ловим заранее, чтобы
    // юзер получил адресный мессадж и мы не жгли quota на гарантированный fail.
    const isNanoBanana = this.modelId.startsWith("nano-banana-");
    if (isNanoBanana && !input.prompt?.trim()) {
      throw new UserFacingError("Prompt is required for nano-banana models", {
        key: "promptRequired",
      });
    }
    const ms = input.modelSettings ?? {};
    const mi = input.mediaInputs ?? {};
    const editImages = mi.edit ?? [];
    const imageUrls = editImages.length > 0 ? editImages : input.imageUrl ? [input.imageUrl] : [];

    // Pre-flight validation для nano-banana семейства (per docs/schema/evolink/
    // nanobananapro.md + errors.md): отсекаем заранее, не жжём Evolink-квоту и не
    // ждём queue-cycle на гарантированный fail. Проверяем длину промпта, формат
    // и размер каждого ref'а через HEAD. Dimensions не проверяем (нужен full
    // download через sharp — слишком дорого для preflight); их ловим post-flight
    // через parsing error.message.
    if (isNanoBanana) {
      await validateNanoBananaInput(input.prompt!, imageUrls, this.fetchFn);
    }

    const body: Record<string, unknown> = {
      model: evolinkModel,
      prompt: input.prompt,
    };

    // ── gpt-image-2: уникальная схема параметров ──────────────────────────────
    // evolink принимает size как ratio ("16:9") | pixels ("1024x1024") | "auto",
    // resolution (1K/2K/4K) только для ratio-формата, и quality (low/medium/high).
    // Поддерживаем оба входных формата:
    //   - KIE primary settings: aspect_ratio (ratio) + resolution (1K/2K/4K)
    //   - OpenAI primary settings: size (pixel format) + quality
    if (this.modelId === "gpt-image-2") {
      // size: explicit pixel format from OpenAI-style settings выигрывает; иначе
      // ratio из aspect_ratio, иначе input.aspectRatio, иначе "auto" (default).
      const explicitSize = ms.size as string | undefined;
      const ratio = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio;
      const sizeValue = explicitSize ?? ratio;
      if (sizeValue && sizeValue !== "auto") body.size = sizeValue;

      // resolution применима только если size — ratio-формат (не pixel и не auto).
      const resolution = ms.resolution as string | undefined;
      if (resolution && (!explicitSize || /^\d+x\d+$/i.test(explicitSize) === false)) {
        body.resolution = resolution;
      }

      // quality: low/medium/high (default medium на стороне evolink).
      const quality = ms.quality as string | undefined;
      if (quality) body.quality = quality;

      // n: количество изображений (1-10), по умолчанию 1.
      const n = ms.n as number | undefined;
      if (typeof n === "number" && n > 1) body.n = Math.max(1, Math.min(10, Math.round(n)));

      if (imageUrls.length > 0) {
        const cap = MAX_REF_IMAGES[this.modelId] ?? 16;
        body.image_urls = imageUrls.slice(0, cap);
      }
    } else {
      // ── Nano Banana семейство ───────────────────────────────────────────────
      // size: либо явный modelSettings.aspect_ratio, либо input.aspectRatio.
      const size = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio;
      if (size) body.size = size;

      // resolution → quality (только для nano-banana-2 и nano-banana-pro;
      // nano-banana-1 / nano-banana-beta параметра quality не имеет).
      if (this.modelId === "nano-banana-2" || this.modelId === "nano-banana-pro") {
        const resolution = ms.resolution as string | undefined;
        if (resolution) body.quality = resolution;
      }

      if (imageUrls.length > 0) {
        const cap = MAX_REF_IMAGES[this.modelId] ?? 5;
        body.image_urls = imageUrls.slice(0, cap);
      }

      // model_params для v2/pro (web_search, image_search, thinking_level).
      if (this.modelId === "nano-banana-2" || this.modelId === "nano-banana-pro") {
        const modelParams: Record<string, unknown> = {};
        if (ms.enable_web_search != null) modelParams.web_search = !!ms.enable_web_search;
        if (this.modelId === "nano-banana-2") {
          if (ms.image_search != null) modelParams.image_search = !!ms.image_search;
          if (ms.thinking_level) modelParams.thinking_level = ms.thinking_level;
        }
        if (Object.keys(modelParams).length > 0) body.model_params = modelParams;
      }
    }

    const resp = await fetchWithLog(
      `${EVOLINK_BASE}/v1/images/generations`,
      {
        method: "POST",
        headers: this.jsonHeaders,
        body: JSON.stringify(body),
      },
      this.fetchFn,
    );

    if (!resp.ok) {
      const txt = await resp.text();
      // Создаём error с status — classifyRateLimit увидит 429, isFiveXxError — 5xx.
      const err = new Error(`Evolink image submit error ${resp.status}: ${txt}`) as Error & {
        status?: number;
      };
      err.status = resp.status;
      throw err;
    }

    const data = (await resp.json()) as EvolinkSubmitResponse;
    if (!data.id) {
      throw new Error(`Evolink image submit failed: no task id (${JSON.stringify(data)})`);
    }
    return data.id;
  }

  async poll(taskId: string): Promise<ImageResult[] | null> {
    const resp = await fetchWithLog(
      `${EVOLINK_BASE}/v1/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
      this.fetchFn,
    );

    if (!resp.ok) {
      const txt = await resp.text();
      const err = new Error(`Evolink image poll error ${resp.status}: ${txt}`) as Error & {
        status?: number;
      };
      err.status = resp.status;
      throw err;
    }

    const data = (await resp.json()) as EvolinkTaskResponse;

    if (data.status === "failed") {
      return this.handleTaskFailure(data.error);
    }
    if (data.status !== "completed") return null;

    const urls = data.results;
    if (!urls?.length) throw new Error("Evolink: no image URLs in completed task");

    return urls.map((url, i) => {
      const { ext, contentType } = parseImageMime(url);
      return {
        url,
        filename: `${this.modelId}-${i}.${ext}`,
        contentType,
      };
    });
  }

  /**
   * Маппит task-level evolink ошибки (см. docs/schema/evolink/errors.md) в
   * UserFacingError либо в generic Error со status'ом для классификации в
   * upstream rate-limit handlers.
   *
   * Категории:
   *  - User-fixable (контент / параметры) → UserFacingError, чтобы processor
   *    показал юзеру понятное сообщение и НЕ ретраил
   *  - Server-transient (service_error, generation_timeout, resource_exhausted)
   *    → Error со status 503/429, чтобы BullMQ ретраил, и/или сработал fallback
   *  - Quota / rate-limit task errors → status=429 → classifyRateLimit поймает
   */
  private async handleTaskFailure(
    error: { code?: string; message?: string } | undefined,
  ): Promise<never> {
    const code = error?.code ?? "unknown_error";
    const message = error?.message ?? "unknown error";
    const technicalMessage = `Evolink ${this.modelId} generation failed: ${code} ${message}`;

    switch (code) {
      // ── Client errors (user-fixable, no retry) ─────────────────────────────
      case "content_policy_violation": {
        // Sub-types: photorealistic people, celebrity, copyright, NSFW, violence...
        // Distinguish copyright / public-figure / general policy для точного
        // user-facing мессаджа.
        if (/public figure|public person|prominent figure|celebrity/i.test(message)) {
          throw new UserFacingError(technicalMessage, { key: "publicFigureViolation" });
        }
        if (/copyright|trademark|third-party|logo/i.test(message)) {
          throw new UserFacingError(technicalMessage, { key: "copyrightViolation" });
        }
        throw new UserFacingError(technicalMessage, { key: "contentPolicyViolation" });
      }

      case "invalid_parameters": {
        // Per Evolink docs (docs/schema/evolink/errors.md), invalid_parameters
        // классифицирован как Client Error (Fixable by User) — не наш баг, а
        // одна из 4 пользовательских проблем: prompt too long / image dimension /
        // file too large / unsupported format. Pre-flight в submit() уже отсекает
        // 3 из 4; сюда долетают в основном dimension-fail'ы и редкие случаи,
        // которые pre-flight пропустил (HEAD без Content-Length, etc.). Парсим
        // message → специфичная подсказка юзеру. notifyOps НЕ ставим — нашей
        // вины тут нет, иначе ops-канал шумит ради пользовательских проблем.
        if (/prompt is too long|prompt.*too long/i.test(message)) {
          throw new UserFacingError(technicalMessage, {
            key: "promptTooLong",
            params: { limit: 2000 },
          });
        }
        const sizeMatch = message.match(/file size (?:exceeds|over|larger than|>)\s*(\d+)\s*MB/i);
        if (sizeMatch) {
          throw new UserFacingError(technicalMessage, {
            key: "mediaSlotFileTooLarge",
            params: { actualMb: "—", maxMb: sizeMatch[1] },
          });
        }
        const dimMatch = message.match(/dimensions?\s+must be between\s+(\d+)\s+and\s+(\d+)/i);
        if (dimMatch) {
          throw new UserFacingError(technicalMessage, {
            key: "imageDimensionOutOfRange",
            params: { min: dimMatch[1], max: dimMatch[2] },
          });
        }
        if (/unsupported file type|unsupported (?:image )?format/i.test(message)) {
          throw new UserFacingError(technicalMessage, {
            key: "imageFormatUnsupported",
            params: { format: "—", supported: "JPG, PNG, WebP" },
          });
        }
        // Generic actionable fallback — не распознали под-тип. Без notifyOps:
        // если pre-flight пропустил, узнаем из логов (плюс это всё равно client
        // error). По мере появления новых патернов в логах — добавляем regex.
        throw new UserFacingError(technicalMessage, {
          key: "aiClassifiedError",
          params: {
            messageRu:
              "❌ Запрос не принят моделью. Возможные причины: слишком длинный промпт (более 2000 символов), размер изображения вне диапазона 240–7680 пикселей, файл больше 10 МБ или неподдерживаемый формат (нужен JPG/PNG/WebP). Попробуйте упростить запрос или сменить референсы.",
            messageEn:
              "❌ Request not accepted by model. Possible causes: prompt too long (>2000 chars), image dimensions outside 240–7680 px, file size >10 MB, or unsupported format (needs JPG/PNG/WebP). Try simplifying the prompt or replacing references.",
          },
        });
      }

      case "image_processing_error":
      case "image_dimension_mismatch": {
        // User uploaded a problematic reference image. Подсказываем что менять.
        throw new UserFacingError(technicalMessage, {
          key: "aiClassifiedError",
          params: {
            messageRu:
              "Не удалось обработать загруженное изображение. Попробуйте другое (jpg/png, до 20 МБ).",
            messageEn:
              "Failed to process the uploaded image. Try a different one (jpg/png, ≤20 MB).",
          },
          notifyOps: false,
        });
      }

      case "request_cancelled": {
        // Не пользовательская отмена в нашем флоу — рассматриваем как transient.
        // Generic Error → BullMQ retry.
        throw new Error(technicalMessage);
      }

      // ── Generation issues (often content-related, but vague) ──────────────
      case "generation_failed_no_content": {
        if (/public figure|public person|prominent figure|celebrity/i.test(message)) {
          throw new UserFacingError(technicalMessage, { key: "publicFigureViolation" });
        }
        if (/copyright|trademark|logo|watermark/i.test(message)) {
          throw new UserFacingError(technicalMessage, { key: "copyrightViolation" });
        }
        if (/policy|sensitive|nsfw|prohibited|safety|inappropriate|violat/i.test(message)) {
          throw new UserFacingError(technicalMessage, { key: "contentPolicyViolation" });
        }
        // Generic generation failure — let user know to refine prompt.
        throw new UserFacingError(technicalMessage, {
          key: "aiClassifiedError",
          params: {
            messageRu: "Модель не смогла сгенерировать изображение. Попробуйте уточнить промпт.",
            messageEn: "Model could not generate. Try refining your prompt.",
          },
          notifyOps: false,
        });
      }

      // ── Server / quota errors (retryable, set HTTP-like status) ───────────
      case "quota_exceeded":
      case "resource_exhausted": {
        // Provider rate limit / capacity. status=429 → classifyRateLimit catches.
        const err = new Error(technicalMessage) as Error & { status?: number };
        err.status = 429;
        throw err;
      }

      case "service_error":
      case "service_unavailable":
      case "generation_timeout": {
        // Transient upstream issue. status=503 → isFiveXxError catches → fallback
        // eligible after 2 retries (per submit-with-fallback's persistent-5xx rule).
        const err = new Error(technicalMessage) as Error & { status?: number };
        err.status = 503;
        throw err;
      }

      case "resource_not_found": {
        // Task ID expired / invalid. No retry will help. Generic Error so
        // processor's outer catch handles as terminal failure.
        throw new Error(technicalMessage);
      }

      // ── Unknown / unclassified ─────────────────────────────────────────────
      case "unknown_error":
      default: {
        // Try AI classifier (LLM-based heuristic) for one last attempt to
        // produce a user-facing message. Falls back to generic Error.
        const classified = await classifyAIError(`${code} ${message}`.trim());
        if (classified?.shouldShow) {
          throw new UserFacingError(technicalMessage, {
            key: "aiClassifiedError",
            params: { messageRu: classified.messageRu, messageEn: classified.messageEn },
            notifyOps: true,
          });
        }
        throw new Error(technicalMessage);
      }
    }
  }
}
