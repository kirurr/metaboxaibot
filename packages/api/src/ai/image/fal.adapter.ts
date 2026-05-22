import { fal } from "@fal-ai/client";
import sharp from "sharp";
import type { ImageAdapter, ImageInput, ImageResult } from "./base.adapter.js";
import { config, UserFacingError } from "@metabox/shared";
import { logCall } from "../../utils/fetch.js";

/**
 * fal virtual-try-on endpoint. Unlike the generic `image_urls` + `prompt`
 * edit endpoints, it takes named `person_image_url` / `clothing_image_url`
 * and no prompt — handled by a dedicated submit branch.
 */
const VIRTUAL_TRYON_ENDPOINT = "fal-ai/image-apps-v2/virtual-try-on";

/**
 * virtual-try-on `aspect_ratio` enum — у endpoint'а нет "auto", поэтому под
 * фото человека подбираем ближайший по значению ratio.
 */
const TRYON_RATIOS: Array<{ ratio: string; value: number }> = [
  { ratio: "9:16", value: 9 / 16 },
  { ratio: "3:4", value: 3 / 4 },
  { ratio: "1:1", value: 1 },
  { ratio: "4:3", value: 4 / 3 },
  { ratio: "16:9", value: 16 / 9 },
];
/** Дефолт, когда фото человека не удалось скачать/декодировать. */
const TRYON_RATIO_FALLBACK = "3:4";

/** Text-to-image endpoint for each model. */
const T2I_ENDPOINTS: Record<string, string> = {
  flux: "fal-ai/flux-2",
  "flux-pro": "fal-ai/flux-2-pro",
  "stable-diffusion": "fal-ai/stable-diffusion-v3-medium",
  "seedream-5": "fal-ai/bytedance/seedream/v5/lite/text-to-image",
  "seedream-4.5": "fal-ai/bytedance/seedream/v4.5/text-to-image",
};

/** Image-to-image (edit) endpoint. Falls back to the T2I endpoint when absent. */
const EDIT_ENDPOINTS: Record<string, string> = {
  "seedream-5": "fal-ai/bytedance/seedream/v5/lite/edit",
  "seedream-4.5": "fal-ai/bytedance/seedream/v4.5/edit",
  "stable-diffusion": "fal-ai/stable-diffusion-v3-medium/image-to-image",
  flux: "fal-ai/flux-2/edit",
  "flux-pro": "fal-ai/flux-2-pro/edit",
  // Замена лица (сценарий «Замена лица», primary). enable_thinking не передаём —
  // fal-дефолт уже true, что и нужно (режим с мышлением, $0.15/MP).
  "face-swap-classic": "fal-ai/hy-wu-edit",
};

/**
 * Models that accept a raw `aspect_ratio` string (e.g. "16:9") instead of
 * the standard FAL `image_size` enum (e.g. "landscape_16_9").
 */
const ASPECT_RATIO_MODELS = new Set<string>();

/**
 * Models that should let the endpoint pick the output size itself
 * (FAL `image_size: "auto"`) — Hy-Wu face swap сохраняет размер базового
 * фото вместо того, чтобы быть приведённым к квадрату/пресету.
 */
const AUTO_SIZE_MODELS = new Set(["face-swap-classic", "clothing-tryon"]);

/**
 * Edit endpoints for these models expect `image_urls` (array) instead of `image_url` (string).
 */
const IMAGE_URLS_ARRAY_MODELS = new Set([
  "flux",
  "flux-pro",
  "seedream-4.5",
  "seedream-5",
  "face-swap-classic",
  "clothing-tryon",
]);

/**
 * Map: modelId → max количество изображений за один call (FAL `num_images`).
 * Скоупим явно: для не-batch endpoint'ов передача неизвестного параметра может
 * быть отклонена FAL-ом или дать неожиданное поведение. Поднимаем cap по схеме
 * каждого endpoint'а:
 *   - flux-2:        num_images 1-4
 *   - seedream v4.5/v5: num_images 1-6
 */
const NATIVE_BATCH_MAX: Record<string, number> = {
  flux: 4,
  "seedream-5": 6,
  "seedream-4.5": 6,
};

/** Separator used to pack endpoint+requestId into a single opaque string. */
const SEP = "||";

