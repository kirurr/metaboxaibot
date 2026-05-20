import Replicate from "replicate";
import type { ImageAdapter, ImageInput, ImageResult } from "./base.adapter.js";
import { config, UserFacingError } from "@metabox/shared";
import { logger } from "../../logger.js";
import { logCall } from "../../utils/fetch.js";
import { parseReplicatePredictionFailure } from "../../utils/replicate-error.js";
import { resolveImageMimeType } from "../../utils/mime-detect.js";

/**
 * Models that accept a raw `aspect_ratio` string (e.g. "16:9") instead of
 * explicit width/height dimensions.
 */
const DIRECT_ASPECT_RATIO_MODELS = new Set([
  "midjourney",
  "stable-diffusion",
  "imagen-4",
  "imagen-4-fast",
  "imagen-4-ultra",
]);

/**
 * Maps modelId → Replicate model string.
 * Format "owner/name" → SDK calls POST /v1/models/{owner}/{name}/predictions (latest deployment).
 * Format "owner/name:sha256hash" → SDK calls POST /v1/predictions with { version: hash }.
 */
const MODEL_IDS: Record<string, string> = {
  // Use deployment endpoint (no pinned version) — always resolves to latest published version
  "stable-diffusion": "stability-ai/stable-diffusion-3.5-large",
  "ideogram-quality": "ideogram-ai/ideogram-v3-quality",
  "ideogram-balanced": "ideogram-ai/ideogram-v3-balanced",
  "ideogram-turbo": "ideogram-ai/ideogram-v3-turbo",
  midjourney:
    "adminconteudosflix/midjourney-allcraft:40ab9b32cc4584bc069e22027fffb97e79ed550d4e7c20ed6d5d7ef89e8f08f5",
  "imagen-4-fast": "google/imagen-4-fast",
  "imagen-4": "google/imagen-4",
  "imagen-4-ultra": "google/imagen-4-ultra",
  // Специализированный face-swap (InsightFace). Deployment-endpoint без пина
  // версии — всегда последняя опубликованная. Параметры: input_image (сцена) +
  // swap_image (лицо). Без prompt.
  "face-swap-classic": "cdingram/face-swap",
};

/** Ideogram model IDs — accept `style_reference_images` array instead of `image`. */
const IDEOGRAM_MODELS = new Set(["ideogram-quality", "ideogram-balanced", "ideogram-turbo"]);

/**
 * Dedicated face-swap models — принимают пару картинок (input_image + swap_image)
 * и НЕ принимают prompt. Обрабатываются отдельной веткой в submit().
 * mediaInputs.edit: [0] = input_image (сцена), [1] = swap_image (лицо).
 */
const FACE_SWAP_MODELS = new Set(["face-swap-classic"]);

/**
 * Replicate adapter — async image generation.
 * Covers Stable Diffusion (SDXL), Ideogram, and Midjourney-style models.
 */
export class ReplicateAdapter implements ImageAdapter {
  readonly isAsync = true;

  private client: Replicate;

  constructor(
    readonly modelId: string,
    apiKey = config.ai.replicate,
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.client = new Replicate({
      auth: apiKey,
      ...(fetchFn ? { fetch: fetchFn } : {}),
    });
  }

  private resolveSize(input: ImageInput): { width: number; height: number } {
    // Aspect ratio → nearest clean dimensions at ~1024px long-side (multiples of 8)
    const REPLICATE_SIZES: Record<string, { width: number; height: number }> = {
      "1:1": { width: 1024, height: 1024 },
      "4:3": { width: 1024, height: 768 },
      "3:4": { width: 768, height: 1024 },
      "16:9": { width: 1280, height: 720 },
      "9:16": { width: 720, height: 1280 },
      "3:2": { width: 1152, height: 768 },
      "2:3": { width: 768, height: 1152 },
    };
    if (input.aspectRatio && REPLICATE_SIZES[input.aspectRatio]) {
      return REPLICATE_SIZES[input.aspectRatio];
    }
    return { width: input.width ?? 1024, height: input.height ?? 1024 };
  }

