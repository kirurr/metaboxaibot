import { fal } from "@fal-ai/client";
import type {
  VideoAdapter,
  VideoInput,
  VideoResult,
  VideoValidationError,
} from "./base.adapter.js";
import {
  config,
  UserFacingError,
  PHOTO_ANIMATE_PROMPT,
  parseVideoShots,
  sumShotDuration,
  MULTISHOT_MAX_SHOTS,
  MULTISHOT_PROMPT_MAX_LENGTH,
  MULTISHOT_SHOT_DURATION_MIN,
  MULTISHOT_SHOT_DURATION_MAX,
  MULTISHOT_TOTAL_DURATION_MIN,
  MULTISHOT_TOTAL_DURATION_MAX,
} from "@metabox/shared";
import { logCall } from "../../utils/fetch.js";
import { cropImageUrlAndMaterialize, KLING_SUPPORTED_ASPECTS } from "../../utils/image-aspect.js";
import { translatePromptRefs } from "../../services/prompt-ref-translator.service.js";

/**
 * Конвертирует ApiError из @fal-ai/client в чистый Error с коротким message
 * и сохранённым numeric `status` (для isFiveXxError → cascade-fallback).
 *
 * Зачем: fal SDK строит `ApiError.message` как
 * `"<short text>\nHTTP <code>\nbody: <full json>"`. Для `downstream_service_error`
 * (xAI/Grok upstream down) body содержит полный input запроса — prompt +
 * presigned S3 URL с `X-Amz-Signature`. Без обрезки это утекает в ops-алёрты
 * многокилобайтной портянкой, плюс лёгкий security smell (signed URL — короткий
 * credential). Чистая версия — статус + тип ошибки + первые 200 символов msg.
 *
 * Наши собственные `throw new Error("FAL …")` (валидация входа) пропускаются
 * без изменений — у них `name === "Error"`, а fal SDK ставит `name = "ApiError"`
 * или `"ValidationError"` (последний — subclass от ApiError, бросается на 422
 * от pydantic-валидации входа; тоже несёт `body.detail` с эхом запроса).
 *
 * Возвращает `never` (всегда throw'ит) — для TS narrowing в catch-блоке вызова.
 */
function rethrowFalApiError(err: unknown): never {
  const e = err as {
    name?: unknown;
    status?: unknown;
    body?: unknown;
    message?: unknown;
  };
  if (e?.name === "ApiError" || e?.name === "ValidationError") {
    const status = typeof e.status === "number" && e.status >= 100 && e.status < 600 ? e.status : 0;
    const body = e.body as
      | { detail?: Array<{ msg?: string; type?: string; input?: { prompt?: unknown } }> }
      | undefined;
    const detail = body?.detail?.[0];
    const errType = detail?.type ?? "unknown";
    const rawMsg =
      detail?.msg ?? (typeof e.message === "string" ? e.message.split("\n")[0] : "FAL error");
    const briefMsg = rawMsg.slice(0, 200);

    // ValidationError (422) — это user-fault, BullMQ-ретраи бесполезны, ops
    // алёртить незачем. Маппим в UserFacingError, чтобы video processor
    // показал юзеру осмысленный текст и пометил job как UnrecoverableError.
    //
    // Спец-кейс: «Prompt length exceeds the maximum allowed length of N» →
    // используем готовый ключ `promptTooLong` (в обоих i18n-namespace), число
    // из ошибки провайдера подогнано под bytes-per-char ratio (см. ниже).
    if (e?.name === "ValidationError") {
      const limitMatch = /maximum allowed length of (\d+)/i.exec(rawMsg);
      if (limitMatch) {
        // Считаем char-лимит из реального промпта юзера, эхающегося в body.
        // fal в ValidationError возвращает `body.detail[0].input.prompt` —
        // оригинальный prompt, который мы только что послали. Это позволяет
        // показать юзеру char-лимит, точный для **его** языка: 1.0×byteLimit
        // для ASCII, 0.5× для русского, etc. Без эхо-промпта — fallback halve.
        //
        // Используем существующий ключ `promptTooLong` (уже в обоих
        // i18n-namespace), не вводим новый — см. video-generation.service.ts.
        const inputPrompt = detail?.input?.prompt;
        const promptStr = typeof inputPrompt === "string" ? inputPrompt : undefined;
        const limitFromError = Number(limitMatch[1]);
        let charLimit: number;
        if (promptStr) {
          const charLen = [...promptStr].length;
          const byteLen = Buffer.byteLength(promptStr, "utf8");
          const bytesPerChar = charLen > 0 ? byteLen / charLen : 2;
          charLimit = Math.floor(limitFromError / bytesPerChar);
        } else {
          charLimit = Math.floor(limitFromError / 2);
        }
        throw new UserFacingError(`FAL ValidationError: ${briefMsg}`, {
          key: "promptTooLong",
          params: { limit: charLimit },
        });
      }
      throw new UserFacingError(`FAL ValidationError: ${briefMsg}`, {
        key: "providerInputRejected",
        params: { reason: briefMsg },
      });
    }

    const cleaned = new Error(`FAL ${status || "??"} ${errType}: ${briefMsg}`) as Error & {
      status?: number;
    };
    if (status) cleaned.status = status;
    throw cleaned;
  }
  throw err;
}

