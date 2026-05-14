import type { AudioAdapter, AudioInput, AudioResult } from "./base.adapter.js";
import {
  AI_MODELS,
  config,
  KIE_ELEVENLABS_DEFAULT_VOICE_ID,
  KIE_ELEVENLABS_VOICE_IDS,
  UserFacingError,
} from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { logger } from "../../logger.js";
import { ElevenLabsAdapter } from "./elevenlabs.adapter.js";
import { acquireKey } from "../../services/key-pool.service.js";
import { envKeyForProvider } from "../key-provider.js";
import { isPoolExhaustedError } from "../../utils/pool-exhausted-error.js";

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

/**
 * Sentinel-префикс для taskId. `submit()` возвращает `el-fallback:<reason>`,
 * когда kie createTask упал — `poll()` ловит этот префикс и генерит напрямую
 * через ElevenLabs. Двоеточие не пересекается с реальными kie taskId (hex/uuid).
 */
const EL_FALLBACK_PREFIX = "el-fallback:";

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

  /**
   * Резолвит ElevenLabs API-ключ для фолбэка: сначала пул (`acquireKey`), при
   * `PoolExhaustedError` — env-fallback (`config.ai.elevenlabs`). Если нет
   * нигде — throw (редкий hard fail; EL-фолбэк без ключа невозможен).
   */
  private async resolveElKey(): Promise<string> {
    try {
      return (await acquireKey("elevenlabs")).apiKey;
    } catch (err) {
      if (!isPoolExhaustedError(err)) throw err;
      const envKey = envKeyForProvider("elevenlabs");
      if (envKey) return envKey;
      throw new Error("ElevenLabs fallback key unavailable: empty pool and no env key");
    }
  }

  /**
   * Прямая генерация через ElevenLabs — переиспользует синхронный
   * `ElevenLabsAdapter`. Результат помечается `actualProvider: "elevenlabs"`,
   * чтобы процессор записал фактического провайдера в аудит.
   *
   * Голос для `tts-el` (try-real-then-default): voice_id из каталога kie сейчас
   * не резолвятся на нашем EL-аккаунте, поэтому попытка 1 идёт с реальным
   * голосом юзера; при plain-сбое попытка 2 повторяется с premade-голосом EL по
   * умолчанию (`ElevenLabsAdapter` сам берёт Rachel, когда voice не задан — для
   * этого снимаем voice_id с input). `UserFacingError` из попытки 1 — финальный
   * вердикт, ре-кидается без попытки 2. `sounds-el`/`music-el` голос не нужен —
   * один вызов, любой throw (вкл. `UserFacingError`) пробрасывается.
   */
  private async generateViaElevenLabs(input: AudioInput): Promise<AudioResult> {
    const elKey = await this.resolveElKey();
    const elAdapter = new ElevenLabsAdapter(this.modelId, elKey, this.fetchFn);

    if (this.modelId !== "tts-el") {
      const result = await elAdapter.generate(input);
      return { ...result, actualProvider: "elevenlabs" };
    }

    try {
      const result = await elAdapter.generate(input);
      return { ...result, actualProvider: "elevenlabs" };
    } catch (err) {
      // UserFacingError из попытки 1 — финальный вердикт, не ретраим, не глотаем.
      if (err instanceof UserFacingError) throw err;
      // Попытка 1 упала (скорее всего kie-voice_id не существует на EL-
      // аккаунте) — повтор с дефолтным premade-голосом EL: снимаем voice_id,
      // `ElevenLabsAdapter.generateSpeech` сам подставит свой DEFAULT_VOICE_ID.
      const retryInput: AudioInput = {
        ...input,
        voiceId: undefined,
        modelSettings: { ...(input.modelSettings ?? {}), voice_id: undefined },
      };
      const result = await elAdapter.generate(retryInput);
      return { ...result, actualProvider: "elevenlabs" };
    }
  }

  /**
   * Сабмит kie createTask. При ЛЮБОМ сбое kie (HTTP non-200, `code≠200`, 402,
   * сетевая ошибка) возвращает sentinel-taskId `el-fallback:<reason>` — `poll()`
   * увидит префикс и сгенерит через прямой ElevenLabs.
   *
   * `buildBody` (вместе с гардом длины, который кидает `UserFacingError`)
   * вызывается ДО `try` — слишком длинный промпт это финальный вердикт юзеру, он
   * никогда не превращается в фолбэк. Внутри `try` `UserFacingError` сейчас не
   * бросается, но `catch` всё равно его ре-кидает — явная гарантия на будущее.
   */
  async submit(input: AudioInput): Promise<string> {
    const body = this.buildBody(input);

    try {
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
        logger.warn(
          { modelId: this.modelId, status: resp.status, body: txt.slice(0, 300) },
          "KIE audio submit HTTP error — falling back to ElevenLabs",
        );
        return `${EL_FALLBACK_PREFIX}http-${resp.status}`;
      }

      const data = (await resp.json()) as KieSubmitResponse;
      if (data.code !== 200 || !data.data?.taskId) {
        const msg = data.msg ?? "no taskId in response";
        // 402 = Insufficient Credits. Раньше бросали UserFacingError(notifyOps);
        // теперь EL-фолбэк сам это покрывает — просто warn. Suno (KieSunoAdapter)
        // по-прежнему алертит ops на свой 402, так что исчерпание кредитов kie
        // всё равно видно операторам.
        logger.warn(
          { modelId: this.modelId, code: data.code, msg },
          "KIE audio submit non-success — falling back to ElevenLabs",
        );
        return `${EL_FALLBACK_PREFIX}code-${data.code}`;
      }
      return data.data.taskId;
    } catch (err) {
      // UserFacingError НИКОГДА не превращается в sentinel/фолбэк.
      if (err instanceof UserFacingError) throw err;
      // Сетевая ошибка / parse — kie недоступен. Фолбэк на ElevenLabs.
      logger.warn(
        { modelId: this.modelId, err },
        "KIE audio submit threw — falling back to ElevenLabs",
      );
      return `${EL_FALLBACK_PREFIX}error`;
    }
  }

  /**
   * Поллинг kie recordInfo. Расширения для EL-фолбэка:
   *  - `taskId` с префиксом `el-fallback:` → kie был недоступен на submit,
   *    генерим напрямую через ElevenLabs из `input`.
   *  - kie `state:"fail"` с модерацией (`failCode 501` / regex) → бросаем
   *    `UserFacingError(contentPolicyViolation)` — EL применяет ту же политику,
   *    фолбэк не поможет; финальный вердикт юзеру, БЕЗ фолбэка.
   *  - kie `state:"fail"` прочее (вкл. `failCode 500`, `422 playground`) →
   *    фолбэк на ElevenLabs.
   *  - ошибка самого poll-запроса (HTTP / parse) → throw (kie-задача жива,
   *    перепол позже; БЕЗ фолбэка).
   *
   * EL-фолбэк (`generateViaElevenLabs`) НЕ оборачивается в catch-all: если EL
   * бросит `UserFacingError` (напр. `sounds-el` промпт >450 симв.), она
   * пробрасывается из `poll()` как есть — процессор покажет её юзеру без списания.
   */
  async poll(taskId: string, input?: AudioInput): Promise<AudioResult | null> {
    // Sentinel из submit(): kie упал ещё на createTask — сразу EL.
    if (taskId.startsWith(EL_FALLBACK_PREFIX)) {
      if (!input) {
        // Legacy in-flight джоба до этого деплоя — нет AudioInput для
        // реконструкции. Деградируем к до-деплойному поведению, не падая молча.
        throw new Error(`KIE audio: EL fallback requested but no input (taskId=${taskId})`);
      }
      return this.generateViaElevenLabs(input);
    }

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

      // Модерация контента — EL применяет ту же политику, фолбэк не поможет.
      // Финальный вердикт юзеру, БЕЗ фолбэка.
      if (
        failCode === "501" ||
        /sensitiv|policy|prohibited|moderation|blocked|rejected|inappropriate/i.test(failMsg)
      ) {
        throw new UserFacingError(technicalMessage, {
          key: "contentPolicyViolation",
          section: "audio",
        });
      }

      // Любой другой terminal-сбой kie (вкл. failCode 500, 422 "playground
      // failed" и т.п.) — kie эту задачу не воскресит. Фолбэк на ElevenLabs.
      if (!input) {
        throw new Error(`${technicalMessage} (no input for EL fallback)`);
      }
      logger.warn(
        { modelId: this.modelId, taskId, failCode, failMsg },
        "KIE audio task failed — falling back to ElevenLabs",
      );
      return this.generateViaElevenLabs(input);
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