  /**
   * Dedicated face-swap submit — пара картинок, без prompt. Отдельная ветка,
   * т.к. cdingram/face-swap принимает input_image + swap_image и ничего больше.
   */
  private async submitFaceSwap(modelStr: string, input: ImageInput): Promise<string> {
    const edit = input.mediaInputs?.edit ?? [];
    const sceneUrl = edit[0];
    const faceUrl = edit[1];
    if (!sceneUrl || !faceUrl) {
      throw new UserFacingError("Face swap needs two images (scene + face)", {
        key: "mediaSlotExpired",
      });
    }
    // Replicate не умеет фетчить Telegram/S3 presigned URL напрямую — качаем сами
    // и отдаём Blob (SDK сериализует его в data-URL).
    const toBlob = async (url: string): Promise<Blob | string> => {
      const res = await fetch(url);
      if (!res.ok) return url;
      const buf = await res.arrayBuffer();
      return new Blob([buf], { type: resolveImageMimeType(buf, res.headers.get("content-type")) });
    };
    const [sceneBlob, faceBlob] = await Promise.all([toBlob(sceneUrl), toBlob(faceUrl)]);
    const predInput = { input_image: sceneBlob, swap_image: faceBlob };

    logCall(modelStr, "submit", { input_image: "<blob>", swap_image: "<blob>" });
    const colonIdx = modelStr.indexOf(":");
    const prediction =
      colonIdx !== -1
        ? await this.client.predictions.create({
            version: modelStr.slice(colonIdx + 1),
            input: predInput,
          })
        : await this.client.predictions.create({
            model: modelStr as `${string}/${string}`,
            input: predInput,
          });
    return prediction.id;
  }

