import type { AudioAdapter, AudioInput, AudioResult } from "./base.adapter.js";
import { AI_MODELS, config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { logger } from "../../logger.js";

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

/** Default voice ID — Rachel */
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/**
 * ElevenLabs отдаёт 401 c телом `{ detail: { status: "quota_exceeded", … } }`,
 * когда у аккаунта кончились кредиты — это provider-wide состояние (бьёт по
 * всем джобам до пополнения), а не вина конкретного запроса. Превращаем в
 * чистую терминальную `UserFacingError` с ops-алертом (дедуп), вместо plain
 * `Error`, который жёг бы BullMQ-ретраи. Обычный 401 (битый ключ) не трогаем —
 * это другой кейс, пусть остаётся plain Error.
 */
function throwIfQuotaExceeded(modelId: string, status: number, body: string): void {
  if (status !== 401) return;
  let isQuota = false;
  try {
    const parsed = JSON.parse(body) as { detail?: { status?: string } };
    isQuota = parsed.detail?.status === "quota_exceeded";
  } catch {
    return; // не JSON — не quota-форма, дальше пойдёт plain Error
  }
  if (!isQuota) return;
  throw new UserFacingError(`ElevenLabs quota exhausted (${modelId}): ${body.slice(0, 200)}`, {
    key: "modelTemporarilyUnavailable",
    section: "audio",
    params: { modelName: AI_MODELS[modelId]?.name ?? modelId },
    notifyOps: true,
    opsAlertDedupKey: "elevenlabs-credits-exhausted",
  });
}

/**
 * ElevenLabs adapter.
 * - modelId "tts-el": TTS using a specified ElevenLabs voice (synchronous).
 * - modelId "voice-clone": legacy alias — treated same as tts-el for backward compat.
 * - modelId "sounds-el": sound effects generation via /v1/sound-generation (synchronous).
 * - modelId "music-el": music/ambient generation via /v1/sound-generation (synchronous).
 */
export class ElevenLabsAdapter implements AudioAdapter {
  readonly isAsync = false;

  constructor(
    readonly modelId: "voice-clone" | "tts-el" | "sounds-el" | "music-el",
    private readonly apiKey = config.ai.elevenlabs ?? "",
    private readonly fetchFn?: typeof globalThis.fetch,
  ) {}

  private headers() {
    return {
      "xi-api-key": this.apiKey,
      "Content-Type": "application/json",
    };
  }

  async generate(input: AudioInput): Promise<AudioResult> {
    if (this.modelId === "sounds-el" || this.modelId === "music-el") {
      return this.generateSound(input);
    }
    return this.generateSpeech(input);
  }

  private async generateSpeech(input: AudioInput): Promise<AudioResult> {
    const ms = input.modelSettings ?? {};
    // voice_id can come from modelSettings (webapp picker) or the legacy voiceId param
    const voiceId = (ms.voice_id as string | undefined) || input.voiceId || DEFAULT_VOICE_ID;
    const voiceSettings = {
      stability: (ms.stability as number | undefined) ?? 0.5,
      similarity_boost: (ms.similarity_boost as number | undefined) ?? 0.75,
      style: (ms.style as number | undefined) ?? 0.0,
      use_speaker_boost: (ms.use_speaker_boost as boolean | undefined) ?? true,
    };

    const modelId = (ms.model_id as string | undefined) ?? "eleven_multilingual_v2";

    const res = await fetchWithLog(
      `${ELEVENLABS_API}/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          text: input.prompt,
          model_id: modelId,
          voice_settings: voiceSettings,
        }),
      },
      this.fetchFn,
    );

    if (!res.ok) {
      const text = await res.text();
      throwIfQuotaExceeded(this.modelId, res.status, text);
      throw new Error(`ElevenLabs TTS failed: ${res.status} ${text}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, ext: "mp3", contentType: "audio/mpeg" };
  }

  private async generateSound(input: AudioInput): Promise<AudioResult> {
    const ms = input.modelSettings ?? {};
    const durationSeconds =
      typeof ms.duration_seconds === "number" ? ms.duration_seconds : undefined;
    const promptInfluence = typeof ms.prompt_influence === "number" ? ms.prompt_influence : 0.3;

    const body: Record<string, unknown> = {
      text: input.prompt,
      prompt_influence: promptInfluence,
    };
    if (durationSeconds !== undefined) body.duration_seconds = durationSeconds;

    const res = await fetchWithLog(
      `${ELEVENLABS_API}/sound-generation`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      },
      this.fetchFn,
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 400) {
        try {
          const parsed = JSON.parse(text) as {
            detail?: { code?: string; message?: string };
          };
          if (parsed.detail?.code === "text_too_long") {
            const match = parsed.detail.message?.match(
              /maximum.*?(\d+)\s*characters.*?received\s*(\d+)/i,
            );
            throw new UserFacingError(`ElevenLabs: prompt too long (max 450 chars)`, {
              key: "elevenlabsPromptTooLong",
              params: {
                max: match ? Number(match[1]) : 450,
                current: match ? Number(match[2]) : input.prompt.length,
              },
            });
          }
        } catch (e) {
          if (e instanceof UserFacingError) throw e;
        }
      }
      throwIfQuotaExceeded(this.modelId, res.status, text);
      throw new Error(`ElevenLabs sound generation failed: ${res.status} ${text}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, ext: "mp3", contentType: "audio/mpeg" };
  }

  /**
   * Clone a voice from an audio buffer.
   * Calls POST /v1/voices/add (multipart) and returns the new voice_id.
   * Static so it can be called from the bot scene without instantiating an adapter.
   */
  static async cloneVoice(
    audioBuffer: Buffer,
    filename: string,
    name: string,
    removeBackgroundNoise = false,
    apiKey: string = config.ai.elevenlabs ?? "",
  ): Promise<string> {
    const form = new FormData();
    form.append("name", name);
    form.append("files", new Blob([audioBuffer]), filename);
    form.append("remove_background_noise", String(removeBackgroundNoise));

    const res = await fetch(`${ELEVENLABS_API}/voices/add`, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ElevenLabs voice clone failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { voice_id: string };
    return data.voice_id;
  }

  /**
   * Deletes a voice from ElevenLabs.
   * Returns true on success (2xx or 404 — the slot is free either way),
   * false otherwise. Logs the failure body.
   */
  static async deleteVoice(
    voiceId: string,
    apiKey: string = config.ai.elevenlabs ?? "",
  ): Promise<boolean> {
    try {
      const res = await fetch(`${ELEVENLABS_API}/voices/${voiceId}`, {
        method: "DELETE",
        headers: { "xi-api-key": apiKey },
      });
      if (res.ok || res.status === 404) return true;
      const body = await res.text().catch(() => "");
      logger.error({ voiceId, status: res.status, body }, "ElevenLabs deleteVoice failed");
      return false;
    } catch (reason) {
      logger.error({ voiceId, reason }, "ElevenLabs deleteVoice network error");
      return false;
    }
  }

  /**
   * Lists all voices on the ElevenLabs account.
   * Returns an array of { voice_id, name, category, created_at_unix? } entries.
   * "category" distinguishes "cloned" / "professional" / "generated" / "premade".
   * We only need "cloned" and "generated" for eviction (premade cannot be deleted).
   */
  static async listVoices(
    apiKey: string = config.ai.elevenlabs ?? "",
  ): Promise<
    Array<{ voice_id: string; name: string; category: string; created_at_unix?: number }>
  > {
    const res = await fetch(`${ELEVENLABS_API}/voices`, {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ElevenLabs listVoices failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as {
      voices?: Array<{
        voice_id: string;
        name?: string;
        category?: string;
        created_at_unix?: number;
      }>;
    };
    return (data.voices ?? []).map((v) => ({
      voice_id: v.voice_id,
      name: v.name ?? "",
      category: v.category ?? "",
      created_at_unix: v.created_at_unix,
    }));
  }

  /** Fetches the preview_url for a voice from ElevenLabs. Returns null on failure. */
  static async getPreviewUrl(
    voiceId: string,
    apiKey: string = config.ai.elevenlabs ?? "",
  ): Promise<string | null> {
    const res = await fetch(`${ELEVENLABS_API}/voices/${voiceId}`, {
      headers: { "xi-api-key": apiKey },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { preview_url?: string | null };
    return data.preview_url ?? null;
  }
}
