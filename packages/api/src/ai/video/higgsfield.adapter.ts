import type { VideoAdapter, VideoInput, VideoResult } from "./base.adapter.js";
import { config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { logger } from "../../logger.js";
import { providerHttpError } from "../../utils/rate-limit-error.js";

const HIGGSFIELD_API = "https://platform.higgsfield.ai";

const DOP_MODEL: Record<string, string> = {
  "higgsfield-lite": "dop-lite",
  higgsfield: "dop-turbo",
  "higgsfield-preview": "dop-preview",
};

/** Response from POST /v1/image2video/dop — job set. */
interface SubmitResponse {
  id: string; // job-set ID — used to construct status URL
  status_url?: string; // full status URL if provided by API
  jobs: Array<{
    id: string;
    status: string;
    results: null | { url?: string; raw?: { url?: string } };
  }>;
}

/** Response from GET /requests/{id}/status */
interface PollResponse {
  status: "queued" | "in_progress" | "nsfw" | "failed" | "completed" | "canceled";
  request_id: string;
  status_url?: string;
  cancel_url?: string;
  video?: { url: string };
  jobs?: Array<{
    status: string;
    results: null | { url?: string; raw?: { url?: string } };
  }>;
  results?: null | { url?: string; raw?: { url?: string } };
}

/**
 * Higgsfield official API adapter (async queue).
 * Auth: Authorization: Key {apiKey}:{apiSecret}
 * Uses the v1 DOP endpoint with optional motion presets.
 * Supports dop-lite, dop-turbo (default), dop-preview variants.
 */
export class HiggsFieldAdapter implements VideoAdapter {
  readonly modelId: string;
  private readonly dopModel: string;
  private readonly authHeader: string;
  private readonly fetchFn: typeof globalThis.fetch | undefined;

  constructor(
    modelId = "higgsfield",
    apiKey = config.ai.higgsfieldApiKey ?? "",
    apiSecret = config.ai.higgsfieldApiSecret ?? "",
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.modelId = modelId;
    this.dopModel = DOP_MODEL[modelId] ?? "dop-turbo";
    this.authHeader = `Key ${apiKey}:${apiSecret}`;
    this.fetchFn = fetchFn;
  }

  private headers() {
    return {
      Authorization: this.authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  async submit(input: VideoInput): Promise<string> {
    type MotionEntry = { id: string; strength?: number };
    const motions = input.modelSettings?.motions as MotionEntry[] | undefined;

    const enhancePrompt = (input.modelSettings?.enhance_prompt as boolean | undefined) ?? true;
    const seed = (input.modelSettings?.seed as number | null | undefined) ?? undefined;
    const imageUrl = input.mediaInputs?.first_frame?.[0] ?? input.imageUrl;

    const body: Record<string, unknown> = {
      model: this.dopModel,
      prompt: input.prompt,
      enhance_prompt: enhancePrompt,
      ...(seed != null ? { seed } : {}),
      ...(imageUrl ? { input_images: [{ type: "image_url", image_url: imageUrl }] } : {}),
      ...(motions?.length ? { motions } : {}),
    };

    const res = await fetchWithLog(
      `${HIGGSFIELD_API}/v1/image2video/dop`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ params: body }),
      },
      this.fetchFn,
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 422) {
        try {
          const parsed = JSON.parse(text) as {
            detail?: Array<{ type?: string; ctx?: { max_length?: number } }>;
          };
          const tooLong = parsed.detail?.find(
            (d) => d.type === "too_long" && d.ctx?.max_length != null,
          );
          if (tooLong) {
            const cause = Object.assign(new Error(`Higgsfield HTTP ${res.status}`), {
              status: res.status,
              body: text.slice(0, 1000),
            });
            throw new UserFacingError(
              `Higgsfield: too many motions (max ${tooLong.ctx!.max_length})`,
              {
                key: "higgsfieldTooManyMotions",
                params: { max: tooLong.ctx!.max_length! },
                cause,
              },
            );
          }
        } catch (e) {
          if (e instanceof UserFacingError) throw e;
        }
      }
      throw providerHttpError(`Higgsfield submit failed: ${res.status} ${text}`, res.status);
    }

    const data = (await res.json()) as SubmitResponse;
    logger.info({ data }, "Higgsfield submit response");

    // Use status_url from response if provided; otherwise build from top-level id (job-set ID).
    // Do NOT use jobs[0].id — that's a job-level ID, not valid for /requests/{id}/status.
    if (!data.id) throw new Error(`Higgsfield: no ID in submit response: ${JSON.stringify(data)}`);
    const statusUrl = data.status_url ?? `${HIGGSFIELD_API}/requests/${data.id}/status`;
    return statusUrl;
  }

  async poll(statusUrl: string): Promise<VideoResult | null> {
    const res = await fetchWithLog(
      statusUrl,
      {
        headers: this.headers(),
      },
      this.fetchFn,
    );

    if (!res.ok) {
      const text = await res.text();
      throw providerHttpError(`Higgsfield poll failed: ${res.status} ${text}`, res.status);
    }

    const data = (await res.json()) as PollResponse;
    logger.info({ data }, "Higgsfield poll response");

    if (data.status === "failed" || data.status === "nsfw" || data.status === "canceled") {
      throw new Error(`Higgsfield generation ${data.status}: ${JSON.stringify(data)}`);
    }
    if (data.status !== "completed") return null;

    const url = data.video?.url;
    if (!url) throw new Error(`Higgsfield: no video URL in completed job: ${JSON.stringify(data)}`);
    return { url, filename: "higgsfield.mp4" };
  }
}
