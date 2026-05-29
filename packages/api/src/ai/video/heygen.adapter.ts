import type {
  VideoAdapter,
  VideoInput,
  VideoResult,
  VideoValidationContext,
  VideoValidationError,
} from "./base.adapter.js";
import { config, UserFacingError } from "@metabox/shared";
import { getFileUrl } from "../../services/s3.service.js";
import { logger } from "../../logger.js";
import { fetchWithLog } from "../../utils/fetch.js";
import { transcodeToMp3 } from "../../utils/audio-transcode.js";
import { providerHttpError } from "../../utils/rate-limit-error.js";
import { parseHeyGenErrorBody, parseHeyGenPollFailure } from "../../utils/heygen-error.js";
import { resolveImageMimeType, resolveAudioMimeType } from "../../utils/mime-detect.js";
import sharp from "sharp";
import { randomBytes } from "crypto";

/**
 * Build a multipart/form-data body by hand for a single file field.
 *
 * Why not native FormData + Blob/File? In Node / undici, when the multipart
 * serializer walks the FormData, it sometimes loses the Blob's `type` and
 * writes the part's Content-Type as `application/octet-stream` (observed
 * with pooled Buffer backing stores and with File built from a Uint8Array
 * view). HeyGen validates that per-part Content-Type strictly, so we build
 * the wire format directly — zero surprises.
 */
