import type { AudioAdapter, AudioInput, AudioResult } from "./base.adapter.js";
import {
  AI_MODELS,
  config,
  KIE_ELEVENLABS_DEFAULT_VOICE_ID,
  KIE_ELEVENLABS_VOICE_IDS,
  UserFacingError,
} from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";

const KIE_BASE = "https://api.kie.ai";

/** Max input length for all ElevenLabs models on kie.ai (TTS text / sound-effect prompt). */
const MAX_TEXT_CHARS = 5000;

/** kie.ai sound-effect-v2 duration bounds. */
const SFX_MIN_DURATION = 0.5;
const SFX_MAX_DURATION = 22;

/** Audio is always requested as mp3 — `poll()` hardcodes ext/contentType to match. */
const SFX_OUTPUT_FORMAT = "mp3_44100_128";

/** Internal `model_id` setting value → kie.ai TTS model name. */
const TTS_MODEL_NAMES: Record<string, string> = {
  eleven_multilingual_v2: "elevenlabs/text-to-speech-multilingual-v2",
  eleven_turbo_v2_5: "elevenlabs/text-to-speech-turbo-2-5",
};
const DEFAULT_TTS_MODEL = "elevenlabs/text-to-speech-multilingual-v2";
const SOUND_EFFECT_MODEL = "elevenlabs/sound-effect-v2";

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

type KieAudioModelId = "tts-el" | "sounds-el" | "music-el";

/** Clamp a free-form modelSettings value into [0, 1] with a NaN guard. */
function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 0), 1);
}

/**
 * kie.ai adapter for ElevenLabs audio models (async — createTask + recordInfo poll).
 *
 * - `tts-el`    → elevenlabs/text-to-speech-{multilingual-v2,turbo-2-5} (by `model_id` setting)
 * - `sounds-el` → elevenlabs/sound-effect-v2
 * - `music-el`  → elevenlabs/sound-effect-v2 (same endpoint, different UI framing)
 *
 * Mirrors `KieImageAdapter`: POST /api/v1/jobs/createTask → taskId, then
 * GET /api/v1/jobs/recordInfo?taskId=X until `state` is terminal.
 */
export class KieElevenLabsAdapter implements AudioAdapter {
  readonly isAsync = true;

  private readonly apiKeyOverride: string | undefined;
  private readonly fetchFn: typeof globalThis.fetch | undefined;

