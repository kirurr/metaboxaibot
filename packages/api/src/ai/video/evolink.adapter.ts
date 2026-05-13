import type {
  VideoAdapter,
  VideoInput,
  VideoResult,
  VideoValidationError,
} from "./base.adapter.js";
import { config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { classifyAIError } from "../../services/ai-error-classifier.service.js";
import {
  translatePromptRefs,
  buildEvolinkElementPositions,
} from "../../services/prompt-ref-translator.service.js";

const EVOLINK_BASE = "https://api.evolink.ai";

/**
 * Маппинг наших внутренних `modelId` на семейство evolink-моделей и quality.
 *
 * `family` — discriminator выбора endpoint'а:
 *   - "kling-v3-motion-control": ровно одна evolink-модель.
 *   - "kling-o3": в runtime выбираем между `kling-o3-text-to-video` и
 *     `kling-o3-image-to-video` в зависимости от наличия media inputs у задачи.
 *     Pricing у обоих идентичен (per-second × quality × sound), так что
 *     выбор endpoint'а не влияет на биллинг.
 *
 * Motion-control:
 * - kling-motion     → kling-v3-motion-control @ 720p (std)
 * - kling-motion-pro → kling-v3-motion-control @ 1080p (pro)
 *
 * Kling-O3 (auto t2v/i2v):
 * - kling     → kling-o3 family @ 720p (std)
 * - kling-pro → kling-o3 family @ 1080p (pro)
 */
type EvolinkVideoMapping =
  | { family: "kling-v3-motion-control"; quality: "720p" | "1080p" }
  | { family: "kling-o3"; quality: "720p" | "1080p" }
  | { family: "seedance-2.0"; speed: "standard" | "fast" }
  | { family: "seedance-1.5-pro" }
  | { family: "veo-3.1"; tier: "pro" | "fast" };

const EVOLINK_VIDEO_MAP: Record<string, EvolinkVideoMapping> = {
  "kling-motion": { family: "kling-v3-motion-control", quality: "720p" },
  "kling-motion-pro": { family: "kling-v3-motion-control", quality: "1080p" },
  kling: { family: "kling-o3", quality: "720p" },
  "kling-pro": { family: "kling-o3", quality: "1080p" },
  "seedance-2": { family: "seedance-2.0", speed: "standard" },
  "seedance-2-fast": { family: "seedance-2.0", speed: "fast" },
  seedance: { family: "seedance-1.5-pro" },
  veo: { family: "veo-3.1", tier: "pro" },
  "veo-fast": { family: "veo-3.1", tier: "fast" },
};

/** True если у задачи есть хоть один media input (image-source). */
function hasAnyKlingImageInput(mi: Record<string, string[]>, legacyImageUrl?: string): boolean {
  return !!(
    mi.first_frame?.length ||
    mi.last_frame?.length ||
    mi.ref_element_1?.length ||
    mi.ref_element_2?.length ||
    mi.ref_element_3?.length ||
    legacyImageUrl
  );
}

/**
 * Берёт ПЕРВОЕ изображение из каждого `ref_element_*` слота. evolink i2v
 * принимает `image_urls` как массив, который ссылается из prompt'а через
 * `<<<image_N>>>`. Чтобы маппинг с primary KIE'шным `@elementN` syntax'ом
 * был 1:1, кладём по одному representative-изображению на слот:
 *   ref_element_1[0] → image_urls[0] → <<<image_1>>>
 *   ref_element_2[0] → image_urls[1] → <<<image_2>>>
 *   ref_element_3[0] → image_urls[2] → <<<image_3>>>
 * Лимит evolink: image_count + element_count <= 7 (без видео). 3 ≤ 7 — ok.
 */
function flattenRefElementsFirstOnly(mi: Record<string, string[]>): string[] {
  const slots = ["ref_element_1", "ref_element_2", "ref_element_3"];
  return slots.map((key) => mi[key]?.[0]).filter((url): url is string => !!url);
}

interface EvolinkSubmitResponse {
  id?: string;
  status?: string;
  error?: { code?: string; message?: string; type?: string };
}

interface EvolinkTaskResponse {
  id?: string;
  status?: "pending" | "processing" | "completed" | "failed";
  progress?: number;
  results?: string[];
  error?: { code?: string; message?: string; type?: string };
}

/**
 * Evolink video adapter (provider="evolink") — fallback для kling-motion[-pro].
 *
 * Endpoints:
 *  - POST /v1/videos/generations — submit
 *  - GET  /v1/tasks/{task_id}     — poll (общий с image API)
 *
 * Для kling-v3-motion-control обязательны: image_urls (1 ref image) +
 * video_urls (1 ref video, 3-30 sec) + model_params.character_orientation.
 * Длительность результата = длительность ref видео.
 *
 * Билинг (when primary): per-second × актуальная длительность результата.
 * Pricing: 720p $0.12/s, 1080p $0.16/s.
 */
export class EvolinkVideoAdapter implements VideoAdapter {
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

  /**
   * Per-model prompt length limit (in characters). Returns `null` for models
   * without a known evolink-side limit — those skip prompt-length validation.
   *
   * Seedance 2.0 (standard и fast) на стороне Evolink режет промпт по 2000
   * токенов. Эмпирический ratio из 400 ошибки: ~2.32 chars/token (русско-
   * английский смешанный). 4500 символов даёт маржу до ~1940 токенов и
   * предотвращает списание баланса за заведомо проигранную попытку.
   */
  private get promptMaxLength(): number | null {
    if (this.modelId === "seedance-2" || this.modelId === "seedance-2-fast") {
      return 4500;
    }
    return null;
  }

  validateRequest(input: VideoInput): VideoValidationError | null {
    const limit = this.promptMaxLength;
    if (limit !== null && input.prompt && input.prompt.length > limit) {
      return { key: "promptTooLong", params: { limit } };
    }
    return null;
  }

  async submit(input: VideoInput): Promise<string> {
    const mapping = EVOLINK_VIDEO_MAP[this.modelId];
    if (!mapping) {
      throw new Error(`Evolink video: unknown model ${this.modelId}`);
    }

    let body: Record<string, unknown>;
    switch (mapping.family) {
      case "kling-v3-motion-control":
        body = this.buildMotionControlBody(input, mapping);
        break;
      case "kling-o3": {
        const mi = input.mediaInputs ?? {};
        body = hasAnyKlingImageInput(mi, input.imageUrl)
          ? this.buildKlingO3I2VBody(input, mapping)
          : this.buildKlingO3T2VBody(input, mapping);
        break;
      }
      case "seedance-2.0": {
        // Runtime dispatch на 6 моделей (3 mode × 2 speed):
        //   - есть ref_videos / ref_audios / ref_images → reference-to-video
        //   - есть first_frame / last_frame → image-to-video
        //   - нет media → text-to-video
        // Endpoint name: seedance-2.0[-fast]-{text,image,reference}-to-video
        body = this.buildSeedance20Body(input, mapping);
        break;
      }
      case "seedance-1.5-pro": {
        // Один endpoint `seedance-1.5-pro`. Mode auto-detected на стороне
        // evolink по image_urls.length: 0=t2v, 1=i2v, 2=first-last-frame.
        body = this.buildSeedance15ProBody(input);
        break;
      }
      case "veo-3.1": {
        body = this.buildVeoBody(input, mapping);
        break;
      }
      default:
        throw new Error(`Evolink video: unsupported family`);
    }

    const resp = await fetchWithLog(
      `${EVOLINK_BASE}/v1/videos/generations`,
      {
        method: "POST",
        headers: this.jsonHeaders,
        body: JSON.stringify(body),
      },
      this.fetchFn,
    );

    if (!resp.ok) {
      const txt = await resp.text();
      if (resp.status === 400) {
        try {
          const parsed = JSON.parse(txt) as { error?: { code?: string; message?: string } };
          const code = parsed?.error?.code ?? "";
          const msg = parsed?.error?.message ?? "";
          if (code === "invalid_parameter" && /prompt too long/i.test(msg)) {
            throw new UserFacingError(`Evolink prompt too long: ${msg}`, {
              key: "aiClassifiedError",
              params: {
                messageRu: "Промпт слишком длинный — сократите текст и попробуйте снова.",
                messageEn: "Prompt is too long — please shorten your text and try again.",
              },
              notifyOps: false,
            });
          }
        } catch (e) {
          if (e instanceof UserFacingError) throw e;
        }
      }
      const err = new Error(`Evolink video submit error ${resp.status}: ${txt}`) as Error & {
        status?: number;
      };
      err.status = resp.status;
      throw err;
    }

    const data = (await resp.json()) as EvolinkSubmitResponse;
    if (!data.id) {
      throw new Error(`Evolink video submit failed: no task id (${JSON.stringify(data)})`);
    }
    return data.id;
  }

  /**
   * kling-v3-motion-control: image_urls (1) + video_urls (1) + character_orientation.
   * Длительность результата = длительность референсного видео (3-30s).
   */
  private buildMotionControlBody(
    input: VideoInput,
    mapping: Extract<EvolinkVideoMapping, { family: "kling-v3-motion-control" }>,
  ): Record<string, unknown> {
    const ms = input.modelSettings ?? {};
    const mi = input.mediaInputs ?? {};

    const imageUrl = mi.first_frame?.[0] ?? input.imageUrl;
    const videoUrl = mi.motion_video?.[0];
    if (!imageUrl) {
      throw new UserFacingError("Evolink kling-motion: reference image required", {
        key: "klingMotionImageRequired",
      });
    }
    if (!videoUrl) {
      throw new UserFacingError("Evolink kling-motion: reference video required", {
        key: "klingMotionVideoRequired",
      });
    }

    const orientation = (ms.character_orientation as string | undefined) ?? "video";
    const keepSound = ms.keep_sound !== undefined ? !!ms.keep_sound : true;

    const body: Record<string, unknown> = {
      model: "kling-v3-motion-control",
      image_urls: [imageUrl],
      video_urls: [videoUrl],
      model_params: {
        character_orientation: orientation,
        keep_sound: keepSound,
      },
    };
    if (mapping.quality) body.quality = mapping.quality;
    if (input.prompt) body.prompt = input.prompt.slice(0, 2500);
    return body;
  }

  /**
   * kling-o3-image-to-video — fallback для primary kling/kling-pro.
   *
   * Маппинг primary'ных полей:
   *   first_frame[0]                 → image_start
   *   last_frame[0]                  → image_end
   *   ref_element_{1,2,3}[0]         → image_urls[i]   (только первое из каждого слота)
   *   modelSettings.aspect_ratio     → aspect_ratio
   *   modelSettings.duration (3-15)  → duration
   *   modelSettings.generate_audio   → sound: "on"|"off"
   *   prompt @elementN syntax        → <<<image_N>>>
   *
   * `element_list` НЕ используем — требует pre-created elements via отдельного
   * kling-custom-element flow (10+ минут на создание). Для fallback'а
   * реализуем degraded режим через image_urls — см. doc strings flattenRefElementsFirstOnly.
   */
  private buildKlingO3I2VBody(
    input: VideoInput,
    mapping: Extract<EvolinkVideoMapping, { family: "kling-o3" }>,
  ): Record<string, unknown> {
    const ms = input.modelSettings ?? {};
    const mi = input.mediaInputs ?? {};

    const imageStart = mi.first_frame?.[0] ?? input.imageUrl;
    const imageEnd = mi.last_frame?.[0];
    const refImages = flattenRefElementsFirstOnly(mi);
    const elementPositions = buildEvolinkElementPositions(mi);
    let remappedPrompt = input.prompt
      ? translatePromptRefs(input.prompt, { dialect: "evolink", elementPositions })
      : undefined;

    // Evolink reject'ит `image_end` (он же "end_frame") когда total image count > 2:
    //   "end_frame is not supported when image count exceeds 2 (current: 3 images)"
    // Total = (image_start ? 1 : 0) + (image_end ? 1 : 0) + image_urls.length.
    // При fallback'е с KIE на kling-o3 у задачи могут быть одновременно
    // first_frame + last_frame + ref_element_* — суммарно 3+ кадров.
    // Workaround: last_frame не передаём как `image_end`, а добавляем его в
    // `image_urls` и инструктируем модель завершить видео последним кадром
    // через текстовый суффикс к промпту. Инструкцию шлём по-английски —
    // надёжнее для kling, не зависит от языка пользовательского промпта.
    const totalImages = (imageStart ? 1 : 0) + (imageEnd ? 1 : 0) + refImages.length;
    let useImageEndField = !!imageEnd;
    let effectiveRefImages = refImages;
    if (imageEnd && totalImages > 2) {
      useImageEndField = false;
      effectiveRefImages = [...refImages, imageEnd];
      const suffix = "End the video with the last reference image as the final frame.";
      remappedPrompt = remappedPrompt ? `${remappedPrompt}\n\n${suffix}` : suffix;
    }

    const aspectRatio = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio;
    const rawDuration = ms.duration ?? input.duration ?? 5;
    const duration = Math.max(3, Math.min(15, Math.round(Number(rawDuration) || 5)));
    // Primary kling settings: generate_audio (toggle, default true).
    // evolink: sound enum "on"|"off", default "off". Маппим явно по ms-значению.
    const sound = ms.generate_audio === false ? "off" : "on";

    const body: Record<string, unknown> = {
      model: "kling-o3-image-to-video",
      duration,
      sound,
    };
    if (remappedPrompt) body.prompt = remappedPrompt.slice(0, 2500);
    if (imageStart) body.image_start = imageStart;
    if (useImageEndField && imageEnd) body.image_end = imageEnd;
    if (effectiveRefImages.length > 0) body.image_urls = effectiveRefImages;
    if (aspectRatio && aspectRatio !== "auto") body.aspect_ratio = aspectRatio;
    if (mapping.quality) body.quality = mapping.quality;
    return body;
  }

  /**
   * kling-o3-text-to-video — pure text-driven path, fallback к primary kling
   * когда у задачи нет ни первого/последнего кадра, ни ref_element_*.
   *
   * Pricing идентичен i2v (per-second × quality × sound), так что выбор
   * endpoint'а не влияет на биллинг.
   *
   * Маппинг primary'ных полей:
   *   modelSettings.aspect_ratio     → aspect_ratio (default 16:9)
   *   modelSettings.duration (3-15)  → duration
   *   modelSettings.generate_audio   → sound: "on"|"off"
   *
   * Note: t2v endpoint не имеет `image_urls`. @elementN syntax в prompt'е
   * остаётся literal (некуда мапить) — evolink увидит просто текст.
   */
  private buildKlingO3T2VBody(
    input: VideoInput,
    mapping: Extract<EvolinkVideoMapping, { family: "kling-o3" }>,
  ): Record<string, unknown> {
    const ms = input.modelSettings ?? {};
    const aspectRatio = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio;
    const rawDuration = ms.duration ?? input.duration ?? 5;
    const duration = Math.max(3, Math.min(15, Math.round(Number(rawDuration) || 5)));
    const sound = ms.generate_audio === false ? "off" : "on";

    const body: Record<string, unknown> = {
      model: "kling-o3-text-to-video",
      duration,
      sound,
    };
    if (input.prompt) body.prompt = input.prompt.slice(0, 2500);
    // t2v требует aspect_ratio из enum {16:9, 9:16, 1:1}; если "auto" или не
    // задан — fall back на 16:9 (default по доке).
    body.aspect_ratio = aspectRatio && aspectRatio !== "auto" ? aspectRatio : "16:9";
    if (mapping.quality) body.quality = mapping.quality;
    return body;
  }

  async poll(taskId: string): Promise<VideoResult | null> {
    const resp = await fetchWithLog(
      `${EVOLINK_BASE}/v1/tasks/${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
      this.fetchFn,
    );

    if (!resp.ok) {
      const txt = await resp.text();
      const err = new Error(`Evolink video poll error ${resp.status}: ${txt}`) as Error & {
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

    const rawUrl = data.results?.[0];
    if (!rawUrl) throw new Error("Evolink: no video URL in completed task");

    // Evolink для Veo (`veo`/`veo-fast`) отдаёт `gs://BUCKET/KEY` вместо HTTPS,
    // в отличие от остальных моделей (kling/seedance) с http(s)-CDN URL'ами.
    // Их `gcs_uris` приходит в публичный бакет `evolink-video-ev02-*` с
    // anonymous read — поэтому простой rewrite на стандартный GCS HTTPS
    // endpoint работает без auth. Если в будущем сделают приватным, увидим
    // 403 от storage.googleapis.com и переключимся на signed URL / fetchBuffer
    // с GCS auth.
    const url = rawUrl.startsWith("gs://")
      ? `https://storage.googleapis.com/${rawUrl.slice("gs://".length)}`
      : rawUrl;

    return { url, filename: `${this.modelId}.mp4` };
  }

  /**
   * Seedance 2.0 — runtime dispatch между 6 evolink моделями (3 mode × 2 speed).
   *
   * Endpoint name: `seedance-2.0[-fast]-{text|image|reference}-to-video`.
   *
   * Маппинг наших mediaInputs → evolink:
   *   first_frame[0] (+ last_frame[0])  → i2v image_urls (1-2)
   *   ref_images                         → r2v image_urls (0-9)
   *   ref_videos                         → r2v video_urls (0-3)
   *   ref_audios                         → r2v audio_urls (0-3)
   *
   * Dispatch:
   *   - any of ref_videos/ref_audios/ref_images present → r2v
   *   - first_frame or last_frame present → i2v (1-2 images)
   *   - nothing → t2v
   *
   * Settings:
   *   modelSettings.duration              → duration (4-15)
   *   modelSettings.resolution            → quality (480p/720p/1080p)
   *   modelSettings.aspect_ratio          → aspect_ratio ("auto" → "adaptive")
   *   modelSettings.generate_audio        → generate_audio (free of charge)
   *   modelSettings.enable_web_search     → model_params.web_search (только t2v)
   */
  private buildSeedance20Body(
    input: VideoInput,
    mapping: Extract<EvolinkVideoMapping, { family: "seedance-2.0" }>,
  ): Record<string, unknown> {
    const ms = input.modelSettings ?? {};
    const mi = input.mediaInputs ?? {};

    const firstFrame = mi.first_frame?.[0];
    const lastFrame = mi.last_frame?.[0];
    const refImages = mi.ref_images ?? [];
    const refVideos = mi.ref_videos ?? [];
    const refAudios = mi.ref_audios ?? [];

    const hasR2VInputs = refImages.length > 0 || refVideos.length > 0 || refAudios.length > 0;
    const hasI2VFrames = !!(firstFrame || lastFrame);

    let mode: "text-to-video" | "image-to-video" | "reference-to-video";
    if (hasR2VInputs) mode = "reference-to-video";
    else if (hasI2VFrames) mode = "image-to-video";
    else mode = "text-to-video";

    const speedPrefix = mapping.speed === "fast" ? "-fast" : "";
    const evolinkModel = `seedance-2.0${speedPrefix}-${mode}`;

    // duration: integer 4-15
    const rawDuration = (ms.duration as number | undefined) ?? input.duration ?? 5;
    const duration = Math.max(4, Math.min(15, Math.round(Number(rawDuration) || 5)));

    // aspect_ratio: "auto" в наших settings → "adaptive" в evolink
    const arRaw = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio;
    const aspectRatio = arRaw === "auto" ? "adaptive" : arRaw;

    const quality = (ms.resolution as string | undefined) ?? "720p";
    // Fast не поддерживает 1080p — клампим. Стандартный — все три.
    const effectiveQuality = mapping.speed === "fast" && quality === "1080p" ? "720p" : quality;

    const generateAudio = ms.generate_audio !== undefined ? !!ms.generate_audio : true;

    const body: Record<string, unknown> = {
      model: evolinkModel,
      prompt: input.prompt,
      duration,
      quality: effectiveQuality,
      generate_audio: generateAudio,
    };
    if (aspectRatio) body.aspect_ratio = aspectRatio;

    if (mode === "image-to-video") {
      // 1-2 images: [first_frame, last_frame] в порядке.
      const imgs: string[] = [];
      if (firstFrame) imgs.push(firstFrame);
      if (lastFrame) imgs.push(lastFrame);
      body.image_urls = imgs;
    } else if (mode === "reference-to-video") {
      if (refImages.length > 0) body.image_urls = refImages.slice(0, 9);
      if (refVideos.length > 0) body.video_urls = refVideos.slice(0, 3);
      if (refAudios.length > 0) body.audio_urls = refAudios.slice(0, 3);
    }

    // Web search — только t2v (по доке model_params применим только к
    // text-to-video). Передаём только если включён.
    if (mode === "text-to-video" && ms.enable_web_search) {
      body.model_params = { web_search: true };
    }

    return body;
  }

  /**
   * Seedance 1.5 Pro — один evolink endpoint `seedance-1.5-pro`.
   *
   * Mode auto-detected на стороне evolink по `image_urls.length`:
   *   - 0 images → text-to-video
   *   - 1 image  → image-to-video (first frame driven)
   *   - 2 images → first-last-frame (image_urls[0]=first, image_urls[1]=last)
   *
   * Маппинг наших mediaInputs:
   *   first_frame[0] (опц) + last_frame[0] (опц) → image_urls в порядке.
   *
   * Settings:
   *   modelSettings.duration              → duration (4-12)
   *   modelSettings.resolution            → quality (480p / 720p / 1080p)
   *   modelSettings.aspect_ratio          → aspect_ratio (без "auto")
   *   modelSettings.generate_audio        → generate_audio (влияет на цену)
   */
  private buildSeedance15ProBody(input: VideoInput): Record<string, unknown> {
    const ms = input.modelSettings ?? {};
    const mi = input.mediaInputs ?? {};

    const firstFrame = mi.first_frame?.[0] ?? input.imageUrl;
    const lastFrame = mi.last_frame?.[0];

    // duration: integer 4-12
    const rawDuration = (ms.duration as number | undefined) ?? input.duration ?? 5;
    const duration = Math.max(4, Math.min(12, Math.round(Number(rawDuration) || 5)));

    const aspectRatio = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio;
    const quality = (ms.resolution as string | undefined) ?? "720p";
    const generateAudio = ms.generate_audio !== undefined ? !!ms.generate_audio : true;

    const body: Record<string, unknown> = {
      model: "seedance-1.5-pro",
      prompt: input.prompt,
      duration,
      quality,
      generate_audio: generateAudio,
    };
    if (aspectRatio && aspectRatio !== "auto") body.aspect_ratio = aspectRatio;

    // image_urls: [first_frame, last_frame] в порядке. Только непустые.
    const imageUrls: string[] = [];
    if (firstFrame) imageUrls.push(firstFrame);
    if (lastFrame) imageUrls.push(lastFrame);
    if (imageUrls.length > 0) body.image_urls = imageUrls;

    return body;
  }

  /**
   * Veo 3.1 Pro / Fast — endpoint `/v1/videos/generations` с разными значениями
   * `model`. Все продвинутые параметры поддерживаются (генерация людей, audio,
   * negative prompt, resize_mode, seed, callback_url).
   *
   * Generation modes (auto-detect по media-inputs):
   *   - REFERENCE: есть `mediaInputs.reference` — fixed 8s, fixed 16:9, advanced
   *     params kроме `generate_audio` игнорируются (по докам evolink).
   *   - FIRST&LAST: есть `first_frame` или `last_frame` — 1-2 кадра.
   *   - TEXT: ничего не загружено.
   *
   * Settings mapping:
   *   modelSettings.aspect_ratio   → aspect_ratio (auto / 16:9 / 9:16)
   *   modelSettings.duration       → duration (4 / 6 / 8). REFERENCE → 8.
   *   modelSettings.resolution     → quality (720p / 1080p / 4k)
   *   modelSettings.generate_audio → generate_audio (boolean, default true)
   *   modelSettings.person_generation → person_generation (allow_adult / dont_allow)
   *   modelSettings.resize_mode    → resize_mode (pad / crop) — только для I2V (FIRST&LAST)
   *   modelSettings.negative_prompt → negative_prompt
   *   modelSettings.seed            → seed
   */
  private buildVeoBody(
    input: VideoInput,
    mapping: Extract<EvolinkVideoMapping, { family: "veo-3.1" }>,
  ): Record<string, unknown> {
    const ms = input.modelSettings ?? {};
    const mi = input.mediaInputs ?? {};

    const firstFrame = mi.first_frame?.[0] ?? input.imageUrl;
    const lastFrame = mi.last_frame?.[0];
    const refs = (mi.reference ?? []).slice(0, 3);

    let generationType: "TEXT" | "FIRST&LAST" | "REFERENCE";
    let imageUrls: string[] = [];
    if (refs.length > 0) {
      generationType = "REFERENCE";
      imageUrls = refs;
    } else if (firstFrame || lastFrame) {
      generationType = "FIRST&LAST";
      const frames: string[] = [];
      if (firstFrame) frames.push(firstFrame);
      if (lastFrame) frames.push(lastFrame);
      imageUrls = frames;
    } else {
      generationType = "TEXT";
    }

    const evolinkModel =
      mapping.tier === "pro" ? "veo-3.1-generate-preview" : "veo-3.1-fast-generate-preview";

    const body: Record<string, unknown> = {
      model: evolinkModel,
      prompt: input.prompt?.slice(0, 2000),
      generation_type: generationType,
    };
    if (imageUrls.length > 0) body.image_urls = imageUrls;

    // generate_audio — единственный advanced param который остаётся в REFERENCE
    // mode (по докам evolink). default true — KIE/evolink дефолт совпадают.
    const generateAudio = ms.generate_audio !== undefined ? !!ms.generate_audio : true;
    body.generate_audio = generateAudio;

    if (generationType === "REFERENCE") {
      // REFERENCE: duration fixed 8s, aspect_ratio fixed 16:9; остальные
      // advanced params игнорируются evolink'ом — НЕ шлём чтобы не спровоцировать
      // 400 invalid_request.
      body.duration = 8;
      body.aspect_ratio = "16:9";
      return body;
    }

    // TEXT и FIRST&LAST — все advanced params поддерживаются.
    const aspectRatio = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio ?? "16:9";
    body.aspect_ratio = aspectRatio;

    const rawDuration = (ms.duration as number | undefined) ?? input.duration ?? 4;
    const duration = [4, 6, 8].includes(Number(rawDuration)) ? Number(rawDuration) : 4;
    body.duration = duration;

    const quality = (ms.resolution as string | undefined) ?? "720p";
    body.quality = quality;

    if (ms.person_generation === "allow_adult" || ms.person_generation === "dont_allow") {
      body.person_generation = ms.person_generation;
    }

    if (ms.negative_prompt && typeof ms.negative_prompt === "string" && ms.negative_prompt.trim()) {
      body.negative_prompt = ms.negative_prompt.slice(0, 2000);
    }

    if (typeof ms.seed === "number" && ms.seed > 0 && ms.seed <= 4_294_967_295) {
      body.seed = Math.floor(ms.seed);
    }

    // resize_mode — только в I2V (FIRST&LAST) по докам.
    if (
      generationType === "FIRST&LAST" &&
      (ms.resize_mode === "pad" || ms.resize_mode === "crop")
    ) {
      body.resize_mode = ms.resize_mode;
    }

    return body;
  }

  /**
   * Маппит task-level evolink ошибки (см. docs/schema/evolink/errors.md) в
   * UserFacingError либо в generic Error со status'ом для классификации в
   * upstream rate-limit handlers. Логика идентична image-адаптеру.
   */
  private async handleTaskFailure(
    error: { code?: string; message?: string } | undefined,
  ): Promise<never> {
    const code = error?.code ?? "unknown_error";
    const message = error?.message ?? "unknown error";
    const technicalMessage = `Evolink ${this.modelId} generation failed: ${code} ${message}`;

    switch (code) {
      case "content_policy_violation": {
        if (/public figure|public person|prominent figure|celebrity/i.test(message)) {
          throw new UserFacingError(technicalMessage, { key: "publicFigureViolation" });
        }
        if (/copyright|trademark|third-party|logo/i.test(message)) {
          throw new UserFacingError(technicalMessage, { key: "copyrightViolation" });
        }
        throw new UserFacingError(technicalMessage, { key: "contentPolicyViolation" });
      }

      case "invalid_parameters": {
        // Для seedance-2 / seedance-2-fast чаще всего invalid_parameters
        // прилетает из-за reference-видео, которое не прошло наши upload-side
        // constraints (например, видео было загружено ДО появления валидации,
        // или прошло через legacy-канал без metadata). Конкретизируем подсказку,
        // чтобы юзер понимал куда смотреть — generic Evolink message «check
        // resolution, duration, prompt length» не информативен.
        const isSeedance2 = this.modelId === "seedance-2" || this.modelId === "seedance-2-fast";
        if (isSeedance2) {
          throw new UserFacingError(technicalMessage, {
            key: "aiClassifiedError",
            params: {
              messageRu:
                "Параметры запроса не подходят Seedance 2.0. Проверьте reference-видео: длительность 2–15 с (суммарно ≤15 с), разрешение 480p–1080p, кадр ≤2.08 МП (Full HD), размер ≤50 МБ, формат mp4/mov. Картинки: 300–6000 px, ratio 1:2.5–2.5:1, ≤30 МБ.",
              messageEn:
                "Request parameters not accepted by Seedance 2.0. Check reference video: 2–15 s (total ≤15 s), 480p–1080p, ≤2.08 MP per frame (Full HD), ≤50 MB, mp4/mov. Images: 300–6000 px, ratio 1:2.5–2.5:1, ≤30 MB.",
            },
            notifyOps: true,
          });
        }
        throw new UserFacingError(technicalMessage, {
          key: "aiClassifiedError",
          params: {
            messageRu: `Параметры запроса не подходят модели: ${message.slice(0, 200)}`,
            messageEn: `Request parameters not accepted by model: ${message.slice(0, 200)}`,
          },
          notifyOps: true,
        });
      }

      case "image_processing_error":
      case "image_dimension_mismatch": {
        throw new UserFacingError(technicalMessage, {
          key: "aiClassifiedError",
          params: {
            messageRu:
              "Не удалось обработать загруженное изображение. Требования: jpg/png, ≥300px, соотношение от 1:2.5 до 2.5:1, ≤10 МБ.",
            messageEn:
              "Failed to process uploaded image. Requirements: jpg/png, ≥300px, aspect 1:2.5–2.5:1, ≤10 MB.",
          },
          notifyOps: false,
        });
      }

      case "request_cancelled": {
        throw new Error(technicalMessage);
      }

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
        throw new UserFacingError(technicalMessage, {
          key: "aiClassifiedError",
          params: {
            messageRu:
              "Модель не смогла сгенерировать видео. Попробуйте другие референсы или уточните промпт.",
            messageEn: "Model could not generate. Try different references or refine prompt.",
          },
          notifyOps: false,
        });
      }

      case "quota_exceeded":
      case "resource_exhausted": {
        const err = new Error(technicalMessage) as Error & { status?: number };
        err.status = 429;
        throw err;
      }

      case "service_error":
      case "service_unavailable":
      case "generation_timeout": {
        const err = new Error(technicalMessage) as Error & { status?: number };
        err.status = 503;
        throw err;
      }

      case "resource_not_found": {
        throw new Error(technicalMessage);
      }

      case "unknown_error":
      default: {
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
