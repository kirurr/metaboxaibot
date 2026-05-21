import type {
  VideoAdapter,
  VideoInput,
  VideoValidationError,
  VideoResult,
} from "./base.adapter.js";
import { AI_MODELS, config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import {
  buildKieUploadName,
  buildKieVideoUploadName,
  uploadFileUrl,
  uploadFileUrlCroppedToAspect,
} from "../../utils/kie-upload.js";
import { KLING_SUPPORTED_ASPECTS } from "../../utils/image-aspect.js";
import { classifyAIError } from "../../services/ai-error-classifier.service.js";
import { translatePromptRefs } from "../../services/prompt-ref-translator.service.js";

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

/**
 * Grok Imagine: separate t2v/i2v endpoints.
 *
 * Two visible models in catalog (см. video.models.ts):
 *   - `grok-imagine`     — text-to-video only, durationRange 6-15s
 *   - `grok-imagine-r2v` — reference-to-video only, durationRange 6-10s
 *
 * Каждый запись маппится на свою пару endpoint'ов; адаптер выбирает t2v vs
 * i2v по runtime mediaInputs (для grok-imagine — всегда t2v, ref_images
 * там просто нет; для grok-imagine-r2v — всегда i2v, ref_images required).
 */
const GROK_MODEL_MAP: Record<string, { t2v: string; i2v: string }> = {
  "grok-imagine": {
    t2v: "grok-imagine/text-to-video",
    i2v: "grok-imagine/image-to-video",
  },
  "grok-imagine-r2v": {
    t2v: "grok-imagine/text-to-video",
    i2v: "grok-imagine/image-to-video",
  },
};

/**
 * Жёсткие лимиты длительности у xAI по режимам. Используется для defensive
 * clamp'а: даже если пользовательский state содержит старое значение
 * больше нового лимита (после миграции с monolithic grok-imagine), мы не
 * отправляем его провайдеру — клампим до max.
 */
const GROK_MAX_DURATION_BY_MODEL: Record<string, number> = {
  "grok-imagine": 15,
  "grok-imagine-r2v": 10,
};

/** Seedance 2.0: single model name for all scenarios. */
const SEEDANCE_MODEL_MAP: Record<string, string> = {
  "seedance-2": "bytedance/seedance-2",
  "seedance-2-fast": "bytedance/seedance-2-fast",
};

/** Kling 3.0 video: std vs pro selected via modelId → `mode` param. */
const KLING_MODEL_MAP: Record<string, "std" | "pro"> = {
  kling: "std",
  "kling-pro": "pro",
};

/** Kling 3.0 motion-control: std vs pro selected via modelId → `mode` param. */
const KLING_MOTION_MODEL_MAP: Record<string, "720p" | "1080p"> = {
  "kling-motion": "720p",
  "kling-motion-pro": "1080p",
};

/**
 * KIE adapter for Grok Imagine video generation.
 *
 * Endpoints:
 *  - POST /api/v1/jobs/createTask   — submit generation task
 *  - GET  /api/v1/jobs/recordInfo?taskId=X — poll task status
 *
 * i2v accepts up to 7 reference images via image_urls.
 * Images from S3/Telegram are re-uploaded through KIE's file upload API
 * to ensure KIE can access them (presigned URLs may expire or be blocked).
 */
export class KieVideoAdapter implements VideoAdapter {
  private readonly apiKeyOverride: string | undefined;
  private readonly fetchFn: typeof globalThis.fetch | undefined;

  constructor(
    readonly modelId: string,
    apiKeyOverride?: string,
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.apiKeyOverride = apiKeyOverride;
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

  private get promptMaxLength(): number {
    if (this.modelId.startsWith("kling")) return 2500;
    if (this.modelId.startsWith("grok-imagine")) return 5000;
    return 20000;
  }

  validateRequest(input: VideoInput): VideoValidationError | null {
    const limit = this.promptMaxLength;
    if (input.prompt && input.prompt.length > limit) {
      return { key: "promptTooLong", params: { limit } };
    }

    return null;
  }

  async submit(input: VideoInput): Promise<string> {
    const ms = input.modelSettings ?? {};
    const mi = input.mediaInputs ?? {};

    const seedanceModel = SEEDANCE_MODEL_MAP[this.modelId];
    const klingMode = KLING_MODEL_MAP[this.modelId];
    const klingMotionMode = KLING_MOTION_MODEL_MAP[this.modelId];
    const inputPayload: Record<string, unknown> = {
      prompt: input.prompt,
    };

    let model: string;

    if (this.modelId === "video-upscale") {
      // ── KIE Topaz Video Upscaler ───────────────────────────────────────────
      // Доступна только через готовый сценарий «Апскейл видео». Промпта нет —
      // upscale_factor приходит из modelSettings (выбор юзера inline-кнопками).
      model = "topaz/video-upscale";
      const srcVideo = mi.motion_video?.[0] ?? input.imageUrl;
      if (!srcVideo) throw new Error("KIE video-upscale: source video is required");
      // fileName с видео-расширением обязателен: без него KIE сохраняет файл
      // extensionless → Topaz не определяет контейнер → `failCode 500`.
      const uploaded = await uploadFileUrl(
        this.apiKey,
        srcVideo,
        buildKieVideoUploadName(srcVideo),
      );
      delete inputPayload.prompt;
      inputPayload.video_url = uploaded;
      inputPayload.upscale_factor = String(ms.upscale_factor ?? "2");
    } else if (klingMotionMode) {
      // ── Kling 3.0 motion-control ──────────────────────────────────────────
      model = "kling-3.0/motion-control";

      const imageUrl = mi.first_frame?.[0] ?? input.imageUrl;
      const videoUrl = mi.motion_video?.[0];
      if (!imageUrl) throw new Error("Kling MC: reference image is required");
      if (!videoUrl) throw new Error("Kling MC: reference video is required");

      const [uploadedImage, uploadedVideo] = await Promise.all([
        uploadFileUrl(this.apiKey, imageUrl, buildKieUploadName(imageUrl)),
        uploadFileUrl(this.apiKey, videoUrl),
      ]);
      inputPayload.input_urls = [uploadedImage];
      inputPayload.video_urls = [uploadedVideo];
      inputPayload.mode = klingMotionMode;

      const orientation = (ms.character_orientation as string | undefined) ?? "video";
      inputPayload.character_orientation = orientation;

      const backgroundSource = (ms.background_source as string | undefined) ?? "input_video";
      inputPayload.background_source = backgroundSource;

      if (!input.prompt) delete inputPayload.prompt;
    } else if (klingMode) {
      // ── Kling 3.0 video ───────────────────────────────────────────────────
      model = "kling-3.0/video";

      const firstFrame = mi.first_frame?.[0] ?? input.imageUrl;
      const lastFrame = mi.last_frame?.[0];

      // KIE Kling 3.0 принимает image_urls=[first] (length 1) ИЛИ
      // image_urls=[first, last] (length 2). Передать только last_frame
      // нельзя — KIE проинтерпретирует одиночный URL как first_frame, и
      // юзер получит видео с обратным направлением. Отказываем сразу.
      if (lastFrame && !firstFrame) {
        throw new UserFacingError("KIE kling: last_frame without first_frame is not supported", {
          key: "klingLastFrameNeedsFirst",
        });
      }

      inputPayload.mode = klingMode;
      const targetAspect = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio ?? "16:9";
      inputPayload.aspect_ratio = targetAspect;

      // Kling 3.0 при наличии image_urls игнорирует aspect_ratio и адаптирует
      // output под dimensions входной картинки (kling3.md §"Aspect Ratio
      // Auto-Adaptation"). Чтобы выбор юзера всегда побеждал, центр-кропаем
      // все картинки попадающие в image_urls под target aspect ПЕРЕД upload —
      // тогда auto-adapt даёт ровно тот ratio, что выбран. Кроп — opt-in
      // (setting `crop_to_aspect`, default OFF): по умолчанию юзер получает
      // прежнее поведение (видео в формате фото), а тогл явно сигнализирует
      // что он готов потерять края кадра ради выбранного aspect. Кропаем
      // только если aspect ∈ KLING_SUPPORTED_ASPECTS: остальные ratio'и
      // ("4:3"/"21:9" и т.п.) Kling всё равно отдаёт 400 — wasted CPU на
      // crop. Для unsupported → uncropped upload (KIE сам ответит 400
      // быстро, без нашей лишней работы).
      const cropEnabled = ms.crop_to_aspect === true;
      const isCroppableAspect = cropEnabled && KLING_SUPPORTED_ASPECTS.includes(targetAspect);
      const uploadForImageUrls = (url: string): Promise<string> =>
        isCroppableAspect
          ? uploadFileUrlCroppedToAspect(this.apiKey, url, targetAspect, buildKieUploadName(url))
          : uploadFileUrl(this.apiKey, url, buildKieUploadName(url));

      // Параллельно — sequential await добавлял бы 1-2с на каждый crop+upload.
      // Promise.all rejected on first failure оставляет второй промис без
      // handler'а → unhandledRejection (в Node 20 default = throw → crash
      // worker'а). Ловим каждую ногу отдельно, аккумулируем первую ошибку,
      // ре-throw после settle обеих. Порядок сохраняем для KIE
      // (index 0 = first frame, index 1 = last frame).
      let frameError: unknown;
      const catchFrame = (p: Promise<string | undefined>): Promise<string | undefined> =>
        p.catch((err) => {
          if (!frameError) frameError = err;
          return undefined;
        });
      const [firstUploaded, lastUploaded] = await Promise.all([
        catchFrame(firstFrame ? uploadForImageUrls(firstFrame) : Promise.resolve(undefined)),
        catchFrame(lastFrame ? uploadForImageUrls(lastFrame) : Promise.resolve(undefined)),
      ]);
      if (frameError) throw frameError;
      const imageUrls: string[] = [firstUploaded, lastUploaded].filter(
        (u): u is string => u !== undefined,
      );

      const durationNum = (ms.duration as number | undefined) ?? input.duration ?? 5;
      inputPayload.duration = String(durationNum);

      const sound = ms.generate_audio !== undefined ? !!ms.generate_audio : true;
      inputPayload.sound = sound;

      inputPayload.multi_shots = false;

      // Element references: up to 3 elements, each 2–4 images.
      // User-uploaded images in ref_element_{1..3} slots become
      // @element1 / @element2 / @element3 referenceable in the prompt.
      //
      // KIE требует non-empty `image_urls` когда в промпте есть @elementN role
      // references. Если у юзера нет first/last_frame, мы подставляем первую
      // картинку первого элемента как заглушку (issue #31). Если frame уже
      // есть — image_urls уже не пустой, заглушка не нужна и переполнит
      // лимит spec'а (max 2 = first+last).
      const hasFrameInImageUrls = imageUrls.length > 0;
      const klingElements: Array<{
        name: string;
        description: string;
        element_input_urls: string[];
      }> = [];
      let placeholderSourceUrl: string | undefined;
      for (let i = 1; i <= 3; i++) {
        const urls = mi[`ref_element_${i}`] ?? [];
        if (urls.length === 0) continue;
        const slice = urls.slice(0, 4);
        // Truthy guard на slice[0] — пустые строки в `ref_element_*` (legacy
        // DB-данные / ошибки upstream-валидации) не должны оседать как
        // placeholderSourceUrl, иначе финальный if (!hasFrame && placeholder)
        // увидит "" как falsy и пропустит push → KIE 422 на @elementN.
        if (slice[0] && !placeholderSourceUrl) placeholderSourceUrl = slice[0];
        const uploaded = await Promise.all(
          slice.map((url) => uploadFileUrl(this.apiKey, url, buildKieUploadName(url))),
        );
        // Spec requires min 2 URLs — duplicate first image when only one is uploaded.
        const elementUrls = uploaded.length >= 2 ? uploaded : [uploaded[0]!, uploaded[0]!];
        klingElements.push({
          name: `element${i}`,
          description: `reference element ${i}`,
          element_input_urls: elementUrls,
        });
      }
      // Заглушка для KIE: если frame нет, но есть elements — кладём ОДНУ
      // картинку (первого элемента) в image_urls. KIE требует non-empty
      // image_urls когда в промпте есть @elementN (issue #31), но дока KIE
      // явно ограничивает массив до 2 entries (first+last frame). При 2-3
      // элементах прежний код пушил N entries и KIE возвращал 422
      // "image_urls supports at most 2 images". Одной заглушки достаточно:
      // KIE интерпретирует image_urls.length === 1 как first frame.
      //
      // Загружаем заглушку отдельно через uploadForImageUrls (с центр-кропом
      // под target aspect): иначе uncropped element image в image_urls
      // ретриггерит Kling auto-adapt — output подгонится под dimensions
      // оригинала элемента, и aspect_ratio юзера снова потеряется.
      if (!hasFrameInImageUrls && placeholderSourceUrl) {
        imageUrls.push(await uploadForImageUrls(placeholderSourceUrl));
      }
      if (klingElements.length) inputPayload.kling_elements = klingElements;
      if (imageUrls.length) inputPayload.image_urls = imageUrls;

      if (input.prompt) {
        inputPayload.prompt = translatePromptRefs(input.prompt, { dialect: "kie" });
      }
    } else if (seedanceModel) {
      // ── Seedance 2.0 / 2.0 Fast ────────────────────────────────────────────
      model = seedanceModel;

      const aspectRatio = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio ?? "16:9";
      inputPayload.aspect_ratio = aspectRatio === "auto" ? "adaptive" : aspectRatio;

      const duration = (ms.duration as number | undefined) ?? input.duration ?? 5;
      inputPayload.duration = duration;

      const resolution = (ms.resolution as string | undefined) ?? "720p";
      inputPayload.resolution = resolution;

      inputPayload.generate_audio = ms.generate_audio !== undefined ? ms.generate_audio : true;
      // Primary evolink seedance-2 экспонирует enable_web_search setting (только t2v).
      // Когда KIE — fallback, прокидываем выбор юзера (вместо хардкода false).
      inputPayload.web_search = !!ms.enable_web_search;
      inputPayload.nsfw_checker = false;

      // first_frame / last_frame
      const firstFrame = mi.first_frame?.[0] ?? input.imageUrl;
      const lastFrame = mi.last_frame?.[0];
      if (firstFrame)
        inputPayload.first_frame_url = await uploadFileUrl(
          this.apiKey,
          firstFrame,
          buildKieUploadName(firstFrame),
        );
      if (lastFrame)
        inputPayload.last_frame_url = await uploadFileUrl(
          this.apiKey,
          lastFrame,
          buildKieUploadName(lastFrame),
        );

      // Reference slots (multimodal reference-to-video)
      const refImages = mi.ref_images ?? [];
      const refVideos = mi.ref_videos ?? [];
      const refAudios = mi.ref_audios ?? [];
      if (refImages.length) {
        inputPayload.reference_image_urls = await Promise.all(
          refImages
            .slice(0, 9)
            .map((url) => uploadFileUrl(this.apiKey, url, buildKieUploadName(url))),
        );
      }
      if (refVideos.length) {
        inputPayload.reference_video_urls = await Promise.all(
          refVideos.slice(0, 3).map((url) => uploadFileUrl(this.apiKey, url)),
        );
      }
      if (refAudios.length) {
        inputPayload.reference_audio_urls = await Promise.all(
          refAudios.slice(0, 3).map((url) => uploadFileUrl(this.apiKey, url)),
        );
      }
    } else {
      // ── Grok Imagine ────────────────────────────────────────────────────────
      const grokMapping = GROK_MODEL_MAP[this.modelId];
      if (!grokMapping) throw new Error(`KIE: unknown model ${this.modelId}`);

      // Endpoint выбирается ИСКЛЮЧИТЕЛЬНО по modelId (после разделения primary
      // на 2 модели):
      //   - `grok-imagine`     → всегда t2v, ref_images игнорируются (защита
      //     от legacy-state у юзеров, которые до разделения сохранили
      //     ref_images под этим modelId; UI слота больше не показывает).
      //   - `grok-imagine-r2v` → всегда i2v, требует ref_images (required-slot
      //     валидация на стороне бота уже отсеяла пустой случай; адаптер
      //     просто шлёт что есть).
      const isI2V = this.modelId === "grok-imagine-r2v";
      model = isI2V ? grokMapping.i2v : grokMapping.t2v;
      const refImages = mi.ref_images ?? [];
      const legacyImage = input.imageUrl;
      const imageUrls = isI2V
        ? refImages.length > 0
          ? refImages
          : legacyImage
            ? [legacyImage]
            : []
        : [];

      const aspectRatio = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio ?? "16:9";
      inputPayload.aspect_ratio = aspectRatio;
      // Defensive clamp: даже если в state'е лежит старое значение (например,
      // 25s от monolithic grok-imagine до разделения), не превышаем фактический
      // лимит провайдера для текущей модели.
      const rawDuration = (ms.duration as number | undefined) ?? input.duration ?? 6;
      const maxAllowed = GROK_MAX_DURATION_BY_MODEL[this.modelId];
      inputPayload.duration =
        maxAllowed !== undefined ? Math.min(maxAllowed, rawDuration) : rawDuration;
      inputPayload.resolution = (ms.resolution as string | undefined) ?? "480p";
      inputPayload.mode = (ms.mode as string | undefined) ?? "normal";
      inputPayload.nsfw_checker = ms.nsfw_checker !== undefined ? ms.nsfw_checker : false;

      if (isI2V) {
        const uploadedUrls = await Promise.all(
          imageUrls
            .slice(0, 7)
            .map((url) => uploadFileUrl(this.apiKey, url, buildKieUploadName(url))),
        );
        inputPayload.image_urls = uploadedUrls;
      }
    }

    const body = { model, input: inputPayload };

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
      throw new Error(`KIE submit error ${resp.status}: ${txt}`);
    }

    const data = (await resp.json()) as KieSubmitResponse;
    if (data.code !== 200 || !data.data?.taskId) {
      const msg = data.msg ?? "";
      // 402 «Credits insufficient» — KIE-аккаунт пуст. Provider-wide состояние,
      // не вина юзера. Терминальная UserFacingError с ops-alert'ом (balance,
      // дедуп). `submitWithFallback` распознаёт её через `isKieCreditsExhausted`
      // и переключается на fallback-провайдера (если зарегистрирован) — иначе
      // юзер упирался бы в «модель недоступна» пока KIE без денег.
      if (data.code === 402 || /credits? insufficient|balance.*enough|out of credits/i.test(msg)) {
        throw new UserFacingError(
          `KIE credits exhausted (${this.modelId}): ${data.code} — ${msg}`,
          {
            key: "modelTemporarilyUnavailable",
            section: "video",
            params: { modelName: AI_MODELS[this.modelId]?.name ?? this.modelId },
            notifyOps: true,
            opsAlertDedupKey: "kie-credits-exhausted",
            opsAlertChannel: "balance",
          },
        );
      }
      const durationMatch = /video duration must be between (\d+) and (\d+)/i.exec(msg);
      if (durationMatch) {
        throw new UserFacingError(`KIE: ${msg}`, {
          key: "kieVideoDurationOutOfRange",
          params: { min: durationMatch[1], max: durationMatch[2] },
        });
      }
      const dimMatch = /image dimensions must be at least (\d+) pixels/i.exec(msg);
      if (dimMatch) {
        throw new UserFacingError(`KIE: ${msg}`, {
          key: "kieImageTooSmall",
          params: { min: dimMatch[1] },
        });
      }
      const arMatch = /image aspect ratio must be between (\S+) and (\S+)/i.exec(msg);
      if (arMatch) {
        const min = arMatch[1].replace(/[.,;]+$/, "");
        const max = arMatch[2].replace(/[.,;]+$/, "");
        throw new UserFacingError(`KIE: ${msg}`, {
          key: "kieImageAspectRatioOutOfRange",
          params: { min, max },
        });
      }
      // Defensive net: KIE video-моделям (kling и др.) валидируют тип
      // input-картинки по URL extension'у. Передача `fileName` в uploadFileUrl
      // должна это закрывать, но если в input всё-таки приходит реально-
      // неподдерживаемый формат (HEIC/AVIF и т.п.) — показываем юзеру
      // понятный мессадж со списком поддерживаемых форматов вместо generic
      // «generationFailed». notifyOps + dedup: триггер означает, что
      // fileName-fix что-то пропустил — алёртим оператора, но не спамим.
      if (
        /file type not supported|unsupported image format|invalid image format|only [^.]*image formats? are supported/i.test(
          msg,
        )
      ) {
        throw new UserFacingError(`KIE submit failed: ${data.code} — ${msg}`, {
          key: "chatInvalidImage",
          notifyOps: true,
          opsAlertDedupKey: `kie-video-unsupported-format-${this.modelId}`,
        });
      }
      throw new Error(`KIE submit failed: ${data.code} — ${data.msg}`);
    }
    return data.data.taskId;
  }

  async poll(taskId: string): Promise<VideoResult | null> {
    const resp = await fetchWithLog(
      `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
      this.fetchFn,
    );

    if (!resp.ok) throw new Error(`KIE poll error ${resp.status}`);

    const data = (await resp.json()) as KieTaskResponse;
    if (data.code !== 200 || !data.data) {
      throw new Error(`KIE poll failed: ${data.code} — ${data.msg}`);
    }

    const task = data.data;

    if (task.state === "fail") {
      const failMsg = task.failMsg ?? "unknown error";
      const failCode = task.failCode;
      const technicalMessage = `KIE ${this.modelId} generation failed: ${failCode ?? ""} ${failMsg}`;
      // KIE-side инфра-ошибка: 422 + "playground failed"/"task id is blank" →
      // их backend в трауре, но мы передали валидный taskId. Бросаем plain Error
      // (НЕ UserFacingError) чтобы BullMQ ретрайнул и на последней попытке
      // processor через `isKieTransientError` триггернул re-submit на fallback.
      // Без этой ветки ошибка проваливалась в classifyAIError-фолбек, который
      // галлюцинировал юзеру "заполните идентификатор задачи" и спамил ops.
      // Также покрывает 422 с обёрнутым "499 Client Closed Request" — апстрим
      // разорвал коннект, classic transient. См. kie-error.ts:isKieTransientError.
      if (
        failCode === "422" &&
        /playground failed|task id is blank|client closed request/i.test(failMsg)
      ) {
        throw new Error(technicalMessage);
      }
      const isCopyright = failCode === "501" || /copyright/i.test(failMsg);
      // KIE/evolink content moderation: "Request blocked: ... prominent public figure"
      const isPublicFigure = /public figure|public person|prominent figure|celebrity/i.test(
        failMsg,
      );
      const isPolicy =
        failCode === "430" ||
        failCode === "431" ||
        /sensitive|restrict|policy|prohibited|nsfw|violat|inappropriate|safety|content moderation|blocked|(prompt|request|input|content) (was |is )?rejected|failed (?:the )?review/i.test(
          failMsg,
        );
      // Kling Motion: ошибки про невалидное reference-фото. Включают:
      //  - "Image recognition failed. ... No complete upper body detected ..."
      //  - "The input was rejected, The character in the reference image or
      //     the first frame of the motion video is invalid."
      //  - "whole body" / "upper body is clearly visible" advisories
      // Юзер должен загрузить другое фото — детерминированный hardcoded message
      // лучше чем gpt-5-nano AI-classifier (который варьирует от запуска к запуску
      // и тригерит лишний ops alert через notifyOps:true).
      const isKlingImageRecognitionFailed =
        /image recognition failed|upper body (detected|is clearly visible)|whole body|character in the (reference image|first frame|motion video).*invalid|the input was rejected/i.test(
          failMsg,
        );
      if (isKlingImageRecognitionFailed) {
        throw new UserFacingError(technicalMessage, {
          key: "klingMotionImageRecognitionFailed",
        });
      }
      // Generic "model couldn't generate for this prompt" — провайдер (Gemini
      // через KIE и т.п.) шлёт 500 с message о том что нужно переформулировать.
      // User-facing, не tech 5xx — не попадает в poll-stage fallback re-submit.
      // Также ловим случаи когда модель вернула chat-style ответ вместо результата
      // (кириллица в failMsg = upstream chat-режим, легитимные ошибки KIE на английском).
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

    // resultJson: '{"resultUrls":["https://..."]}'
    if (!task.resultJson) throw new Error("KIE: no resultJson in completed task");
    const result = JSON.parse(task.resultJson) as { resultUrls?: string[] };
    const url = result.resultUrls?.[0];
    if (!url) throw new Error("KIE: no video URL in resultJson");

    return { url, filename: `${this.modelId}.mp4` };
  }
}