/**
 * Text-to-video endpoint for each model.
 *
 * Kling uses o3 (Omni) family — выбран как fallback для primary KIE kling[-pro].
 * Pricing per-second по quality × audio (см. FALLBACK_VIDEO_MODELS).
 */
const FAL_ENDPOINTS: Record<string, string> = {
  kling: "fal-ai/kling-video/o3/standard/text-to-video",
  "kling-pro": "fal-ai/kling-video/o3/pro/text-to-video",
  pika: "fal-ai/pika/v2.2/text-to-video",
  seedance: "fal-ai/bytedance/seedance/v1.5/pro/text-to-video",
};

/**
 * Image-to-video endpoint. Falls back to the T2V endpoint when absent.
 * Используется для kling когда заданы ТОЛЬКО first_frame (+ опционально last_frame),
 * без ref_element_*. i2v endpoint не принимает elements/image_urls.
 */
const FAL_I2V_ENDPOINTS: Record<string, string> = {
  kling: "fal-ai/kling-video/o3/standard/image-to-video",
  "kling-pro": "fal-ai/kling-video/o3/pro/image-to-video",
  seedance: "fal-ai/bytedance/seedance/v1.5/pro/image-to-video",
  pika: "fal-ai/pika/v2.2/image-to-video",
};

/**
 * Reference-to-video endpoint (только kling-o3). Используется когда задача
 * имеет ref_element_* (или только last_frame без first_frame — i2v требует
 * start image). Принимает start_image_url, end_image_url, image_urls, elements.
 */
const FAL_R2V_ENDPOINTS: Record<string, string> = {
  kling: "fal-ai/kling-video/o3/standard/reference-to-video",
  "kling-pro": "fal-ai/kling-video/o3/pro/reference-to-video",
};

/** Kling Motion Control endpoints — dedicated, no T2V/I2V split.
 *  `copy-motion` — alias на Pro endpoint для готового сценария «Копировать
 *  движение»; preset-параметры зашиваются ниже в ветке submit'а. */
const FAL_MOTION_ENDPOINTS: Record<string, string> = {
  "kling-motion": "fal-ai/kling-video/v3/standard/motion-control",
  "kling-motion-pro": "fal-ai/kling-video/v3/pro/motion-control",
  "copy-motion": "fal-ai/kling-video/v3/pro/motion-control",
};

/** True если modelId — это kling-o3 семейство (kling или kling-pro). */
function isKlingO3(modelId: string): boolean {
  return modelId === "kling" || modelId === "kling-pro";
}

const FAL_GROK_IMAGINE_T2V_ENDPOINT = "xai/grok-imagine-video/text-to-video";
const FAL_GROK_IMAGINE_R2V_ENDPOINT = "xai/grok-imagine-video/reference-to-video";
const FAL_GROK_IMAGINE_EXTEND_ENDPOINT = "xai/grok-imagine-video/extend-video";

/** Topaz video upscale endpoint — fallback для KIE primary `video-upscale`. */
const FAL_TOPAZ_VIDEO_ENDPOINT = "fal-ai/topaz/upscale/video";

/** Separator used to pack endpoint+requestId into a single opaque string. */
const SEP = "||";

function isVideoUrl(url: string): boolean {
  return /\.(mp4|mov|webm|m4v)(\?|$)/i.test(url);
}