function buildSingleFileMultipart(
  fieldName: string,
  filename: string,
  contentType: string,
  data: Uint8Array,
): { body: Buffer; contentType: string } {
  const boundary = `----metabox${randomBytes(16).toString("hex")}`;
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([header, Buffer.from(data), footer]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// HeyGen /v3/assets upload constraints (see docs/schema/heygen/asset-upload.md).
// Supported types: png, jpeg (image); mp4, webm (video); mp3, wav (audio); pdf.
const HEYGEN_ASSET_MAX_BYTES = 32 * 1024 * 1024;

const HEYGEN_API = "https://api.heygen.com";

interface HeyGenVideoDetail {
  data?: {
    id: string;
    status: string;
    video_url?: string | null;
    failure_message?: string | null;
    failure_code?: string | null;
  };
}

/** v3 only supports "16:9" and "9:16"; everything else falls back to "16:9". */
const SUPPORTED_ASPECT_RATIOS = new Set(["16:9", "9:16"]);

/**
 * HeyGen talking-avatar adapter using v3 API.
 *
 * Endpoints:
 *  - POST /v3/videos   — create video (discriminated union: type "avatar" | "image")
 *  - GET  /v3/videos/:id — poll status
 *  - POST /v3/assets    — upload image/audio assets
 *
 * Avatar source priority:
 *  1. mediaInputs.avatar_photo[0]     → one-shot chat photo (preferred)  → upload now → type "image"
 *  2. input.imageUrl                  → one-shot chat photo (deprecated) → upload now → type "image"
 *  3. modelSettings.image_asset_id    → pre-uploaded photo asset → type "image"
 *  4. modelSettings.avatar_id         → official avatar look_id → type "avatar"
 *  5. default avatarId from config    → type "avatar"
 *
 * Voice source priority:
 *  1. mediaInputs.voice_audio[0]      → audio_asset_id (lip-sync)
 *  2. modelSettings.voice_id + prompt → script + voice_id (TTS)
 */
export class HeyGenAdapter implements VideoAdapter {
  readonly modelId = "heygen";

  private readonly apiKey: string;
  private readonly defaultAvatarId: string;
  private readonly fetchFn: typeof globalThis.fetch | undefined;

  constructor(
    apiKey = config.ai.heygen ?? "",
    defaultAvatarId = config.ai.heygenAvatarId ?? "Angela-inblackskirt-20220820",
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.apiKey = apiKey;
    this.defaultAvatarId = defaultAvatarId;
    this.fetchFn = fetchFn;
  }

  private get jsonHeaders() {
    return { "X-Api-Key": this.apiKey, "Content-Type": "application/json" };
  }

  /**
   * Synthesize speech via HeyGen Starfish TTS (`POST /v3/voices/speech`).
   *
   * Длительность нужна всегда (для `checkBalance`), а сам mp3 — опционально.
   * Если `skipAudioFetch=true` (pitch-bypass) или скачивание `audio_url`
   * сорвалось — возвращаем `buffer: null`. Caller должен в этом случае
   * НЕ класть `voice_audio` в submit и дать HeyGen сделать inline-TTS при
   * рендере видео (тот же результат, +1 их TTS-вызов). Без этого CDN-flake
   * после успешного TTS убивал бы весь submit, хотя HeyGen уже всё знает
   * и мог бы сам перегенерить.
   */
  async generateSpeech(
    text: string,
    voiceId: string,
    opts?: { speed?: number; language?: string; locale?: string; skipAudioFetch?: boolean },
  ): Promise<{ buffer: Buffer | null; durationSec: number }> {
    if (!text.trim()) throw new Error("HeyGen TTS: empty text");
    if (!voiceId.trim()) throw new Error("HeyGen TTS: empty voice_id");

    const body: Record<string, unknown> = {
      text,
      voice_id: voiceId,
      input_type: "text",
    };
    if (opts?.speed !== undefined) body.speed = opts.speed;
    if (opts?.language) body.language = opts.language;
    if (opts?.locale) body.locale = opts.locale;

    // `fetchWithLog(url, init, this.fetchFn)` — паттерн остальных методов в
    // этом адаптере (см. :472, :502): дебаг-логирование + proxy через
    // `this.fetchFn`. Без 3-го аргумента в proxy-режиме мы теряли логи.
    const res = await fetchWithLog(
      `${HEYGEN_API}/v3/voices/speech`,
      {
        method: "POST",
        headers: this.jsonHeaders,
        body: JSON.stringify(body),
      },
      this.fetchFn,
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw providerHttpError(`HeyGen /v3/voices/speech failed: ${res.status} ${txt}`, res.status);
    }
    const json = (await res.json()) as {
      data?: { audio_url?: string; duration?: number };
      error?: { message?: string } | null;
    };
    const audioUrl = json?.data?.audio_url;
    const duration = json?.data?.duration;
    if (!audioUrl || typeof duration !== "number" || !isFinite(duration) || duration <= 0) {
      throw new Error(`HeyGen /v3/voices/speech: malformed response: ${JSON.stringify(json)}`);
    }
    // Sanity clamp: HeyGen видео-генерация не поддерживает >10 мин. Если
    // duration > 600s — значит API вернул ms или иной мусор (тогда
    // `Math.ceil(audioSec) * per_sec` дал бы катастрофический over-charge).
    if (duration > 600) {
      throw new Error(
        `HeyGen /v3/voices/speech: implausible duration=${duration} (expected seconds, max 600)`,
      );
    }

    // Pitch-bypass: длительность мы получили из JSON, mp3 не нужен.
    if (opts?.skipAudioFetch) {
      return { buffer: null, durationSec: duration };
    }

    // CDN download — best-effort, через тот же proxy-aware fetchWithLog.
    // Транзиентный фейл здесь = graceful degrade в режим "знаем длительность,
    // но аудио нет" → caller пустит inline-TTS.
    try {
      const audioRes = await fetchWithLog(audioUrl, undefined, this.fetchFn);
      if (!audioRes.ok) {
        logger.warn(
          { audioUrl, status: audioRes.status },
          "HeyGen TTS: audio_url fetch returned non-ok, degrading to inline-TTS path",
        );
        return { buffer: null, durationSec: duration };
      }
      const buffer = Buffer.from(await audioRes.arrayBuffer()) as Buffer;
      if (!buffer.byteLength) {
        logger.warn({ audioUrl }, "HeyGen TTS: audio_url returned empty body, degrading");
        return { buffer: null, durationSec: duration };
      }
      return { buffer, durationSec: duration };
    } catch (err) {
      logger.warn({ err, audioUrl }, "HeyGen TTS: audio_url fetch threw, degrading");
      return { buffer: null, durationSec: duration };
    }
  }

  /** Upload audio file to HeyGen asset storage (v1). Returns asset id. */
  private async uploadAudioAsset(audioUrl: string): Promise<string> {
    const audioRes = await fetchWithLog(audioUrl);
    if (!audioRes.ok)
      throw new Error(`Failed to fetch audio for HeyGen upload: ${audioRes.status}`);
    let audioBuffer = Buffer.from(await audioRes.arrayBuffer()) as Buffer;
    if (!audioBuffer.byteLength) {
      logger.error(
        { audioUrl, status: audioRes.status, headers: Object.fromEntries(audioRes.headers) },
        "HeyGen: fetched audio body is empty",
      );
      throw new Error("HeyGen: fetched audio body is empty");
    }
    // Detect actual audio type from magic bytes — HTTP Content-Type may be unreliable.
    let contentType = resolveAudioMimeType(audioBuffer, audioRes.headers.get("content-type"));

    // HeyGen /v3/assets accepts only audio/mpeg (mp3) and audio/wav. Transcode
    // everything else (OGG/Opus from Telegram voice, M4A, AAC, FLAC, ...) to MP3.
    // Anything that isn't an *exact* match transcodes — including exotic aliases
    // like audio/mp3 — so we never gamble on HeyGen accepting non-canonical MIMEs.
    const isHeyGenSupported = contentType === "audio/mpeg" || contentType === "audio/wav";
    if (!isHeyGenSupported) {
      logger.info({ from: contentType }, "HeyGen: transcoding audio to MP3");
      // ffmpeg не смог распарсить вход — файл битый или это вообще не аудио.
      // Не наш баг и не transient: retry с тем же буфером бессмыслен, юзеру
      // нужен внятный мессадж про формат, а не generic «модель отдыхает».
      try {
        audioBuffer = await transcodeToMp3(audioBuffer);
      } catch (err) {
        throw new UserFacingError(
          `HeyGen: audio transcode to MP3 failed: ${err instanceof Error ? err.message : String(err)}`,
          { key: "heygenAudioFormat", cause: err },
        );
      }
      contentType = "audio/mpeg";
      if (!audioBuffer.byteLength) {
        throw new UserFacingError("HeyGen: audio buffer empty after transcode to MP3", {
          key: "heygenAudioFormat",
        });
      }
    }

    if (audioBuffer.byteLength > HEYGEN_ASSET_MAX_BYTES) {
      throw new UserFacingError(
        `HeyGen: audio asset exceeds 32 MB limit (${audioBuffer.byteLength} bytes)`,
        {
          key: "mediaSlotFileTooLarge",
          params: {
            actualMb: (audioBuffer.byteLength / (1024 * 1024)).toFixed(1),
            maxMb: HEYGEN_ASSET_MAX_BYTES / (1024 * 1024),
          },
        },
      );
    }

    const audioExt = contentType === "audio/wav" ? "wav" : "mp3";
    const multipart = buildSingleFileMultipart(
      "file",
      `audio.${audioExt}`,
      contentType,
      audioBuffer,
    );

    logger.info(
      { contentType, size: audioBuffer.byteLength, multipartSize: multipart.body.byteLength },
      "HeyGen: uploading audio asset",
    );

    const uploadRes = await fetchWithLog(
      `${HEYGEN_API}/v3/assets`,
      {
        method: "POST",
        headers: {
          "X-Api-Key": this.apiKey,
          "Content-Type": multipart.contentType,
        },
        body: multipart.body,
      },
      this.fetchFn,
    );
    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      // HeyGen отверг ассет по формату/типу контента — это user-fault (битый
      // или неподдерживаемый файл, который sniffer принял за mp3/wav и пропустил
      // мимо транскода). Retry бесполезен → UserFacingError. Гейт по 4xx: 5xx
      // с телом, случайно матчащим regex, — это инфра-сбой, его надо ретраить,
      // поэтому оставляем plain Error для retry + ops-alert.
      if (
        uploadRes.status >= 400 &&
        uploadRes.status < 500 &&
        /content type not supported|format not supported|invalid.*audio|audio.*format/i.test(text)
      ) {
        throw new UserFacingError(`HeyGen audio asset upload failed: ${uploadRes.status} ${text}`, {
          key: "heygenAudioFormat",
        });
      }
      throw providerHttpError(
        `HeyGen audio asset upload failed: ${uploadRes.status} ${text}`,
        uploadRes.status,
      );
    }
    const uploadData = (await uploadRes.json()) as { data?: { asset_id?: string } };
    const assetId = uploadData.data?.asset_id;
    if (!assetId)
      throw new Error(
        `HeyGen: no asset id in audio upload response: ${JSON.stringify(uploadData)}`,
      );
    return assetId;
  }

  /** Upload raw image to HeyGen asset storage (v1). Returns asset id. */
  private async uploadImageAsset(s3Key: string | undefined, fallbackUrl: string): Promise<string> {
    const imageUrl = s3Key
      ? ((await getFileUrl(s3Key).catch(() => null)) ?? fallbackUrl)
      : fallbackUrl;

    const imgRes = await fetchWithLog(imageUrl);
    if (!imgRes.ok) {
      // 404 = источник реально пропал: presigned S3 URL истёк (TTL 1ч, на
      // attempt 2 после exp-backoff обычная история), либо Telegram file URL
      // истёк, либо S3-объект удалён. Retry с того же URL не поможет — это
      // user-facing «отправьте картинку снова», не наш баг. Без UserFacingError
      // юзер видит generic «модель временно недоступна» + ops ловит alert.
      if (imgRes.status === 404) {
        // ВАЖНО: URL в message НЕ кладём — Telegram file URL содержит bot-token
        // в path (`/bot{TOKEN}/...`), а presigned S3 URL содержит подпись.
        // Сообщение уходит в DB.generationJob.error и в serializeError для логов
        // — утечёт. Достаточно статуса и контекста, что это HeyGen image source.
        throw new UserFacingError("HeyGen: source image returned 404", {
          key: "mediaSourceUnavailable",
        });
      }
      throw new Error(`Failed to fetch image for HeyGen upload: ${imgRes.status}`);
    }
    let imgBuffer: Buffer = Buffer.from(await imgRes.arrayBuffer());
    if (!imgBuffer.byteLength) {
      throw new Error("HeyGen: image buffer is empty after fetch");
    }

    // Detect actual image type from magic bytes — HTTP Content-Type may be unreliable
    // (S3 presigned URLs and Telegram file URLs often return application/octet-stream).
    let contentType = resolveImageMimeType(imgBuffer, imgRes.headers.get("content-type"));

    // HeyGen /v3/assets accepts only png and jpeg for images. Convert anything else
    // (webp, gif, ...) to JPEG via sharp.
    const isHeyGenSupported = contentType === "image/png" || contentType === "image/jpeg";
    if (!isHeyGenSupported) {
      logger.info({ from: contentType }, "HeyGen: transcoding image to JPEG");
      imgBuffer = await sharp(imgBuffer).rotate().jpeg({ quality: 90 }).toBuffer();
      contentType = "image/jpeg";
      if (!imgBuffer.byteLength) {
        throw new Error("HeyGen: image buffer empty after transcode to JPEG");
      }
    }

    if (imgBuffer.byteLength > HEYGEN_ASSET_MAX_BYTES) {
      throw new Error(`HeyGen: image asset exceeds 32 MB limit (${imgBuffer.byteLength} bytes)`);
    }

    const imgExt = contentType === "image/png" ? "png" : "jpg";

    const multipart = buildSingleFileMultipart("file", `image.${imgExt}`, contentType, imgBuffer);

    logger.info(
      { contentType, size: imgBuffer.byteLength, multipartSize: multipart.body.byteLength },
      "HeyGen: uploading image asset",
    );

    const uploadRes = await fetchWithLog(
      `${HEYGEN_API}/v3/assets`,
      {
        method: "POST",
        headers: {
          "X-Api-Key": this.apiKey,
          "Content-Type": multipart.contentType,
        },
        body: multipart.body,
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
    return assetId;
  }

  validateRequest(input: VideoInput, ctx?: VideoValidationContext): VideoValidationError | null {
    const ms = input.modelSettings ?? {};
    const hasAvatar =
      !!input.mediaInputs?.avatar_photo?.[0] ||
      !!input.imageUrl ||
      !!(ms.image_asset_id as string | undefined)?.trim() ||
      !!(ms.avatar_id as string | undefined)?.trim();
    if (!hasAvatar) return { key: "heygenNeedsAvatar" };

    const explicitVoiceId = (ms.voice_id as string | undefined)?.trim();
    const hasVoiceAsset = !!input.mediaInputs?.voice_audio?.[0];
    if (!explicitVoiceId && !hasVoiceAsset && !ctx?.hasVoiceFile) {
      return { key: "heygenNeedsVoice" };
    }
    return null;
  }

  async submit(input: VideoInput): Promise<string> {
    const voiceUrl = input.mediaInputs?.voice_audio?.[0];
    const voiceId = (input.modelSettings?.voice_id as string | undefined) ?? "en-US-JennyNeural";
    const bgColor = (input.modelSettings?.background_color as string | undefined) ?? "#FFFFFF";
    const aspectRatioRaw = input.aspectRatio ?? "16:9";
    const aspectRatio = SUPPORTED_ASPECT_RATIOS.has(aspectRatioRaw) ? aspectRatioRaw : "16:9";
    const resolution = (input.modelSettings?.resolution as string | undefined) ?? "720p";

    // ── Audio asset (lip-sync) ───────────────────────────────────────────────
    let audioAssetId: string | undefined;
    if (voiceUrl) {
      audioAssetId = await this.uploadAudioAsset(voiceUrl);
      logger.info({ audioAssetId }, "HeyGen: uploaded audio asset");
    }

    // ── Avatar source ────────────────────────────────────────────────────────
    const imageAssetIdFromSettings = input.modelSettings?.image_asset_id as string | undefined;
    const avatarId = (input.modelSettings?.avatar_id as string | undefined) || this.defaultAvatarId;

    // ── Build POST /v3/videos body (discriminated union) ────────────────────
    const body: Record<string, unknown> = {
      aspect_ratio: aspectRatio,
      resolution,
      background: { type: "color", value: bgColor },
    };

    // Avatar source → determines type: "avatar" vs type: "image"
    // Prefer mediaInputs.avatar_photo (new path); fall back to deprecated input.imageUrl
    // for in-flight jobs queued before the migration.
    const oneShotPhotoUrl = input.mediaInputs?.avatar_photo?.[0] ?? input.imageUrl;
    if (oneShotPhotoUrl) {
      const uploadedId = await this.uploadImageAsset(undefined, oneShotPhotoUrl);
      body.type = "image";
      body.image = { type: "asset_id", asset_id: uploadedId };
      logger.info({ imageAssetId: uploadedId }, "HeyGen: using uploaded image asset");
    } else if (imageAssetIdFromSettings) {
      body.type = "image";
      body.image = { type: "asset_id", asset_id: imageAssetIdFromSettings };
      logger.info(
        { imageAssetId: imageAssetIdFromSettings },
        "HeyGen: using pre-uploaded image asset",
      );
    } else {
      body.type = "avatar";
      body.avatar_id = avatarId;
    }

    // Photo-avatar / image fields
    if (body.type === "image" || body.type === "avatar") {
      const expressiveness = input.modelSettings?.expressiveness as string | undefined;
      const motionPrompt = input.modelSettings?.motion_prompt as string | undefined;
      if (expressiveness) body.expressiveness = expressiveness;
      if (motionPrompt) body.motion_prompt = motionPrompt;
    }

    // Voice: audio asset (lip-sync) or TTS
    if (audioAssetId) {
      body.audio_asset_id = audioAssetId;
    } else {
      body.script = input.prompt;
      body.voice_id = voiceId;
      // voice_settings applies only to TTS
      if (input.modelSettings?.voice_settings_enabled === true) {
        const speed = input.modelSettings?.voice_speed as number | undefined;
        const pitch = input.modelSettings?.voice_pitch as number | undefined;
        const locale = input.modelSettings?.voice_locale as string | undefined;
        const voiceSettings: Record<string, unknown> = {};
        if (speed !== undefined) voiceSettings.speed = speed;
        if (pitch !== undefined) voiceSettings.pitch = pitch;
        if (locale) voiceSettings.locale = locale;
        if (Object.keys(voiceSettings).length > 0) body.voice_settings = voiceSettings;
      }
    }

    const res = await fetchWithLog(
      `${HEYGEN_API}/v3/videos`,
      {
        method: "POST",
        headers: this.jsonHeaders,
        body: JSON.stringify(body),
      },
      this.fetchFn,
    );

    if (!res.ok) {
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      const structured = parseHeyGenErrorBody(json);
      if (structured) throw structured;
      throw providerHttpError(`HeyGen /v3/videos submit failed: ${res.status} ${text}`, res.status);
    }

    const data = (await res.json()) as { data?: { video_id?: string } };
    const videoId = data.data?.video_id;
    if (!videoId) throw new Error(`HeyGen: no video_id in response: ${JSON.stringify(data)}`);
    return videoId;
  }

  async poll(videoId: string): Promise<VideoResult | null> {
    const res = await fetchWithLog(
      `${HEYGEN_API}/v3/videos/${videoId}`,
      {
        headers: { "X-Api-Key": this.apiKey },
      },
      this.fetchFn,
    );
    const text = await res.text();

    if (!res.ok) {
      throw providerHttpError(`HeyGen poll failed: ${res.status} ${text}`, res.status);
    }

    const result = JSON.parse(text) as HeyGenVideoDetail;
    const data = result.data;

    logger.info({ videoId, result }, `Response from heygen`);

    if (!data) throw new Error("HeyGen: empty status response");
    if (data.status === "failed") {
      throw parseHeyGenPollFailure(data.failure_code, data.failure_message);
    }
    if (data.status !== "completed") return null;

    const url = data.video_url;
    if (!url) throw new Error("HeyGen: no video_url in completed status");
    return { url, filename: "heygen.mp4" };
  }
}