/**
 * FAL.ai adapter — async generation (Flux, SD, Seedream, Nano Banana, GPT Image).
 * Uses FAL queue for async submission + polling.
 *
 * The providerJobId returned by submit() encodes both the endpoint and the
 * FAL request_id so that poll() can use the exact same endpoint.
 */
export class FalAdapter implements ImageAdapter {
  readonly isAsync = true;

  // FAL SDK не позволяет per-instance подменять fetch (singleton config),
  // поэтому прокси на MVP не поддерживается — fetchFn принимается ради
  // совместимости с factory, но игнорируется.
  constructor(
    readonly modelId: string,
    apiKey = config.ai.fal,
    _fetchFn?: typeof globalThis.fetch,
    /**
     * Provider-specific fal endpoint. Used when one logical modelId maps to
     * several fal endpoints (e.g. clothing try-on: primary `hy-wu-edit` +
     * fallback `virtual-try-on`) — `EDIT_ENDPOINTS` keyed by modelId can't
     * distinguish them. When set, it's used as the endpoint directly.
     */
    readonly providerModelId?: string,
  ) {
    fal.config({ credentials: apiKey });
  }

  private selectEndpoint(input: ImageInput): string {
    if (this.providerModelId) return this.providerModelId;
    const hasEditMedia = !!(input.mediaInputs?.edit?.length || input.imageUrl);
    if (hasEditMedia && EDIT_ENDPOINTS[this.modelId]) {
      return EDIT_ENDPOINTS[this.modelId];
    }
    return T2I_ENDPOINTS[this.modelId] ?? `fal-ai/${this.modelId}`;
  }