  async submit(input: ImageInput): Promise<string> {
    const modelStr = MODEL_IDS[this.modelId] ?? this.modelId;
    if (FACE_SWAP_MODELS.has(this.modelId)) {
      return this.submitFaceSwap(modelStr, input);
    }
    const ms = input.modelSettings ?? {};
    const msExtras: Record<string, unknown> = {};
    if (ms.negative_prompt) msExtras.negative_prompt = ms.negative_prompt;
    else if (input.negativePrompt) msExtras.negative_prompt = input.negativePrompt;
    if (ms.guidance_scale !== undefined) msExtras.guidance_scale = ms.guidance_scale;
    if (ms.cfg !== undefined) msExtras.cfg = ms.cfg;
    if (ms.num_inference_steps !== undefined) msExtras.num_inference_steps = ms.num_inference_steps;
    // Resolve image URL from structured media inputs, falling back to legacy imageUrl.
    // Ideogram models use "style_ref" slot; other models use "edit" slot.
    // Считаем ДО style_preset — чтобы драгнуть style_preset при конфликте с
    // загруженной картинкой (см. ниже).
    const imageUrl = IDEOGRAM_MODELS.has(this.modelId)
      ? (input.mediaInputs?.style_ref?.[0] ?? input.imageUrl)
      : (input.mediaInputs?.edit?.[0] ?? input.imageUrl);
    // Ideogram взаимоисключает `style_preset` / `style_codes` / `style_reference_images` —
    // Replicate отбивает payload с "Please provide just one of ...". UI знает про
    // конфликт style_preset ↔ style_type (через unavailableIf), но НЕ про конфликт
    // style_preset ↔ uploaded reference image. Если юзер загрузил картинку в slot
    // `style_ref` — uploaded-картинка побеждает (это более явное действие чем
    // saved-в-advanced preset), preset молча дропаем с warn'ом.
    const stylePresetRaw =
      ms.style_preset && ms.style_preset !== "None" ? ms.style_preset : undefined;
    const ideogramHasUploadedRef = IDEOGRAM_MODELS.has(this.modelId) && !!imageUrl;
    if (ideogramHasUploadedRef && stylePresetRaw) {
      logger.warn(
        { modelId: this.modelId, stylePreset: stylePresetRaw },
        "Replicate adapter: dropped style_preset because style_ref image present (Ideogram mutex)",
      );
    }
    const stylePreset = ideogramHasUploadedRef ? undefined : stylePresetRaw;
    if (stylePreset) msExtras.style_preset = stylePreset;
    // Ideogram constraint: when style_preset, style_codes, or style_reference_images
    // is used, style_type must be Auto or General. A reference image sent by the
    // user becomes style_reference_images further down, so detect that here too.
    const ideogramHasStyleRef = IDEOGRAM_MODELS.has(this.modelId) && (!!stylePreset || !!imageUrl);
    if (ms.style_type && ms.style_type !== "None") {
      const styleType = ms.style_type as string;
      msExtras.style_type =
        ideogramHasStyleRef && styleType !== "Auto" && styleType !== "General" ? "Auto" : styleType;
    } else if (ideogramHasStyleRef) {
      msExtras.style_type = "Auto";
    }
    if (ms.magic_prompt_option) msExtras.magic_prompt_option = ms.magic_prompt_option;
    if (ms.go_fast !== undefined) msExtras.go_fast = ms.go_fast;
    if (ms.output_format)
      msExtras.output_format = ms.output_format === "jpeg" ? "jpg" : ms.output_format;
    if (ms.output_quality !== undefined) msExtras.output_quality = ms.output_quality;
    // prompt_strength is img2img-only — skip for text-to-image to avoid API rejection.
    // Legacy guard: pre-fix UI allowed prompt_strength=0; Replicate computes effective
    // steps as num_inference_steps × prompt_strength and rejects 0-step jobs (E1000).
    // DB may still hold 0 from before the schema min was raised to 0.1 — substitute
    // on the way out so existing saved settings stop crashing.
    if (ms.prompt_strength !== undefined && imageUrl) {
      if (ms.prompt_strength === 0) {
        logger.warn(
          { modelId: this.modelId },
          "Replicate adapter: clamped legacy prompt_strength=0 to 0.1 (would crash provider)",
        );
        msExtras.prompt_strength = 0.1;
      } else {
        msExtras.prompt_strength = ms.prompt_strength;
      }
    }
    // Schnell sub-model uses ~4 inference steps internally; user-saved num_inference_steps
    // and prompt_strength values are irrelevant and can produce crashes or white noise
    // if stale (e.g. num_inference_steps=1 saved before min was raised). Override with
    // safe explicit values so generation is always predictable regardless of saved state.
    if (ms.model === "schnell") {
      msExtras.num_inference_steps = 4;
      if (imageUrl) msExtras.prompt_strength = 0.8;
    } else if (
      this.modelId === "midjourney" &&
      typeof msExtras.num_inference_steps === "number" &&
      (msExtras.num_inference_steps as number) < 10
    ) {
      msExtras.num_inference_steps = 10;
    }
    if (ms.lora_scale !== undefined) msExtras.lora_scale = ms.lora_scale;
    if (ms.extra_lora !== undefined && ms.extra_lora !== null) {
      // Replicate runtime LoRA-loader принимает только: <owner>/<name>[:version],
      // huggingface.co/..., civitai.com/models/..., либо URL на .safetensors.
      // Все валидные форматы — без whitespace и в пределах ~256 chars. Юзеры
      // регулярно путают поле с «доп. промптом» и вписывают свободный текст —
      // тогда мы платим Replicate за заведомо обречённый predict и юзер ждёт
      // 30s polling'а ради «Ошибка генерации». Up-front guard: rejectim
      // очевидно-не-URL значения сразу. Остальные кривые URL (валидный формат,
      // но неподдерживаемый хост) дойдут до Replicate-rejection — тогда
      // USER_FACING_TEXT_PATTERN в replicate-error.ts смапит на тот же ключ.
      const rawValue = typeof ms.extra_lora === "string" ? ms.extra_lora.trim() : "";
      if (rawValue) {
        if (/\s/.test(rawValue) || rawValue.length > 256) {
          logger.warn(
            {
              modelId: this.modelId,
              extraLoraSample: rawValue.slice(0, 80),
              extraLoraLength: rawValue.length,
            },
            "Replicate adapter: rejected invalid extra_lora value (not a URL/identifier)",
          );
          throw new UserFacingError("Invalid extra_lora value (not a URL/identifier)", {
            key: "loraUrlInvalid",
          });
        }
        msExtras.extra_lora = rawValue;
      }
    }
    if (ms.extra_lora_scale !== undefined) msExtras.extra_lora_scale = ms.extra_lora_scale;
    if (ms.seed != null) msExtras.seed = ms.seed;
    if (ms.disable_safety_checker !== undefined)
      msExtras.disable_safety_checker = ms.disable_safety_checker;
    if (ms.model) msExtras.model = ms.model;
    if (ms.image_size) msExtras.image_size = ms.image_size;
    if (ms.safety_filter_level) msExtras.safety_filter_level = ms.safety_filter_level;
    // Native batch: midjourney/FLUX/SD на Replicate принимают num_outputs (1-4).
    // Берём из num_images (наш единый picker), кэпим по 1..4.
    if (ms.num_images !== undefined) {
      const n = Math.max(1, Math.min(4, Number(ms.num_images) || 1));
      if (n > 1) msExtras.num_outputs = n;
    }

    const useDirectAspectRatio =
      DIRECT_ASPECT_RATIO_MODELS.has(this.modelId) || IDEOGRAM_MODELS.has(this.modelId);
    const aspectRatio = input.aspectRatio ?? "1:1";
    // For ideogram: resolution setting overrides aspect_ratio when set
    const resolution =
      IDEOGRAM_MODELS.has(this.modelId) && ms.resolution && ms.resolution !== "None"
        ? (ms.resolution as string)
        : undefined;
    const sizeParams: Record<string, unknown> = resolution
      ? { resolution }
      : useDirectAspectRatio
        ? aspectRatio === "custom"
          ? { width: ms.width ?? 1024, height: ms.height ?? 1024 }
          : { aspect_ratio: aspectRatio }
        : this.resolveSize(input);

    // Download image(s) and pass as Blob — Replicate cannot fetch Telegram/S3 presigned URLs directly.
    let imageParam: Record<string, unknown> = {};
    if (IDEOGRAM_MODELS.has(this.modelId)) {
      // Ideogram: support multiple style reference images from the style_ref slot
      const styleRefUrls = input.mediaInputs?.style_ref ?? (imageUrl ? [imageUrl] : []);
      if (styleRefUrls.length > 0) {
        const blobs = await Promise.all(
          styleRefUrls.map(async (url) => {
            const imgRes = await fetch(url);
            if (imgRes.ok) {
              const imgBuf = await imgRes.arrayBuffer();
              const mimeType = resolveImageMimeType(imgBuf, imgRes.headers.get("content-type"));
              return new Blob([imgBuf], { type: mimeType });
            }
            return url; // fallback to URL
          }),
        );
        imageParam = { style_reference_images: blobs };
      }
    } else if (imageUrl) {
      const imgRes = await fetch(imageUrl);
      if (imgRes.ok) {
        const imgBuf = await imgRes.arrayBuffer();
        const mimeType = resolveImageMimeType(imgBuf, imgRes.headers.get("content-type"));
        imageParam = { image: new Blob([imgBuf], { type: mimeType }) };
      } else {
        imageParam = { image: imageUrl };
      }
    }

    const predInput = {
      prompt: input.prompt,
      ...sizeParams,
      ...imageParam,
      ...msExtras,
    };

    logCall(modelStr, "submit", predInput);
    // "owner/name:sha256hash" → pass version hash directly (POST /v1/predictions)
    // "owner/name"            → pass as model (POST /v1/models/{owner}/{name}/predictions)
    const colonIdx = modelStr.indexOf(":");
    const prediction =
      colonIdx !== -1
        ? await this.client.predictions.create({
            version: modelStr.slice(colonIdx + 1),
            input: predInput,
          })
        : await this.client.predictions.create({
            model: modelStr as `${string}/${string}`,
            input: predInput,
          });

    return prediction.id;
  }

