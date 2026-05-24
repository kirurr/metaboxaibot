import type { VideoAdapter, VideoInput, VideoResult } from "./base.adapter.js";
import { AI_MODELS, config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { probeVideoMetadata } from "../../utils/mp4-duration.js";
import { logger } from "../../logger.js";

/**
 * Бросает UserFacingError "model temporarily unavailable" с роутингом ops-алёрта
 * в balance-тему, если DashScope ответил `code: "Arrearage"` — наш аккаунт в
 * просрочке. Юзер видит нейтральное «модель отдыхает» (без слова "баланс"),
 * processor превращает throw в UnrecoverableError → BullMQ не ретраит.
 */
function throwIfArrearage(modelId: string, code: string | undefined, body: string): void {
  const isArrearage =
    code === "Arrearage" || /\bArrearage\b/i.test(body) || /account.*good\s+standing/i.test(body);
  if (!isArrearage) return;
  throw new UserFacingError(
    `Alibaba DashScope account in arrears (${modelId}): ${body.slice(0, 200)}`,
    {
      key: "modelTemporarilyUnavailable",
      section: "video",
      params: { modelName: AI_MODELS[modelId]?.name ?? modelId },
      notifyOps: true,
      opsAlertDedupKey: "alibaba-arrearage",
      opsAlertChannel: "balance",
    },
  );
}

const DASHSCOPE_BASE = "https://dashscope-intl.aliyuncs.com/api/v1";
const SUBMIT_PATH = "/services/aigc/video-generation/video-synthesis";

const T2V_MODEL = "wan2.7-t2v";
const I2V_MODEL = "wan2.7-i2v";

interface WanMediaAsset {
  type: "first_frame" | "last_frame" | "driving_audio" | "first_clip";
  url: string;
}

/**
 * Valid media-type combinations accepted by wan2.7-i2v. Any other combination
 * must be rejected before submit to avoid a 4xx from DashScope.
 */
const VALID_WAN_COMBINATIONS: ReadonlyArray<ReadonlySet<WanMediaAsset["type"]>> = [
  new Set(["first_frame"]),
  new Set(["first_frame", "driving_audio"]),
  new Set(["first_frame", "last_frame"]),
  new Set(["first_frame", "last_frame", "driving_audio"]),
  new Set(["first_clip"]),
  new Set(["first_clip", "last_frame"]),
];

function isValidWanCombination(types: WanMediaAsset["type"][]): boolean {
  const set = new Set(types);
  if (set.size !== types.length) return false; // duplicates not allowed
  return VALID_WAN_COMBINATIONS.some((v) => v.size === set.size && [...set].every((t) => v.has(t)));
}

/**
 * Size strings for text-to-video (T2V) — resolution tier × aspect ratio → "W*H".
 * Image-to-video uses a plain "resolution" keyword (720P / 1080P) since
 * the output aspect ratio is determined by the input image.
 */
const T2V_SIZE_MAP: Record<string, Record<string, string>> = {
  "720P": {
    "16:9": "1280*720",
    "9:16": "720*1280",
    "1:1": "960*960",
    "4:3": "1088*832",
    "3:4": "832*1088",
  },
  "1080P": {
    "16:9": "1920*1080",
    "9:16": "1080*1920",
    "1:1": "1440*1440",
    "4:3": "1632*1248",
    "3:4": "1248*1632",
  },
};

interface DashScopeSubmitResponse {
  output: { task_id: string; task_status: string };
  request_id?: string;
  code?: string;
  message?: string;
}

interface DashScopePollResponse {
  output: {
    task_status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | string;
    video_url?: string;
    message?: string;
  };
}

/**
 * Alibaba DashScope adapter for Wan 2.6 video generation.
 * Automatically selects:
 *   - wan2.6-t2v  when no image is attached (text-to-video)
 *   - wan2.6-i2v  when an image is attached (image-to-video)
 * Docs: https://www.alibabacloud.com/help/en/model-studio/developer-reference/wan2-6-api
 */
export class AlibabaVideoAdapter implements VideoAdapter {
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
    const key = this.apiKeyOverride ?? config.ai.alibaba;
    if (!key) throw new Error("ALIBABA_API_KEY not configured");
    return key;
  }

  async submit(input: VideoInput): Promise<string> {
    const ms = input.modelSettings ?? {};
    const mi = input.mediaInputs ?? {};

    const media: WanMediaAsset[] = [];
    const firstFrame = mi.first_frame?.[0] ?? input.imageUrl;
    if (firstFrame) media.push({ type: "first_frame", url: firstFrame });
    const lastFrame = mi.last_frame?.[0];
    if (lastFrame) media.push({ type: "last_frame", url: lastFrame });
    const drivingAudio = mi.driving_audio?.[0];
    if (drivingAudio) media.push({ type: "driving_audio", url: drivingAudio });
    const firstClip = mi.first_clip?.[0];
    if (firstClip) media.push({ type: "first_clip", url: firstClip });

    const isI2V = media.length > 0;
    if (isI2V && !isValidWanCombination(media.map((m) => m.type))) {
      throw new Error(
        `Wan 2.7: invalid media combination [${media.map((m) => m.type).join(", ")}]`,
      );
    }

    const dashscopeModel = isI2V ? I2V_MODEL : T2V_MODEL;
    const resolution = (ms.resolution as string | undefined) ?? "720P";
    const duration = (ms.duration as number | undefined) ?? input.duration ?? 5;

    // Pre-validation для first_clip mode. Pattern 1 (clip >10s) уже отбит на
    // upload'е через slot constraint, но если клип попал в payload каким-то
    // другим путём (webapp / direct API) — страхуемся здесь же. Pattern 2
    // (clip ≥ output duration) — динамический констрейнт, slot его не ловит.
    // На probe-failure → не блокируем submit, post-poll mapping страхует.
    if (isI2V && firstClip) {
      try {
        const probed = await probeVideoMetadata(firstClip);
        const clipDur = probed.durationSec;
        if (clipDur !== null) {
          if (clipDur > 10) {
            throw new UserFacingError(`Wan: first_clip duration ${clipDur}s exceeds 10s limit`, {
              key: "mediaSlotDurationTooLong",
              params: { actual: Math.round(clipDur), max: 10 },
            });
          }
          if (clipDur >= duration) {
            throw new UserFacingError(
              `Wan: first_clip (${clipDur}s) >= output duration (${duration}s)`,
              {
                key: "firstClipExceedsOutputDuration",
                params: { actual: Math.round(clipDur), requested: duration },
              },
            );
          }
        }
      } catch (err) {
        if (err instanceof UserFacingError) throw err;
        logger.warn(
          { err, firstClipUrl: firstClip },
          "Wan adapter: first_clip probe failed, deferring duration check to post-poll",
        );
      }
    }

    const apiInput: Record<string, unknown> = { prompt: input.prompt };
    if (isI2V) apiInput.media = media;
    if (ms.negative_prompt) apiInput.negative_prompt = ms.negative_prompt;

    const parameters: Record<string, unknown> = { duration };

    if (isI2V) {
      // wan2.7-i2v uses a resolution tier keyword; output aspect ratio is driven by input media.
      parameters.resolution = resolution;
    } else {
      // T2V uses an exact pixel dimension string (resolution × aspect ratio)
      const aspectRatio = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio ?? "16:9";
      const size = T2V_SIZE_MAP[resolution]?.[aspectRatio] ?? T2V_SIZE_MAP["720P"]["16:9"];
      parameters.size = size;
    }

    if (ms.prompt_extend !== undefined) parameters.prompt_extend = ms.prompt_extend;
    if (ms.seed != null) parameters.seed = ms.seed;

    const body = { model: dashscopeModel, input: apiInput, parameters };

    const resp = await fetchWithLog(
      `${DASHSCOPE_BASE}${SUBMIT_PATH}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "X-DashScope-Async": "enable",
        },
        body: JSON.stringify(body),
      },
      this.fetchFn,
    );

    if (!resp.ok) {
      const txt = await resp.text();
      // Account-in-arrears (400 + code:"Arrearage") — provider-wide billing,
      // не ретраим, алёртим в balance-тему с дедупом.
      throwIfArrearage(this.modelId, undefined, txt);
      throw new Error(`Alibaba DashScope error ${resp.status}: ${txt}`);
    }

    const data = (await resp.json()) as DashScopeSubmitResponse;
    if (data.code) {
      throwIfArrearage(this.modelId, data.code, `${data.code} — ${data.message ?? ""}`);
      throw new Error(`Alibaba DashScope error: ${data.code} — ${data.message}`);
    }
    return data.output.task_id;
  }

  async poll(taskId: string): Promise<VideoResult | null> {
    const resp = await fetchWithLog(
      `${DASHSCOPE_BASE}/tasks/${taskId}`,
      {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      },
      this.fetchFn,
    );

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      // Аккаунт может уйти в Arrearage между submit'ом и poll'ом — wan async,
      // поллим часами. Без этой проверки 400+Arrearage летел бы как generic
      // 5xx-эквивалент: BullMQ ретраит, alert в общий канал, юзер ждёт.
      throwIfArrearage(this.modelId, undefined, txt);
      throw new Error(`Alibaba poll error ${resp.status}${txt ? `: ${txt.slice(0, 200)}` : ""}`);
    }

    const data = (await resp.json()) as DashScopePollResponse;
    const { task_status, video_url, message } = data.output;

    if (task_status === "FAILED") {
      const errMsg = message ?? "unknown error";
      // Wan I2V жёстко ограничивает input-video <=10s. Когда юзер грузит более
      // длинное — submit проходит, fail приходит только на poll'е. Мапим в
      // UserFacingError(mediaSlotDurationTooLong), чтобы юзер увидел понятное
      // «обрежьте видео», а не generic «generationFailed» + ops-alert.
      // Формат сообщения от Wan: «<url> duration should be at most 10s, got 14.2s».
      const durationMatch =
        /duration should be at most (\d+(?:\.\d+)?)s, got (\d+(?:\.\d+)?)s/i.exec(errMsg);
      if (durationMatch) {
        const max = durationMatch[1]!;
        const actual = Math.round(Number(durationMatch[2]!));
        throw new UserFacingError(`Alibaba Wan: input video duration exceeds limit (${errMsg})`, {
          key: "mediaSlotDurationTooLong",
          params: { actual, max },
        });
      }
      // Wan i2v `first_clip` mode требует чтобы длительность референс-клипа
      // была меньше параметра выходной длительности (`parameters.duration`).
      // Юзер выбрал output=2s, грузит клип на 6s — Wan отбивает. Решение
      // двойное: либо клип короче, либо output длиннее. Отдельный ключ
      // (не mediaSlotDurationTooLong), чтобы сообщение объяснило оба пути.
      // Формат: «first_clip duration (6.05s) must be less than the requested duration (2s)».
      const firstClipMatch =
        /first_clip duration \((\d+(?:\.\d+)?)s\) must be less than the requested duration \((\d+(?:\.\d+)?)s\)/i.exec(
          errMsg,
        );
      if (firstClipMatch) {
        const actual = Math.round(Number(firstClipMatch[1]!));
        const requested = Math.round(Number(firstClipMatch[2]!));
        throw new UserFacingError(
          `Alibaba Wan: first_clip duration exceeds output duration (${errMsg})`,
          {
            key: "firstClipExceedsOutputDuration",
            params: { actual, requested },
          },
        );
      }
      // Wan content policy: «Input data may contain inappropriate content.» —
      // провайдер фильтрует input (фото/видео-референс или промпт). Без
      // mapping'а юзер видит generic «generationFailed» + летит ops-alert на
      // совершенно юзер-фолтовый кейс.
      if (/Input data may contain inappropriate content/i.test(errMsg)) {
        throw new UserFacingError(`Alibaba Wan: input flagged as inappropriate (${errMsg})`, {
          key: "contentPolicyViolation",
        });
      }
      throw new Error(`Alibaba Wan generation failed: ${errMsg}`);
    }
    if (task_status !== "SUCCEEDED") return null;
    if (!video_url) throw new Error("Alibaba Wan: no video URL in result");

    return { url: video_url, filename: "wan.mp4" };
  }
}
