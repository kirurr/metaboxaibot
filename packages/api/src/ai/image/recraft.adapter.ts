import type { ImageAdapter, ImageInput, ImageResult } from "./base.adapter.js";
import { config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { resolveImageMimeType } from "../../utils/mime-detect.js";
import { providerHttpError } from "../../utils/rate-limit-error.js";

const RECRAFT_API_BASE = "https://external.api.recraft.ai/v1";

/** Maps our internal model IDs to Recraft API model IDs. */
const MODEL_MAP: Record<string, string> = {
  "recraft-v3": "recraftv3",
  "recraft-v4": "recraftv4",
  "recraft-v4-pro": "recraftv4_pro",
  "recraft-v4-vector": "recraftv4_vector",
  "recraft-v4-pro-vector": "recraftv4_pro_vector",
};

/** Maps aspect ratios to Recraft V3 pixel dimensions. */
const SIZE_MAP_V3: Record<string, string> = {
  "1:1": "1024x1024",
  "4:3": "1365x1024",
  "3:4": "1024x1365",
  "16:9": "1820x1024",
  "9:16": "1024x1820",
  "5:4": "1280x1024",
  "4:5": "1024x1280",
};

/** Maps aspect ratios to Recraft V4 / V4-vector pixel dimensions (~1MP). */
const SIZE_MAP_V4: Record<string, string> = {
  "1:1": "1024x1024",
  "2:1": "1536x768",
  "1:2": "768x1536",
  "3:2": "1280x832",
  "2:3": "832x1280",
  "4:3": "1216x896",
  "3:4": "896x1216",
  "5:4": "1152x896",
  "4:5": "896x1152",
  "6:10": "832x1344",
  "14:10": "1280x896",
  "10:14": "896x1280",
  "16:9": "1344x768",
  "9:16": "768x1344",
};

/** Maps aspect ratios to Recraft V4-Pro / V4-Pro-vector pixel dimensions (~4MP). */
const SIZE_MAP_V4_PRO: Record<string, string> = {
  "1:1": "2048x2048",
  "2:1": "3072x1536",
  "1:2": "1536x3072",
  "3:2": "2560x1664",
  "2:3": "1664x2560",
  "4:3": "2432x1792",
  "3:4": "1792x2432",
  "5:4": "2304x1792",
  "4:5": "1792x2304",
  "6:10": "1664x2688",
  "14:10": "2560x1792",
  "10:14": "1792x2560",
  "16:9": "2688x1536",
  "9:16": "1536x2688",
};

/** Models that produce vector output. */
const VECTOR_MODELS = new Set(["recraft-v4-vector", "recraft-v4-pro-vector"]);

const RECRAFT_IMG2IMG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const RECRAFT_IMG2IMG_MAX_MP = 16_000_000; // 16 megapixels
const RECRAFT_IMG2IMG_MAX_DIM = 4096; // pixels

/**
 * Reads just enough bytes from a Blob to extract width/height for PNG and JPEG.
 * Returns null if the format is unrecognised or dimensions can't be found.
 */
async function readImageDimensions(blob: Blob): Promise<{ width: number; height: number } | null> {
  // PNG: 8-byte signature + IHDR chunk (4 len + 4 type + 4 width + 4 height = 24 bytes total)
  const header = await blob.slice(0, 24).arrayBuffer();
  const v = new DataView(header);

  // PNG signature: 137 80 78 71 13 10 26 10
  if (
    v.byteLength >= 24 &&
    v.getUint8(0) === 0x89 &&
    v.getUint8(1) === 0x50 &&
    v.getUint8(2) === 0x4e &&
    v.getUint8(3) === 0x47
  ) {
    return { width: v.getUint32(16, false), height: v.getUint32(20, false) };
  }

  // JPEG: scan for SOF marker (FF C0/C1/C2) within first 64 KB
  if (v.byteLength >= 2 && v.getUint8(0) === 0xff && v.getUint8(1) === 0xd8) {
    const scanSize = Math.min(blob.size, 65536);
    const buf = await blob.slice(0, scanSize).arrayBuffer();
    const d = new DataView(buf);
    let i = 2;
    while (i + 8 < d.byteLength) {
      if (d.getUint8(i) !== 0xff) break;
      const marker = d.getUint8(i + 1);
      const segLen = d.getUint16(i + 2, false);
      if (marker >= 0xc0 && marker <= 0xc3) {
        // SOF0/SOF1/SOF2: precision(1) height(2) width(2)
        return { width: d.getUint16(i + 7, false), height: d.getUint16(i + 5, false) };
      }
      i += 2 + segLen;
    }
  }

  return null;
}

/**
 * Recraft native API adapter — synchronous generation.
 * Docs: https://www.recraft.ai/docs
 */
export class RecraftAdapter implements ImageAdapter {
  readonly isAsync = false;

  private fetchFn: typeof globalThis.fetch | undefined;
  private apiKeyOverride: string | undefined;

  constructor(
    readonly modelId: string,
    apiKey?: string,
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.apiKeyOverride = apiKey;
    this.fetchFn = fetchFn;
  }

  async generate(input: ImageInput): Promise<ImageResult | ImageResult[]> {
    const apiKey = this.apiKeyOverride ?? config.ai.recraft;
    if (!apiKey) throw new Error("RECRAFT_API_KEY not configured");

    const PROMPT_LIMIT = 1000;
    if (input.prompt && input.prompt.length > PROMPT_LIMIT) {
      throw new UserFacingError(
        `Recraft: prompt too long (${input.prompt.length} > ${PROMPT_LIMIT})`,
        {
          key: "promptTooLong",
          params: { limit: PROMPT_LIMIT },
        },
      );
    }

    const ms = input.modelSettings ?? {};
    const recraftModel = MODEL_MAP[this.modelId] ?? "recraftv4";
    const isVector = VECTOR_MODELS.has(this.modelId);
    const isV3 = this.modelId === "recraft-v3";
    const isV4 = this.modelId.startsWith("recraft-v4");
    const defaultStyle = isVector ? "vector_illustration" : "realistic_image";
    const style = (ms.style as string | undefined) ?? defaultStyle;
    // Native batch: Recraft API параметр `n` (1-6). Возвращает массив data[N].
    // Биллинг per-image — chargePerOutput на модели включён, finalize × K.
    const n = Math.max(1, Math.min(6, Number(ms.num_images) || 1));

    // Build optional controls block (V3 supports artistic_level; all support no_text)
    const controls: Record<string, unknown> = {};
    if (ms.no_text) controls.no_text = true;
    if (isV3 && ms.artistic_level != null) controls.artistic_level = Number(ms.artistic_level);

    let urls: string[];

    const imageUrl = input.mediaInputs?.edit?.[0] ?? input.imageUrl;

    if (imageUrl) {
      // Image-to-image via multipart form
      const imgResp = await fetchWithLog(imageUrl);
      if (!imgResp.ok) throw new Error(`Failed to fetch source image: ${imgResp.status}`);
      const imgBuf = await imgResp.arrayBuffer();
      // Detect actual MIME from magic bytes — S3/Telegram URLs often return application/octet-stream.
      const detectedMime = resolveImageMimeType(imgBuf, imgResp.headers.get("content-type"));
      const blob = new Blob([imgBuf], { type: detectedMime });

      // Recraft imageToImage only accepts raster formats (PNG/JPEG/WebP)
      const isSvgMime = detectedMime === "image/svg+xml";
      const isSvgUrl = imageUrl.split("?")[0].toLowerCase().endsWith(".svg");
      if (isSvgMime || isSvgUrl) {
        throw new UserFacingError(
          "SVG is not supported as a reference image for Recraft img2img.",
          {
            key: "recraftImg2imgSvgUnsupported",
          },
        );
      }

      if (blob.size > RECRAFT_IMG2IMG_MAX_BYTES) {
        throw new UserFacingError("Reference image is too large for Recraft img2img.", {
          key: "recraftImg2imgFileTooLarge",
          params: {
            sizeMb: (blob.size / 1024 / 1024).toFixed(1),
            maxMb: (RECRAFT_IMG2IMG_MAX_BYTES / 1024 / 1024).toFixed(0),
          },
        });
      }
      const dims = await readImageDimensions(blob);
      if (dims) {
        if (dims.width > RECRAFT_IMG2IMG_MAX_DIM || dims.height > RECRAFT_IMG2IMG_MAX_DIM) {
          throw new UserFacingError("Reference image dimensions too large for Recraft img2img.", {
            key: "recraftImg2imgDimensionsTooLarge",
            params: { width: dims.width, height: dims.height, max: RECRAFT_IMG2IMG_MAX_DIM },
          });
        }
        if (dims.width * dims.height > RECRAFT_IMG2IMG_MAX_MP) {
          throw new UserFacingError("Reference image resolution too large for Recraft img2img.", {
            key: "recraftImg2imgResolutionTooLarge",
            params: {
              width: dims.width,
              height: dims.height,
              mp: ((dims.width * dims.height) / 1_000_000).toFixed(1),
            },
          });
        }
      }

      const strength = ms.strength != null ? Number(ms.strength) : 0.5;

      const form = new FormData();
      form.append("image", blob, "input.png");
      form.append("prompt", input.prompt);
      form.append("model", recraftModel);
      if (!isV4) form.append("style", style);
      form.append("strength", String(strength));
      if (n > 1) form.append("n", String(n));
      if (isV3 && ms.substyle) form.append("substyle", ms.substyle as string);
      if (ms.seed != null) form.append("random_seed", String(ms.seed));
      if (Object.keys(controls).length) form.append("controls", JSON.stringify(controls));

      const resp = await fetchWithLog(
        `${RECRAFT_API_BASE}/images/imageToImage`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
        },
        this.fetchFn,
      );
      if (!resp.ok) {
        const txt = await resp.text();
        throw providerHttpError(`Recraft API error ${resp.status}: ${txt}`, resp.status);
      }
      const data = (await resp.json()) as { data: Array<{ url: string }> };
      urls = data.data.map((d) => d.url).filter(Boolean);
    } else {
      // Text-to-image
      const sizeMap = isV3
        ? SIZE_MAP_V3
        : this.modelId.includes("-pro")
          ? SIZE_MAP_V4_PRO
          : SIZE_MAP_V4;
      const size = sizeMap[input.aspectRatio ?? "1:1"] ?? sizeMap["1:1"];
      const body: Record<string, unknown> = {
        prompt: input.prompt,
        model: recraftModel,
        size,
        ...(!isV4 ? { style } : {}),
      };
      if (n > 1) body.n = n;
      if (isV3 && ms.substyle) body.substyle = ms.substyle;
      if (ms.seed != null) body.random_seed = ms.seed;
      if (Object.keys(controls).length) body.controls = controls;

      const resp = await fetchWithLog(
        `${RECRAFT_API_BASE}/images/generations`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        this.fetchFn,
      );
      if (!resp.ok) {
        const txt = await resp.text();
        throw providerHttpError(`Recraft API error ${resp.status}: ${txt}`, resp.status);
      }
      const data = (await resp.json()) as { data: Array<{ url: string }> };
      urls = data.data.map((d) => d.url).filter(Boolean);
    }

    if (!urls.length) throw new Error("Recraft: no image URL in response");
    const ext = isVector ? "svg" : "png";
    // Native batch: при n>1 отдаём массив для multi-output UX (mediaGroup +
    // button matrix). При n=1 — single ImageResult, чтобы не менять поведение
    // single-output Stage 3 path.
    if (urls.length > 1) {
      return urls.map((url, i) => ({ url, filename: `${this.modelId}-${i}.${ext}` }));
    }
    return { url: urls[0], filename: `${this.modelId}.${ext}` };
  }
}