  async poll(predictionId: string): Promise<ImageResult | ImageResult[] | null> {
    const prediction = await this.client.predictions.get(predictionId);

    if (prediction.status === "succeeded") {
      const output = prediction.output as string[] | string | undefined;
      // Если провайдер вернул массив (native batch с num_outputs > 1) — отдаём
      // ImageResult[]. Image processor уже умеет обрабатывать array (Stage 3
      // mediaGroup + button matrix).
      if (Array.isArray(output)) {
        if (output.length === 0) throw new Error("Replicate returned no image URLs");
        return output.map((url, i) => {
          const urlExt = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "png";
          const contentType =
            urlExt === "jpg" || urlExt === "jpeg" ? "image/jpeg" : `image/${urlExt}`;
          return { url, filename: `${this.modelId}-${i}.${urlExt}`, contentType };
        });
      }
      if (!output) throw new Error("Replicate returned no image URL");
      const urlExt = output.split("?")[0].split(".").pop()?.toLowerCase() ?? "png";
      const contentType = urlExt === "jpg" || urlExt === "jpeg" ? "image/jpeg" : `image/${urlExt}`;
      return { url: output, filename: `${this.modelId}.${urlExt}`, contentType };
    }

    if (prediction.status === "failed" || prediction.status === "canceled") {
      throw parseReplicatePredictionFailure(prediction.error, prediction.status);
    }

    return null; // still processing
  }
}