export class FalVideoAdapter implements VideoAdapter {
  // FAL SDK глобальный config — proxy на MVP не поддерживается, fetchFn игнорируется.
  constructor(
    readonly modelId: string,
    apiKey = config.ai.fal,
    _fetchFn?: typeof globalThis.fetch,
  ) {
    fal.config({ credentials: apiKey });
  }

  /**
   * Выбор endpoint'а для kling-o3 (3 варианта):
   *  - есть ref_element_* → reference-to-video (поддерживает elements + start/end)
   *  - есть только start (или start+end) → image-to-video (image_url required)
   *  - есть только end (без start) → reference-to-video (i2v требует start)
   *  - нет media → text-to-video
   */
  private selectKlingO3Endpoint(input: VideoInput): string {
    const mi = input.mediaInputs ?? {};
    const hasElement = [1, 2, 3, 4, 5].some((i) => mi[`ref_element_${i}`]?.length);
    const hasStart = !!(mi.first_frame?.[0] || input.imageUrl);
    const hasEnd = !!mi.last_frame?.[0];
    if (hasElement) return FAL_R2V_ENDPOINTS[this.modelId];
    if (hasStart) return FAL_I2V_ENDPOINTS[this.modelId];
    if (hasEnd) return FAL_R2V_ENDPOINTS[this.modelId];
    return FAL_ENDPOINTS[this.modelId];
  }

  private selectEndpoint(input: VideoInput): string {
    if (FAL_MOTION_ENDPOINTS[this.modelId]) {
      return FAL_MOTION_ENDPOINTS[this.modelId];
    }
    if (isKlingO3(this.modelId)) {
      return this.selectKlingO3Endpoint(input);
    }
    if (!FAL_I2V_ENDPOINTS[this.modelId]) {
      return FAL_ENDPOINTS[this.modelId] ?? `fal-ai/${this.modelId}`;
    }
    const mi = input.mediaInputs ?? {};
    const hasMedia =
      !!mi.first_frame?.length ||
      !!mi.last_frame?.length ||
      !!input.imageUrl ||
      Object.keys(mi).some((k) => k.startsWith("ref_element_") && mi[k]?.length);
    return hasMedia
      ? FAL_I2V_ENDPOINTS[this.modelId]
      : (FAL_ENDPOINTS[this.modelId] ?? `fal-ai/${this.modelId}`);
  }

  /**
   * Backstop-валидация multishot для kling-o3. Фронт (`multishotBlocker`) и роут
   * уже блокируют невалидное, но этот путь защищает прямой fal-вызов (и fallback,
   * где фронт-проверка не повторяется). Границы — те же общие `MULTISHOT_*`, что
   * и у kie. Для non-multishot / не-kling возвращаем null (поведение без изменений).
   */
  validateRequest(input: VideoInput): VideoValidationError | null {
    const ms = input.modelSettings ?? {};
    if (!isKlingO3(this.modelId) || ms.multishot !== true) return null;

    const shots = parseVideoShots(ms.shots);
    if (shots.length === 0) {
      return { key: "multishotEmpty" };
    }
    if (shots.length > MULTISHOT_MAX_SHOTS) {
      return { key: "multishotTooManyShots", params: { max: MULTISHOT_MAX_SHOTS } };
    }
    for (const shot of shots) {
      if (!shot.prompt.trim()) {
        return { key: "multishotEmptyShotPrompt" };
      }
      if (shot.prompt.length > MULTISHOT_PROMPT_MAX_LENGTH) {
        return {
          key: "multishotShotPromptTooLong",
          params: { limit: MULTISHOT_PROMPT_MAX_LENGTH },
        };
      }
      if (
        !Number.isInteger(shot.duration) ||
        shot.duration < MULTISHOT_SHOT_DURATION_MIN ||
        shot.duration > MULTISHOT_SHOT_DURATION_MAX
      ) {
        return {
          key: "multishotShotDurationOutOfRange",
          params: { min: MULTISHOT_SHOT_DURATION_MIN, max: MULTISHOT_SHOT_DURATION_MAX },
        };
      }
    }
    const total = shots.reduce((acc, s) => acc + s.duration, 0);
    if (total < MULTISHOT_TOTAL_DURATION_MIN || total > MULTISHOT_TOTAL_DURATION_MAX) {
      return {
        key: "multishotTotalDurationOutOfRange",
        params: { min: MULTISHOT_TOTAL_DURATION_MIN, max: MULTISHOT_TOTAL_DURATION_MAX },
      };
    }
    return null;
  }

