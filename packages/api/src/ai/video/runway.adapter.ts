import type {
  VideoAdapter,
  VideoInput,
  VideoResult,
  VideoValidationError,
} from "./base.adapter.js";
import { config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { parseRunwayTaskFailure } from "../../utils/runway-error.js";
import { materializeImageInput, type MaterializedImageInput } from "../../services/s3.service.js";
import { logger } from "../../logger.js";
import { providerHttpError } from "../../utils/rate-limit-error.js";

const RUNWAY_API = "https://api.dev.runwayml.com/v1";

const SUPPORTED_RATIOS = new Set(["1280:720", "720:1280"]);
const SUPPORTED_DURATIONS = [5, 10];

/**
 * Старые сохранённые в userState значения (1104:832, 960:960, 1584:672 и т.д.)
 * больше не принимаются Runway — нормализуем к ближайшей по ориентации опции.
 */
function normalizeRunwayRatio(raw: string | undefined): string {
  if (raw && SUPPORTED_RATIOS.has(raw)) return raw;
  if (raw) {
    const [w, h] = raw.split(":").map(Number);
    if (Number.isFinite(w) && Number.isFinite(h) && h > w) return "720:1280";
  }
  return "1280:720";
}

/**
 * Runway gen4.5 принимает только 5 и 10 секунд. cost-preview уже снэпает,
 * но это последний рубеж от 400.
 */
function normalizeRunwayDuration(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return SUPPORTED_DURATIONS[0]!;
  return SUPPORTED_DURATIONS.reduce(
    (best, d) => (Math.abs(d - raw) < Math.abs(best - raw) ? d : best),
    SUPPORTED_DURATIONS[0]!,
  );
}

/**
 * Hard cap for the inline base64 fallback. Runway rejects `promptImage`
 * data URLs above 5 MB with
 * 413 Request Entity Too Large. We round down to 5 MB binary as a safe
 * cutoff before constructing the data URL — anything heavier should be
 * served from S3 or surfaced to the user as a precondition error.
 */
const RUNWAY_BASE64_LIMIT_BYTES = 5 * 1024 * 1024;

interface RunwayTask {
  id: string;
  status: string;
  output?: string[];
  failure?: string;
  failureCode?: string | null;
}

/**
 * RunwayML Gen-3 Alpha adapter (REST API).
 */
export class RunwayAdapter implements VideoAdapter {
  readonly modelId = "runway";

  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch | undefined;

  constructor(apiKey = config.ai.runway ?? "", fetchFn?: typeof globalThis.fetch) {
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "X-Runway-Version": "2024-11-06",
    };
  }

  validateRequest(input: VideoInput): VideoValidationError | null {
    const limit = 1000;
    if (input.prompt && input.prompt.length > limit) {
      return { key: "promptTooLong", params: { limit } };
    }
    return null;
  }

  async submit(input: VideoInput): Promise<string> {
    const imageUrl = input.mediaInputs?.first_frame?.[0] ?? input.imageUrl;
    const ms = input.modelSettings ?? {};

    // Общая часть body — одинакова для t2v и i2v. promptImage добавляется
    // только в i2v-ветке.
    const body: Record<string, unknown> = {
      promptText: input.prompt,
      model: "gen4.5",
      ratio: normalizeRunwayRatio(input.aspectRatio),
      duration: normalizeRunwayDuration(input.duration),
    };
    if (ms.seed != null) body.seed = ms.seed;
    if (
      ms.camera_horizontal !== undefined ||
      ms.camera_vertical !== undefined ||
      ms.camera_zoom !== undefined
    ) {
      body.motion = {
        ...(ms.camera_horizontal !== undefined
          ? { camera: { horizontal: ms.camera_horizontal } }
          : {}),
        ...(ms.camera_vertical !== undefined ? { camera: { vertical: ms.camera_vertical } } : {}),
        ...(ms.camera_zoom !== undefined ? { camera: { zoom: ms.camera_zoom } } : {}),
      };
    }

    // Без референса → text_to_video; с референсом → image_to_video.
    let endpoint: string;
    let sourceSizeBytes = 0;
    if (imageUrl) {
      const resolved = await this.resolvePromptImage(imageUrl, input.userId);
      body.promptImage = resolved.promptImage;
      sourceSizeBytes = resolved.sourceSizeBytes;
      endpoint = `${RUNWAY_API}/image_to_video`;
    } else {
      endpoint = `${RUNWAY_API}/text_to_video`;
    }

    const res = await fetchWithLog(
      endpoint,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      },
      this.fetchFn,
    );

    if (!res.ok) {
      const text = await res.text();
      // 413 escaping past our own size guard means the inline data URL is
      // the culprit — surface as a precondition error so the user can retry
      // with a smaller file instead of burning BullMQ retries. Только для
      // i2v-пути: t2v body такого размера никогда не достигнет.
      if (res.status === 413 && sourceSizeBytes > 0) {
        const sizeMb = (sourceSizeBytes / (1024 * 1024)).toFixed(1);
        const limitMb = Math.floor(RUNWAY_BASE64_LIMIT_BYTES / (1024 * 1024));
        throw new UserFacingError(`Runway rejected promptImage: 413 Request Entity Too Large`, {
          key: "runwayImageTooLarge",
          params: { size: sizeMb, limit: limitMb },
        });
      }
      // 400 «Invalid asset aspect ratio. width / height ratio must be at least
      // 0.5. Got 0.462.» — user-fault, вытянутое фото. Slot-валидация это уже
      // отбивает (RUNWAY_IMAGE_ASPECT.minAspectRatio=0.5), но defense-in-depth
      // ловим и в адаптере: фото могло прийти через webapp/legacy путь, минуя
      // slot-валидацию. Без этого юзер ждал 3 BullMQ-ретрая на детерминированной
      // ошибке + получал generic «модель отдыхает».
      const aspectMatch =
        res.status === 400 &&
        /Invalid asset aspect ratio.*at least ([\d.]+).*Got ([\d.]+)/i.exec(text);
      if (aspectMatch) {
        throw new UserFacingError(`Runway rejected promptImage: bad aspect ratio ${text}`, {
          key: "runwayImageBadAspect",
          params: { min: aspectMatch[1], got: aspectMatch[2] },
        });
      }
      // 400 «Asset size exceeds 16.0MB» — promptImage тяжелее лимита Runway.
      // Slot-валидация (maxFileSizeBytes) это уже отбивает, ловим и в адаптере
      // defense-in-depth (как с aspect ratio) — иначе 3 пустых BullMQ-ретрая.
      const sizeMatch = res.status === 400 && /Asset size exceeds ([\d.]+)\s*MB/i.exec(text);
      if (sizeMatch) {
        const sizeMb = sourceSizeBytes > 0 ? (sourceSizeBytes / (1024 * 1024)).toFixed(1) : "?";
        throw new UserFacingError(`Runway rejected promptImage: asset too large ${text}`, {
          key: "runwayImageTooLarge",
          params: { size: sizeMb, limit: Math.floor(parseFloat(sizeMatch[1])) },
        });
      }
      throw providerHttpError(`Runway submit failed: ${res.status} ${text}`, res.status);
    }

    const data = (await res.json()) as { id: string };
    return data.id;
  }

  /**
   * Build the `promptImage` value Runway expects. Strategy:
   *
   *  1. Materialise the source image into S3 once and pass Runway a stable
   *     URL — keeps request bodies small (~200 bytes) and side-steps the
   *     413 ceiling on inline data URLs entirely. Files are written under
   *     the `runway-input/` prefix and reaped by an S3 lifecycle rule
   *     (configured out-of-band; see PR description).
   *
   *  2. If S3 is unavailable (not configured or upload failed), fall back
   *     to inline base64 — the legacy behaviour. We already fetched the
   *     bytes during step 1, so no second download.
   *
   *  3. If the buffer is heavier than {@link RUNWAY_BASE64_LIMIT_BYTES},
   *     base64 would 413, so we surface a localised user-facing error
   *     instead of attempting a request that we know will fail.
   */
  private async resolvePromptImage(
    imageUrl: string,
    userId?: bigint,
  ): Promise<{ promptImage: string; sourceSizeBytes: number }> {
    const userKey = userId !== undefined ? userId.toString() : "anonymous";
    const jobKey = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    let materialized: MaterializedImageInput;
    try {
      materialized = await materializeImageInput(imageUrl, {
        keyPrefix: "runway-input",
        userId: userKey,
        jobId: jobKey,
      });
    } catch (err) {
      logger.warn({ err, imageUrl }, "Runway: failed to fetch reference image for materialisation");
      throw new Error(`Runway: failed to fetch reference image (${(err as Error).message})`);
    }

    const sourceSizeBytes = materialized.buffer.byteLength;

    if (materialized.url) {
      return { promptImage: materialized.url, sourceSizeBytes };
    }

    if (sourceSizeBytes > RUNWAY_BASE64_LIMIT_BYTES) {
      const sizeMb = (sourceSizeBytes / (1024 * 1024)).toFixed(1);
      const limitMb = Math.floor(RUNWAY_BASE64_LIMIT_BYTES / (1024 * 1024));
      throw new UserFacingError(`Runway image too large for inline fallback: ${sizeMb} MB`, {
        key: "runwayImageTooLarge",
        params: { size: sizeMb, limit: limitMb },
      });
    }

    logger.warn(
      { sourceSizeBytes },
      "Runway: S3 unavailable, falling back to inline base64 promptImage",
    );
    return {
      promptImage: `data:${materialized.contentType};base64,${materialized.buffer.toString("base64")}`,
      sourceSizeBytes,
    };
  }

  async poll(taskId: string): Promise<VideoResult | null> {
    const res = await fetchWithLog(
      `${RUNWAY_API}/tasks/${taskId}`,
      {
        headers: this.headers(),
      },
      this.fetchFn,
    );

    if (!res.ok) {
      const text = await res.text();
      throw providerHttpError(`Runway poll failed: ${res.status} ${text}`, res.status);
    }

    const task = (await res.json()) as RunwayTask;

    if (task.status === "FAILED") {
      throw parseRunwayTaskFailure(task.failureCode, task.failure);
    }
    if (task.status !== "SUCCEEDED") return null;

    const url = task.output?.[0];
    if (!url) throw new Error("Runway: no output URL in succeeded task");
    return { url, filename: "runway.mp4" };
  }
}