  /**
   * Picks the virtual-try-on `aspect_ratio` closest to the person photo's own
   * dimensions ("auto" isn't an option in the endpoint enum). On any fetch /
   * decode failure falls back to 3:4 (fal's fashion default).
   */
  private async resolveTryOnRatio(personUrl: string): Promise<string> {
    try {
      const res = await fetch(personUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
      if (!meta.width || !meta.height) throw new Error("no dimensions");
      const target = meta.width / meta.height;
      return TRYON_RATIOS.reduce((best, cur) =>
        Math.abs(cur.value - target) < Math.abs(best.value - target) ? cur : best,
      ).ratio;
    } catch {
      return TRYON_RATIO_FALLBACK;
    }
  }

  /**
   * Dedicated submit for fal virtual-try-on — named person/clothing params,
   * no prompt. mediaInputs.edit: [0] = person photo, [1] = clothing photo.
   */
  private async submitVirtualTryOn(endpoint: string, editUrls: string[]): Promise<string> {
    const personUrl = editUrls[0];
    const clothingUrl = editUrls[1];
    if (!personUrl || !clothingUrl) {
      throw new UserFacingError("Virtual try-on needs two images (person + clothing)", {
        key: "mediaSlotExpired",
      });
    }
    // aspect_ratio подбираем под фото человека (editUrls[0]) — endpoint не
    // имеет "auto", поэтому берём ближайший enum к реальному соотношению.
    const ratio = await this.resolveTryOnRatio(personUrl);
    const falInput = {
      person_image_url: personUrl,
      clothing_image_url: clothingUrl,
      aspect_ratio: { ratio },
    };
    logCall(endpoint, "submit", falInput as Record<string, unknown>);
    const { request_id } = await fal.queue.submit(endpoint, { input: falInput });
    return `${endpoint}${SEP}${request_id}`;
  }

  async submit(input: ImageInput): Promise<string> {
    const editUrls = input.mediaInputs?.edit ?? (input.imageUrl ? [input.imageUrl] : []);
    const imageUrl = editUrls[0];
    const endpoint = this.selectEndpoint(input);

    if (endpoint === VIRTUAL_TRYON_ENDPOINT) {
      return this.submitVirtualTryOn(endpoint, editUrls);
    }
    const ms = input.modelSettings ?? {};
    const msExtras: Record<string, unknown> = {};
    if (ms.num_inference_steps !== undefined) msExtras.num_inference_steps = ms.num_inference_steps;
    if (ms.guidance_scale !== undefined) msExtras.guidance_scale = ms.guidance_scale;
    if (ms.seed != null) msExtras.seed = ms.seed;
    if (ms.output_format) msExtras.output_format = ms.output_format;
    if (ms.style) msExtras.style = ms.style;
    if (ms.style_type) msExtras.style_type = ms.style_type;
    if (ms.magic_prompt_option) msExtras.magic_prompt_option = ms.magic_prompt_option;
    if (ms.resolution) msExtras.resolution = ms.resolution;
    if (ms.enable_web_search != null) msExtras.enable_web_search = ms.enable_web_search;
    if (ms.thinking_level) msExtras.thinking_level = ms.thinking_level;
    if (ms.acceleration) msExtras.acceleration = ms.acceleration;
    if (ms.enable_prompt_expansion != null)
      msExtras.enable_prompt_expansion = ms.enable_prompt_expansion;
    // Native batch: FAL endpoint'ы принимают num_images (cap зависит от endpoint'а).
    // Передаём только когда n>1 и только для известных моделей (NATIVE_BATCH_MAX).
    const batchCap = NATIVE_BATCH_MAX[this.modelId];
    if (batchCap !== undefined && ms.num_images !== undefined) {
      const n = Math.max(1, Math.min(batchCap, Number(ms.num_images) || 1));
      if (n > 1) msExtras.num_images = n;
    }

    const useAspectRatio = ASPECT_RATIO_MODELS.has(this.modelId);
    const falInput = {
      prompt: input.prompt,
      negative_prompt: (ms.negative_prompt as string | undefined) || input.negativePrompt,
      ...(AUTO_SIZE_MODELS.has(this.modelId)
        ? { image_size: "auto" }
        : useAspectRatio
          ? { aspect_ratio: input.aspectRatio ?? "1:1" }
          : { image_size: this.resolveSize(input) }),
      ...(imageUrl
        ? IMAGE_URLS_ARRAY_MODELS.has(this.modelId)
          ? { image_urls: editUrls }
          : { image_url: imageUrl }
        : {}),
      ...msExtras,
    };
    logCall(endpoint, "submit", falInput as Record<string, unknown>);
    const { request_id } = await fal.queue.submit(endpoint, { input: falInput });
    // Encode endpoint in the returned ID so poll() uses the correct route.
    return `${endpoint}${SEP}${request_id}`;
  }

  async poll(providerJobId: string): Promise<ImageResult | ImageResult[] | null> {
    const sepIdx = providerJobId.lastIndexOf(SEP);
    const endpoint = providerJobId.slice(0, sepIdx);
    const requestId = providerJobId.slice(sepIdx + SEP.length);

    const status = await fal.queue.status(endpoint, {
      requestId,
      logs: false,
    });

    if (status.status !== "COMPLETED") return null;

    const result = await fal.queue.result(endpoint, { requestId });

    const images = (
      result.data as {
        images?: Array<{
          url: string;
          width?: number;
          height?: number;
          content_type?: string;
          file_name?: string;
        }>;
      }
    ).images;
    if (!images?.length) throw new Error("FAL returned no image URL");

    const toResult = (
      img: {
        url: string;
        width?: number;
        height?: number;
        content_type?: string;
        file_name?: string;
      },
      idx: number,
    ): ImageResult => {
      const contentType = img.content_type ?? "image/png";
      const ext = contentType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
      return {
        url: img.url,
        filename: img.file_name ?? `${this.modelId}-${idx}.${ext}`,
        contentType,
        width: img.width,
        height: img.height,
      };
    };

    // Native batch: вернули N>1 → отдаём массив (image.processor.ts уже умеет
    // multi-output → mediaGroup + button matrix). Для одиночного результата —
    // single ImageResult, чтобы single-output Stage 3 path работал как раньше.
    return images.length > 1 ? images.map(toResult) : toResult(images[0], 0);
  }

  private resolveSize(input: ImageInput): string {
    const FAL_SIZES: Record<string, string> = {
      "1:1": "square_hd",
      "4:3": "landscape_4_3",
      "3:4": "portrait_4_3",
      "16:9": "landscape_16_9",
      "9:16": "portrait_16_9",
    };
    if (input.aspectRatio && FAL_SIZES[input.aspectRatio]) {
      return FAL_SIZES[input.aspectRatio];
    }
    if (input.width && input.height) {
      const ratio = input.width / input.height;
      if (ratio > 1.4) return "landscape_16_9";
      if (ratio < 0.7) return "portrait_16_9";
    }
    return "square_hd";
  }
}