  async submit(input: VideoInput): Promise<string> {
    try {
      return await this._submitImpl(input);
    } catch (err) {
      rethrowFalApiError(err);
    }
  }

  private async _submitImpl(input: VideoInput): Promise<string> {
    const imageUrl = input.mediaInputs?.first_frame?.[0] ?? input.imageUrl;
    const ms = input.modelSettings ?? {};

    // ── Topaz video upscale (fal-ai/topaz/upscale/video) ─────────────────────
    // Fallback для KIE primary `video-upscale`. `Starlight HQ` — генеративная
    // diffusion-модель Topaz: реконструирует детали (качественнее, но медленнее
    // не-генеративных). Fal принимает `upscale_factor` множителем 1–4 — ровно
    // как KIE, без маппинга в разрешение. `target_fps` НЕ шлём: он включает
    // интерполяцию кадров (KIE этого не делает). H264 — ради совместимости
    // плеера Telegram (дефолт Fal — H265/HEVC).
    if (this.modelId === "video-upscale") {
      const videoUrl = input.mediaInputs?.motion_video?.[0] ?? input.imageUrl;
      if (!videoUrl) {
        throw new Error("FAL video-upscale: source video is required");
      }
      const rawFactor = Number(ms.upscale_factor ?? 2);
      const upscaleFactor = Math.min(4, Math.max(1, Number.isFinite(rawFactor) ? rawFactor : 2));
      const upscaleBody = {
        video_url: videoUrl,
        model: "Starlight HQ" as const,
        upscale_factor: upscaleFactor,
        H264_output: true,
      };
      logCall(FAL_TOPAZ_VIDEO_ENDPOINT, "submit", upscaleBody);
      const { request_id } = await fal.queue.submit(FAL_TOPAZ_VIDEO_ENDPOINT, {
        input: upscaleBody,
      });
      return `${FAL_TOPAZ_VIDEO_ENDPOINT}${SEP}${request_id}`;
    }

    const msExtras: Record<string, unknown> = {};
    if (ms.cfg_scale !== undefined) msExtras.cfg_scale = ms.cfg_scale;
    if (ms.negative_prompt) msExtras.negative_prompt = ms.negative_prompt;
    if (ms.generate_audio !== undefined) msExtras.generate_audio = ms.generate_audio;
    if (ms.resolution) msExtras.resolution = ms.resolution;
    if (ms.motion_strength !== undefined) msExtras.motion_strength = ms.motion_strength;
    if (ms.seed != null) msExtras.seed = ms.seed;

    // ── Grok Imagine (xai/grok-imagine-video) ────────────────────────────────
    // Два endpoint'а:
    //   - text-to-video:      prompt only, duration 1-15s, resolution default 720p
    //   - reference-to-video: prompt + reference_image_urls, duration 1-10s
    //
    // Endpoint выбирается ИСКЛЮЧИТЕЛЬНО по modelId (после разделения primary
    // на 2 модели):
    //   - `grok-imagine`     → всегда t2v, ref_images игнорируются (защита от
    //     legacy-state у юзеров, которые до разделения сохранили ref_images
    //     под этим modelId; UI слот больше не показывает).
    //   - `grok-imagine-r2v` → всегда r2v.
    //   - `photo-animate`    → alias r2v (сценарий «Оживить фото»).
    if (
      this.modelId === "grok-imagine" ||
      this.modelId === "grok-imagine-r2v" ||
      this.modelId === "photo-animate"
    ) {
      const isR2V = this.modelId === "grok-imagine-r2v" || this.modelId === "photo-animate";
      const endpoint = isR2V ? FAL_GROK_IMAGINE_R2V_ENDPOINT : FAL_GROK_IMAGINE_T2V_ENDPOINT;

      // Сценарий «🎞️ Оживить фото»: prompt в БД пустой, реальный фикс-промпт
      // инжектится здесь, в провайдер.
      const effectivePrompt =
        this.modelId === "photo-animate" ? PHOTO_ANIMATE_PROMPT : (input.prompt ?? "");
      const grokBody: Record<string, unknown> = {
        prompt: translatePromptRefs(effectivePrompt, { dialect: "fal" }),
      };

      if (isR2V) {
        const refImages = input.mediaInputs?.ref_images ?? [];
        grokBody.reference_image_urls = refImages.slice(0, 7);
      }

      // duration: integer. t2v max 15s, r2v max 10s (FAL hard limits).
      const rawDuration = (ms.duration as number | undefined) ?? input.duration ?? 8;
      const maxDuration = isR2V ? 10 : 15;
      grokBody.duration = Math.max(1, Math.min(maxDuration, Math.round(Number(rawDuration) || 8)));

      // resolution: 480p / 720p
      if (ms.resolution) grokBody.resolution = ms.resolution;

      const ar = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio;
      if (ar && ar !== "auto") grokBody.aspect_ratio = ar;

      logCall(endpoint, "submit", grokBody);
      const { request_id } = await fal.queue.submit(endpoint, { input: grokBody });
      return `${endpoint}${SEP}${request_id}`;
    }

    // ── Grok Imagine Extend (xai/grok-imagine-video/extend-video) ────────────
    // Активируется только через кнопку «Продлить» под результатом Grok-видео.
    // Источник видео лежит в slot source_video. Output FAL = original +
    // extension склеенные. Лимиты: source 2-15s, extension 2-10s, prompt
    // ≤4096 символов. Output resolution / aspect_ratio наследуются от source.
    if (this.modelId === "grok-imagine-extend") {
      const sourceVideos = input.mediaInputs?.source_video ?? [];
      const videoUrl = sourceVideos[0];
      if (!videoUrl) {
        throw new Error("FAL grok-imagine-extend: source_video slot is required");
      }
      // Fallback на 6 (durationRange.min, совпадает с FAL endpoint default).
      // Cost preview тоже использует durationRange.min — расхождения «показали
      // $X — списали $Y» нет. Clamp 6-10: модель в каталоге не разрешает
      // ниже 6 (короткие extension'ы у FAL нестабильны), но защищаемся
      // на уровне адаптера на случай старого state'а.
      const rawDuration = (ms.duration as number | undefined) ?? input.duration ?? 6;
      const duration = Math.max(6, Math.min(10, Math.round(Number(rawDuration) || 6)));
      const extendBody: Record<string, unknown> = {
        prompt: (input.prompt ?? "").slice(0, 4096),
        video_url: videoUrl,
        duration,
      };
      logCall(FAL_GROK_IMAGINE_EXTEND_ENDPOINT, "submit", extendBody);
      const { request_id } = await fal.queue.submit(FAL_GROK_IMAGINE_EXTEND_ENDPOINT, {
        input: extendBody,
      });
      return `${FAL_GROK_IMAGINE_EXTEND_ENDPOINT}${SEP}${request_id}`;
    }

    // ── Kling-O3 (kling / kling-pro) ─────────────────────────────────────────
    // Изолирован от обобщённой ветки ниже потому что:
    //   1. Endpoints выбираются динамически (t2v/i2v/r2v) — поля payload'а отличаются.
    //   2. i2v использует `image_url`, r2v использует `start_image_url`.
    //   3. duration здесь — string enum ("3"-"15"), а не number.
    //   4. Prompt @elementN → @ElementN remap.
    if (isKlingO3(this.modelId)) {
      const endpoint = this.selectKlingO3Endpoint(input);
      const isI2V = endpoint === FAL_I2V_ENDPOINTS[this.modelId];
      const isR2V = endpoint === FAL_R2V_ENDPOINTS[this.modelId];

      let startUrl = input.mediaInputs?.first_frame?.[0] ?? input.imageUrl;
      let endUrl = input.mediaInputs?.last_frame?.[0];

      // Pre-crop frames под выбранный aspect, если юзер включил
      // `crop_to_aspect` (см. KLING_SETTINGS). FAL Kling-o3 принимает image
      // URLs напрямую и сам качает, поэтому подменяем URL на cropped
      // presigned URL ДО отправки. Кропаем только frame'ы (start/end) —
      // elements.frontal_image_url / reference_image_urls на aspect не
      // влияют, как и в KIE-адаптере. cropImageUrlAndMaterialize сам no-op'ит
      // для unsupported aspect / aligned image / S3 misconfig / fetch fail.
      const aspectForCrop = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio;
      const cropEnabled = ms.crop_to_aspect === true;
      if (cropEnabled && aspectForCrop && KLING_SUPPORTED_ASPECTS.includes(aspectForCrop)) {
        const cropOne = (url: string | undefined): Promise<string | undefined> =>
          url
            ? cropImageUrlAndMaterialize(url, aspectForCrop, { userId: input.userId })
            : Promise.resolve(undefined);
        const [croppedStart, croppedEnd] = await Promise.all([cropOne(startUrl), cropOne(endUrl)]);
        startUrl = croppedStart;
        endUrl = croppedEnd;
      }

      // Multi-shot: список {prompt,duration} полностью заменяет одиночный
      // prompt. FAL Kling-o3 принимает `multi_prompt` (duration шота — СТРОКА)
      // во всех трёх режимах (t2v/i2v/r2v) и требует `shot_type:"customize"`.
      // Правило схемы: «either prompt or multi_prompt, not both» — в multishot
      // top-level prompt НЕ ставим.
      const multishot = ms.multishot === true;
      const shots = multishot ? parseVideoShots(ms.shots) : [];
      const isMulti = multishot && shots.length > 0;

      const klingBody: Record<string, unknown> = {};
      if (isMulti) {
        klingBody.multi_prompt = shots.map((s) => ({
          prompt: translatePromptRefs(s.prompt, { dialect: "fal" }),
          duration: String(s.duration),
        }));
        klingBody.shot_type = "customize";
      } else if (input.prompt) {
        klingBody.prompt = translatePromptRefs(input.prompt, { dialect: "fal" });
      }

      // duration: STRING enum "3"-"15" по схеме FAL. В multishot = сумме
      // длительностей шотов (sumShotDuration клампит в [3,15]).
      const rawDuration = (ms.duration as number | undefined) ?? input.duration ?? 5;
      const dur = isMulti
        ? sumShotDuration(shots)
        : Math.max(3, Math.min(15, Math.round(Number(rawDuration) || 5)));
      klingBody.duration = String(dur);

      // generate_audio передаём только если задан в settings (default schema = false,
      // primary KLING_SETTINGS — true; пользователь может toggle'нуть).
      if (ms.generate_audio !== undefined) klingBody.generate_audio = !!ms.generate_audio;

      if (isI2V) {
        // image-to-video: image_url required, end_image_url optional.
        // Не принимает elements / image_urls / aspect_ratio.
        if (!startUrl) {
          throw new Error("FAL kling i2v: start image required");
        }
        klingBody.image_url = startUrl;
        if (endUrl) klingBody.end_image_url = endUrl;
      } else if (isR2V) {
        // reference-to-video: всё опционально, но что-то должно быть.
        if (startUrl) klingBody.start_image_url = startUrl;
        if (endUrl) klingBody.end_image_url = endUrl;

        // Elements: до 3 (primary KIE has up to 3 ref_element_* slots).
        const elements: Array<Record<string, unknown>> = [];
        for (let i = 1; i <= 5; i++) {
          const urls = input.mediaInputs?.[`ref_element_${i}`] ?? [];
          if (urls.length === 0) continue;
          const videoUrl = urls.find((u) => isVideoUrl(u));
          if (videoUrl) {
            elements.push({ video_url: videoUrl });
            continue;
          }
          const [frontal, ...refs] = urls;
          if (!frontal) continue;
          elements.push({
            frontal_image_url: frontal,
            // FAL schema: reference_image_urls is 1-3 images, at least one required.
            reference_image_urls: refs.length > 0 ? refs.slice(0, 3) : [frontal],
          });
        }
        if (elements.length > 0) klingBody.elements = elements;

        // aspect_ratio (только r2v принимает; default 16:9).
        const ar = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio;
        if (ar && ar !== "auto") klingBody.aspect_ratio = ar;
      } else {
        // text-to-video: ничего больше не требуется.
        // FAL t2v также может поддерживать aspect_ratio (хотя в нашей схеме i2v нет).
        // Передаём осторожно — если api отклонит, сюда упадёт invalid_request.
        const ar = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio;
        if (ar && ar !== "auto") klingBody.aspect_ratio = ar;
      }

      logCall(endpoint, "submit", klingBody);
      const { request_id } = await fal.queue.submit(endpoint, { input: klingBody });
      return `${endpoint}${SEP}${request_id}`;
    }

    // ── Kling Motion Control ─────────────────────────────────────────────────
    if (FAL_MOTION_ENDPOINTS[this.modelId]) {
      const motionImageUrl = input.mediaInputs?.first_frame?.[0] ?? input.imageUrl;
      const motionVideoUrl = input.mediaInputs?.motion_video?.[0];
      // Готовый сценарий «Копировать движение»: ориентация зашита. FAL endpoint
      // не принимает background_source — фон в этом fallback'е придёт из видео,
      // а не из изображения. Деградация приемлема (KIE primary держит инвариант).
      const isCopyMotionPreset = this.modelId === "copy-motion";
      const orientation = isCopyMotionPreset
        ? "video"
        : ((ms.character_orientation as string) ?? "video");
      const keepSound = ms.keep_original_sound !== undefined ? ms.keep_original_sound : true;

      const motionInput: Record<string, unknown> = {
        image_url: motionImageUrl,
        video_url: motionVideoUrl,
        character_orientation: orientation,
        keep_original_sound: keepSound,
      };
      if (input.prompt) motionInput.prompt = input.prompt;

      // Elements: only supported when character_orientation="video", max 1.
      // KlingV3ImageElementInput uses frontal_image_url + reference_image_urls (same as i2v).
      if (orientation === "video") {
        const elemUrls = input.mediaInputs?.ref_element_1 ?? [];
        if (elemUrls.length > 0) {
          const [frontal, ...refs] = elemUrls;
          if (frontal) {
            motionInput.elements = [
              {
                frontal_image_url: frontal,
                reference_image_urls: refs.length > 0 ? refs.slice(0, 3) : [frontal],
              },
            ];
          }
        }
      }

      const endpoint = FAL_MOTION_ENDPOINTS[this.modelId];
      logCall(endpoint, "submit", motionInput);
      const { request_id } = await fal.queue.submit(endpoint, { input: motionInput });
      return `${endpoint}${SEP}${request_id}`;
    }

    // Seedance 1.5: last_frame → end_image_url (i2v).
    const seedanceExtras: Record<string, unknown> = {};
    if (this.modelId === "seedance") {
      const lastFrame = input.mediaInputs?.last_frame?.[0];
      if (lastFrame) seedanceExtras.end_image_url = lastFrame;
    }

    const endpoint = this.selectEndpoint(input);

    const falInput = {
      prompt: input.prompt,
      ...(imageUrl ? { image_url: imageUrl } : {}),
      ...(input.duration ? { duration: input.duration } : {}),
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      ...msExtras,
      ...seedanceExtras,
    };
    logCall(endpoint, "submit", falInput);
    const { request_id } = await fal.queue.submit(endpoint, { input: falInput });
    return `${endpoint}${SEP}${request_id}`;
  }

