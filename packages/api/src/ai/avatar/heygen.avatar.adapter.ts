import { config } from "@metabox/shared";
import type { AvatarAdapter, AvatarCreateResult, AvatarPollResult } from "./base.adapter.js";
import { fetchWithLog } from "../../utils/fetch.js";
import { resolveImageMimeType } from "../../utils/mime-detect.js";
import { providerHttpError } from "../../utils/rate-limit-error.js";

const HEYGEN_API = "https://api.heygen.com";

export class HeyGenAvatarAdapter implements AvatarAdapter {
  readonly provider = "heygen";

  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch | undefined;

  constructor(apiKey = config.ai.heygen ?? "", fetchFn?: typeof globalThis.fetch) {
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }

  /**
   * Upload image to HeyGen asset storage via POST /v3/assets.
   * Returns externalId = HeyGen asset id, usable as image asset in /v3/videos.
   * Creation is synchronous — no training job needed.
   */
  async create(imageBuffer: Buffer, contentType: string): Promise<AvatarCreateResult> {
    const resolvedContentType = resolveImageMimeType(imageBuffer, contentType);
    const ext = resolvedContentType.includes("png")
      ? "png"
      : resolvedContentType.includes("webp")
        ? "webp"
        : "jpg";
    if (!imageBuffer.byteLength) {
      throw new Error("HeyGen: image buffer is empty");
    }

    const formData = new FormData();
    formData.append(
      "file",
      new Blob(
        [new Uint8Array(imageBuffer.buffer, imageBuffer.byteOffset, imageBuffer.byteLength)],
        { type: resolvedContentType },
      ),
      `image.${ext}`,
    );

    const uploadRes = await fetchWithLog(
      `${HEYGEN_API}/v3/assets`,
      {
        method: "POST",
        headers: { "X-Api-Key": this.apiKey },
        body: formData,
      },
      this.fetchFn,
    );
    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw providerHttpError(
        `HeyGen asset upload failed: ${uploadRes.status} ${text}`,
        uploadRes.status,
      );
    }
    const uploadData = (await uploadRes.json()) as { data?: { asset_id?: string } };
    const assetId = uploadData.data?.asset_id;
    if (!assetId)
      throw new Error(`HeyGen: no asset id in upload response: ${JSON.stringify(uploadData)}`);

    return { externalId: assetId };
  }

  /** Stub — avatar is ready immediately after upload, no polling needed. */
  async poll(_externalId: string): Promise<AvatarPollResult> {
    return { status: "ready" };
  }
}
