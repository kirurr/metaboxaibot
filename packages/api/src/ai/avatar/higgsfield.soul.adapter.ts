import { config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { logger } from "../../logger.js";
import { providerHttpError } from "../../utils/rate-limit-error.js";

const HIGGSFIELD_API = "https://platform.higgsfield.ai";

interface CreateResponse {
  id: string;
  name: string;
  status: string;
}

interface ReferenceMedia {
  id: string;
  media_url: string;
}

interface SoulIdStatusResponse {
  id: string;
  name: string;
  status: "not_ready" | "queued" | "in_progress" | "completed" | "failed";
  thumbnail_url?: string | null;
  reference_media?: ReferenceMedia[];
}

function buildEnvCombinedKey(): string {
  const k = config.ai.higgsfieldApiKey ?? "";
  const s = config.ai.higgsfieldApiSecret ?? "";
  return `${k}:${s}`;
}

/**
 * Higgsfield Soul adapter for character (Soul ID) creation.
 * Uses the Higgsfield platform API directly — NOT fal.ai.
 *
 * Workflow: create(name, imageUrls) → poll(externalId) until ready.
 */
export class HiggsFieldSoulAdapter {
  readonly provider = "higgsfield_soul";
  private readonly authHeader: string;
  private readonly fetchFn: typeof globalThis.fetch | undefined;

  /**
   * Higgsfield требует пару `apiKey:apiSecret`. Пул хранит секрет одной строкой,
   * поэтому KeyPool отдаёт `apiKey:apiSecret` целиком — мы только подставляем
   * её в Authorization. Если строка пришла без `:` — считаем, что это уже
   * собранный header (env-fallback или старый формат).
   */
  constructor(combinedKey?: string, fetchFn?: typeof globalThis.fetch) {
    const key = combinedKey ?? buildEnvCombinedKey();
    this.authHeader = `Key ${key}`;
    this.fetchFn = fetchFn;
  }

  private headers() {
    return {
      Authorization: this.authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  /** Create a Soul ID from an array of image URLs. */
  async create(name: string, imageUrls: string[]): Promise<{ externalId: string }> {
    const body = {
      name,
      input_images: imageUrls.map((url) => ({
        type: "image_url" as const,
        image_url: url,
      })),
    };

    const res = await fetchWithLog(
      `${HIGGSFIELD_API}/v1/custom-references`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      },
      this.fetchFn,
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 402 || res.status === 403 || /not enough credits/i.test(text)) {
        // notifyOps: on-call'у нужно знать о биллинговой проблеме (нечем пополнять).
        // cause: переносим status+body в alert через `caused by:` в serializeError.
        const cause = Object.assign(new Error(`Higgsfield Soul HTTP ${res.status}`), {
          status: res.status,
          body: text.slice(0, 1000),
        });
        throw new UserFacingError(`Higgsfield Soul out of credits`, {
          key: "soulProviderUnavailable",
          notifyOps: true,
          cause,
        });
      }
      throw providerHttpError(`Higgsfield Soul create failed: ${res.status} ${text}`, res.status);
    }

    const data = (await res.json()) as CreateResponse;
    logger.info({ data }, "Higgsfield Soul create response");
    if (!data.id) {
      throw new Error(`Higgsfield Soul: no ID in response: ${JSON.stringify(data)}`);
    }
    return { externalId: data.id };
  }

  /** Poll Soul ID creation status. */
  async poll(
    externalId: string,
  ): Promise<{ status: "ready" | "processing" | "failed"; previewUrl?: string }> {
    const res = await fetchWithLog(
      `${HIGGSFIELD_API}/v1/custom-references/${externalId}`,
      { headers: this.headers() },
      this.fetchFn,
    );

    if (!res.ok) {
      const text = await res.text();
      throw providerHttpError(`Higgsfield Soul poll failed: ${res.status} ${text}`, res.status);
    }

    const data = (await res.json()) as SoulIdStatusResponse;
    logger.info({ data, externalId }, "Higgsfield Soul poll response");

    if (data.status === "completed") {
      const previewUrl = data.thumbnail_url || data.reference_media?.[0]?.media_url;
      return { status: "ready", previewUrl };
    }
    if (data.status === "failed") {
      return { status: "failed" };
    }
    return { status: "processing" };
  }
}