  async poll(providerJobId: string): Promise<VideoResult | null> {
    try {
      return await this._pollImpl(providerJobId);
    } catch (err) {
      rethrowFalApiError(err);
    }
  }

  private async _pollImpl(providerJobId: string): Promise<VideoResult | null> {
    // Support legacy plain request_id format (pre-encoding) for backwards compat
    let endpoint: string;
    let requestId: string;
    if (providerJobId.includes(SEP)) {
      const sepIdx = providerJobId.lastIndexOf(SEP);
      endpoint = providerJobId.slice(0, sepIdx);
      requestId = providerJobId.slice(sepIdx + SEP.length);
    } else {
      endpoint = FAL_ENDPOINTS[this.modelId] ?? `fal-ai/${this.modelId}`;
      requestId = providerJobId;
    }

    logCall(this.modelId, "poll", { requestId, endpoint });

    const status = await fal.queue.status(endpoint, {
      requestId,
      logs: false,
    });

    if (status.status !== "COMPLETED") return null;

    const result = await fal.queue.result(endpoint, { requestId });
    const data = result.data as { video?: { url: string }; video_url?: string };
    const url = data.video?.url ?? data.video_url;
    if (!url) throw new Error(`FAL video: no URL in result for ${this.modelId}`);
    return { url, filename: `${this.modelId}.mp4` };
  }
}