  constructor(
    readonly modelId: KieAudioModelId,
    apiKey?: string,
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.apiKeyOverride = apiKey;
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

  /** sound-effect duration default from the model catalog (fallback 10s), clamped to kie bounds. */
  private soundEffectDefaultDuration(): number {
    const setting = AI_MODELS[this.modelId]?.settings?.find((s) => s.key === "duration_seconds");
    const def = typeof setting?.default === "number" ? setting.default : 10;
    return Math.min(Math.max(def, SFX_MIN_DURATION), SFX_MAX_DURATION);
  }

  private guardTextLength(text: string): void {
    if (text.length > MAX_TEXT_CHARS) {
      throw new UserFacingError(`KIE ElevenLabs: text ${text.length} > ${MAX_TEXT_CHARS} chars`, {
        key: "elevenlabsPromptTooLong",
        params: { max: MAX_TEXT_CHARS, current: text.length },
      });
    }
  }

  private buildBody(input: AudioInput): { model: string; input: Record<string, unknown> } {
    const ms = input.modelSettings ?? {};
    this.guardTextLength(input.prompt);

    if (this.modelId === "tts-el") {
      const modelIdSetting =
        typeof ms.model_id === "string" ? ms.model_id : "eleven_multilingual_v2";
      const model = TTS_MODEL_NAMES[modelIdSetting] ?? DEFAULT_TTS_MODEL;

      // voice_id (webapp picker) takes precedence over the legacy voiceId param.
      // The strict gate lives in `submitAudio`; here we stay defensive — an
      // unknown id (e.g. a stale ElevenLabs voice) falls back to the default so
      // kie.ai never receives a value outside its fixed enum (→ 422).
      const requested = (ms.voice_id as string | undefined) || input.voiceId || undefined;
      const voice =
        requested && KIE_ELEVENLABS_VOICE_IDS.has(requested)
          ? requested
          : KIE_ELEVENLABS_DEFAULT_VOICE_ID;

      return {
        model,
        input: {
          text: input.prompt,
          voice,
          stability: clamp01(ms.stability, 0.5),
          similarity_boost: clamp01(ms.similarity_boost, 0.75),
          style: clamp01(ms.style, 0.0),
        },
      };
    }

    // sounds-el / music-el → elevenlabs/sound-effect-v2.
    const rawDuration =
      typeof ms.duration_seconds === "number"
        ? ms.duration_seconds
        : this.soundEffectDefaultDuration();
    const durationSeconds = Math.min(Math.max(rawDuration, SFX_MIN_DURATION), SFX_MAX_DURATION);

    return {
      model: SOUND_EFFECT_MODEL,
      input: {
        text: input.prompt,
        duration_seconds: durationSeconds,
        prompt_influence: clamp01(ms.prompt_influence, 0.3),
        output_format: SFX_OUTPUT_FORMAT,
      },
    };
  }

  async submit(input: AudioInput): Promise<string> {
    const body = this.buildBody(input);

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
      throw new Error(`KIE audio submit error ${resp.status}: ${txt}`);
    }

    const data = (await resp.json()) as KieSubmitResponse;
    if (data.code !== 200 || !data.data?.taskId) {
      const msg = data.msg ?? "no taskId in response";
      // 402 = Insufficient Credits — kie.ai account is empty, affects every user
      // until topped up. Generic "temporarily unavailable" + deduped ops alert
      // (mirror KieSunoAdapter). Separate dedup key from Suno so alerts don't merge.
      if (data.code === 402) {
        const modelName = AI_MODELS[this.modelId]?.name ?? this.modelId;
        throw new UserFacingError(`KIE audio submit failed: 402 — ${msg}`, {
          key: "modelTemporarilyUnavailable",
          section: "audio",
          params: { modelName },
          notifyOps: true,
          opsAlertDedupKey: "kie-audio-credits-exhausted",
        });
      }
      throw new Error(`KIE audio submit failed: ${data.code} — ${msg}`);
    }
    return data.data.taskId;
  }

  async poll(taskId: string): Promise<AudioResult | null> {
    const resp = await fetchWithLog(
      `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
      this.fetchFn,
    );

    if (!resp.ok) throw new Error(`KIE audio poll error ${resp.status}`);

    const data = (await resp.json()) as KieTaskResponse;
    if (data.code !== 200 || !data.data) {
      throw new Error(`KIE audio poll failed: ${data.code} — ${data.msg}`);
    }

    const task = data.data;

    if (task.state === "fail") {
      const failMsg = task.failMsg ?? "unknown error";
      const failCode = task.failCode;
      const technicalMessage = `KIE ${this.modelId} generation failed: ${failCode ?? ""} ${failMsg}`;
      // Transient kie.ai infra error — valid taskId, their backend hiccupped.
      // Plain Error so BullMQ retries (mirror kie.adapter.ts / isKieTransientError).
      if (
        failCode === "422" &&
        /playground failed|task id is blank|client closed request/i.test(failMsg)
      ) {
        throw new Error(technicalMessage);
      }
      // Content moderation — user must change the prompt.
      if (
        failCode === "501" ||
        /sensitiv|policy|prohibited|moderation|blocked|rejected|inappropriate/i.test(failMsg)
      ) {
        throw new UserFacingError(technicalMessage, {
          key: "contentPolicyViolation",
          section: "audio",
        });
      }
      throw new Error(technicalMessage);
    }

    if (task.state !== "success") return null;

    if (!task.resultJson) throw new Error("KIE audio: no resultJson in completed task");
    const result = JSON.parse(task.resultJson) as { resultUrls?: string[] };
    const url = result.resultUrls?.[0];
    if (!url) throw new Error("KIE audio: no result URL in resultJson");

    // output_format is always mp3_* → fixed ext/contentType.
    return { url, ext: "mp3", contentType: "audio/mpeg" };
  }
}
