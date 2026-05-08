import type {
  VideoAdapter,
  VideoInput,
  VideoValidationError,
  VideoResult,
} from "./base.adapter.js";
import { config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { buildKieUploadName, uploadFileUrl } from "../../utils/kie-upload.js";
import { classifyAIError } from "../../services/ai-error-classifier.service.js";

const KIE_BASE = "https://api.kie.ai";

/**
 * Internal modelId → KIE Veo API model name.
 *  - "veo"       (Quality) → veo3
 *  - "veo-fast"  (Fast)    → veo3_fast
 *
 * Veo 3.1 Lite (veo3_lite) пока не используется — нет соответствующей primary
 * модели в каталоге.
 */
const VEO_MODEL_MAP: Record<string, "veo3" | "veo3_fast"> = {
  veo: "veo3",
  "veo-fast": "veo3_fast",
};

interface KieVeoSubmitResponse {
  code: number;
  msg: string;
  data?: { taskId?: string };
}

/**
 * KIE Veo poll response (`GET /api/v1/veo/record-info`).
 *
 * Структура отличается от unified Market-API (`/api/v1/jobs/recordInfo`):
 *  - state выражается через числовой `successFlag` (0/1/2/3), а не строку.
 *  - resultUrls лежит в `data.response.resultUrls` как настоящий array (не JSON-string).
 *  - errors приходят в `data.errorCode` (number) и `data.errorMessage` (string).
 *
 * См. docs/schema/kie/veo31getTask.md.
 */
interface KieVeoPollResponse {
  code: number;
  msg: string;
  data?: {
    taskId: string;
    /**
     * 0 — generating, 1 — success, 2 — failed, 3 — generation failed.
     * Единственный source of truth для state'а.
     */
    successFlag?: 0 | 1 | 2 | 3;
    /** Numeric error code (400 / 500 / 501) when task fails. */
    errorCode?: number | null;
    /** Human-readable error message when task fails. */
    errorMessage?: string | null;
    response?: {
      taskId?: string;
      resultUrls?: string[] | null;
      originUrls?: string[] | null;
      fullResultUrls?: string[] | null;
      resolution?: string;
    };
    /** Legacy field; only on older regular-generation tasks. */
    fallbackFlag?: boolean;
    paramJson?: string;
    completeTime?: number | string;
    createTime?: number | string;
  };
}

/**
 * Adapter для Veo 3.1 через KIE: POST `/api/v1/veo/generate` + polling через
 * `GET /api/v1/veo/record-info`.
 *
 * Modes (см. KIE docs/schema/kie/veo31.md → generationType):
 *  - TEXT_2_VIDEO                     — no images
 *  - FIRST_AND_LAST_FRAMES_2_VIDEO    — 1 image (first frame) или 2 (first+last)
 *  - REFERENCE_2_VIDEO                — 1-3 reference images, ТОЛЬКО veo3_fast
 *
 * Ограничения KIE:
 *  - 4K требует extra credits, и (по докам) использует отдельный 4K endpoint —
 *    но в схеме `/api/v1/veo/generate` resolution принимает 720p/1080p/4k,
 *    поэтому шлём как обычно. Если KIE откажет — поправим.
 *  - Длительность не настраивается через payload (всегда ~8s output).
 */
export class KieVeoAdapter implements VideoAdapter {
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

  private get apiModel(): "veo3" | "veo3_fast" {
    return VEO_MODEL_MAP[this.modelId] ?? "veo3_fast";
  }

  validateRequest(input: VideoInput): VideoValidationError | null {
    if (input.prompt && input.prompt.length > 5000) {
      return { key: "promptTooLong", params: { limit: 5000 } };
    }
    return null;
  }

  async submit(input: VideoInput): Promise<string> {
    const ms = input.modelSettings ?? {};
    const mi = input.mediaInputs ?? {};

    const firstFrame = mi.first_frame?.[0] ?? input.imageUrl;
    const lastFrame = mi.last_frame?.[0];
    const refs = (mi.reference ?? []).slice(0, 3);

    // Mode selection. REFERENCE_2_VIDEO — Fast-only по докам KIE: на Quality
    // (`veo3`) этот режим в принципе недоступен в UI (mediaInputs Quality
    // модели не включает MI_REFERENCE_VEO), так что refs тут оказаться не
    // должны. Если всё же пришли (legacy data / mismatched fallback) — игнор,
    // используем first_frame/last_frame как обычный i2v.
    let generationType: "TEXT_2_VIDEO" | "FIRST_AND_LAST_FRAMES_2_VIDEO" | "REFERENCE_2_VIDEO";
    let imageUrls: string[] = [];

    if (refs.length > 0 && this.apiModel === "veo3_fast") {
      generationType = "REFERENCE_2_VIDEO";
      imageUrls = refs;
    } else if (firstFrame || lastFrame) {
      generationType = "FIRST_AND_LAST_FRAMES_2_VIDEO";
      const frames: string[] = [];
      if (firstFrame) frames.push(firstFrame);
      if (lastFrame) frames.push(lastFrame);
      imageUrls = frames;
    } else {
      generationType = "TEXT_2_VIDEO";
    }

    // Аплоадим в KIE storage. KIE требует чтобы image URLs были accessible —
    // S3-presigned могут истекать или быть заблокированы по IP. Через KIE
    // file upload получаем стабильные URL'ы.
    const uploadedImageUrls = imageUrls.length
      ? await Promise.all(
          imageUrls.map((url) => uploadFileUrl(this.apiKey, url, buildKieUploadName(url))),
        )
      : [];

    const aspectRatio = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio ?? "16:9";
    const resolution = (ms.resolution as string | undefined) ?? "720p";

    const payload: Record<string, unknown> = {
      prompt: input.prompt,
      model: this.apiModel,
      generationType,
      aspect_ratio: aspectRatio,
      resolution,
      enableTranslation: true,
    };
    if (uploadedImageUrls.length > 0) {
      payload.imageUrls = uploadedImageUrls;
    }

    const resp = await fetchWithLog(
      `${KIE_BASE}/api/v1/veo/generate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      this.fetchFn,
    );

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`KIE veo submit error ${resp.status}: ${txt}`);
    }

    const data = (await resp.json()) as KieVeoSubmitResponse;
    if (data.code !== 200 || !data.data?.taskId) {
      const msg = data.msg ?? "";
      // Defensive net: см. комментарий в kie.adapter.ts. Если despite
      // fileName-fix провайдер всё равно вернул unsupported-format, юзер
      // получает дружелюбный текст вместо generic generationFailed.
      if (
        /file type not supported|unsupported image format|invalid image format|only [^.]*image formats? are supported/i.test(
          msg,
        )
      ) {
        throw new UserFacingError(`KIE veo submit failed: ${data.code} — ${msg}`, {
          key: "chatInvalidImage",
          notifyOps: true,
          opsAlertDedupKey: `kie-veo-unsupported-format-${this.modelId}`,
        });
      }
      throw new Error(`KIE veo submit failed: ${data.code} — ${msg}`);
    }
    return data.data.taskId;
  }

  async poll(taskId: string): Promise<VideoResult | null> {
    const resp = await fetchWithLog(
      `${KIE_BASE}/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
      this.fetchFn,
    );

    if (!resp.ok) throw new Error(`KIE veo poll error ${resp.status}`);

    const data = (await resp.json()) as KieVeoPollResponse;
    if (data.code !== 200 || !data.data) {
      throw new Error(`KIE veo poll failed: ${data.code} — ${data.msg}`);
    }

    const task = data.data;

    // successFlag: 0=generating, 1=success, 2=failed, 3=generation failed.
    // 2 — task failed before generation (валидация / fetch image / etc.).
    // 3 — task created but upstream generation failed (content policy, etc.).
    if (task.successFlag === 2 || task.successFlag === 3) {
      const errorCode = task.errorCode != null ? String(task.errorCode) : "";
      const errorMessage = task.errorMessage ?? "unknown error";
      const technicalMessage = `KIE ${this.modelId} generation failed: ${errorCode} ${errorMessage}`;

      // 400: prompt flagged / unsafe image / failed to fetch image — policy/user-input issue.
      const isUserInputIssue = task.errorCode === 400;
      const isPublicFigure =
        /public figure|public person|prominent figure|celebrity|minor upload|prominent people/i.test(
          errorMessage,
        );
      const isCopyright = /copyright/i.test(errorMessage);
      const isPolicy =
        isUserInputIssue ||
        /sensitive|restrict|policy|prohibited|nsfw|violat|inappropriate|safety|content moderation|blocked|flagged|unsafe|(prompt|request|input|content) (was |is )?rejected/i.test(
          errorMessage,
        );
      const hasCyrillic = /[Ѐ-ӿ]/.test(errorMessage);
      const isNoResult =
        /could not generate (an? )?(image|video|result)|failed to generate|no (image|video) (was )?generated|unable to generate/i.test(
          errorMessage,
        ) || hasCyrillic;

      if (isNoResult) {
        throw new UserFacingError(technicalMessage, { key: "generationNoResult" });
      }
      if (isPublicFigure)
        throw new UserFacingError(technicalMessage, { key: "publicFigureViolation" });
      if (isCopyright) throw new UserFacingError(technicalMessage, { key: "copyrightViolation" });
      if (isPolicy) throw new UserFacingError(technicalMessage, { key: "contentPolicyViolation" });

      const classified = await classifyAIError(`${errorCode} ${errorMessage}`.trim());
      if (classified?.shouldShow) {
        throw new UserFacingError(technicalMessage, {
          key: "aiClassifiedError",
          params: { messageRu: classified.messageRu, messageEn: classified.messageEn },
          notifyOps: true,
        });
      }
      throw new Error(technicalMessage);
    }

    if (task.successFlag !== 1) return null; // 0 = still generating

    // Готово: resultUrls — настоящий string[] (не JSON-string как в callback).
    const urls = task.response?.resultUrls ?? task.response?.fullResultUrls ?? [];
    const url = urls.find((u) => typeof u === "string" && u.length > 0);
    if (!url) throw new Error("KIE veo: no resultUrls in completed task");

    return { url, filename: `${this.modelId}.mp4` };
  }
}
