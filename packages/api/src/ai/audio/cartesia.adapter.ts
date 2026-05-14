import type { AudioAdapter, AudioInput, AudioResult } from "./base.adapter.js";
import { config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { transcodeToMp3 } from "../../utils/audio-transcode.js";
import { resolveAudioMimeType } from "../../utils/mime-detect.js";
import { logger } from "../../logger.js";

/**
 * Cartesia /tts/bytes ругается 400/404 на голос, который у нас сохранён,
 * но на стороне провайдера уже не существует (или передан мусор, прошедший
 * структурную валидацию). Отличаем такие ошибки от прочих 4xx (auth, rate
 * limit), чтобы юзер получил понятное «выберите голос», а не generic.
 */
function isCartesiaVoiceError(status: number, body: string): boolean {
  if (status !== 400 && status !== 404) return false;
  const lower = body.toLowerCase();
  return lower.includes("voice");
}

const CARTESIA_API = "https://api.cartesia.ai";

/**
 * Cartesia API version. Определяет shape запросов/ответов. Latest на момент
 * написания — 2026-03-01. При обновлении сверять breaking changes в docs.
 */
const CARTESIA_VERSION = "2026-03-01";

/** Default Cartesia model для TTS. sonic-3 — latest, поддерживает speed/emotion. */
const DEFAULT_TTS_MODEL = "sonic-3";

/** Default voice ID — публичный voice (Cartesia "Kore"). Используется если voice_id не задан. */
const DEFAULT_VOICE_ID = "bf0a246a-8642-498a-9950-80c35e9276b5";

/**
 * Cartesia adapter (voice cloning + TTS).
 *
 * Endpoints (v2026-03-01):
 *  - POST /voices/clone        — multipart upload audio sample → voice_id
 *  - POST /tts/bytes           — synchronous TTS, returns audio bytes
 *  - GET  /voices              — list (для eviction)
 *  - GET  /voices/{id}         — fetch single voice
 *  - DELETE /voices/{id}       — delete voice (free slot)
 *
 * Заменяет ElevenLabs для voice cloning. EL остаётся для music-el / sounds-el
 * (Cartesia их не делает) и legacy custom voices до их естественного re-clone'а
 * через `evictOneCartesiaVoice` (см. user-voice.service.ts).
 */
export class CartesiaAdapter implements AudioAdapter {
  readonly isAsync = false;

  constructor(
    readonly modelId: "voice-clone" | "tts-cartesia",
    private readonly apiKey = config.ai.cartesia ?? "",
    private readonly fetchFn?: typeof globalThis.fetch,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Cartesia-Version": CARTESIA_VERSION,
      ...(extra ?? {}),
    };
  }

  async generate(input: AudioInput): Promise<AudioResult> {
    return this.generateSpeech(input);
  }

  /**
   * Synchronous TTS via /tts/bytes. Возвращает MP3-байты.
   *
   * voice_id берётся из modelSettings.voice_id (webapp picker) или input.voiceId
   * (legacy). Без voice_id — DEFAULT_VOICE_ID (публичный голос).
   */
  private async generateSpeech(input: AudioInput): Promise<AudioResult> {
    const ms = input.modelSettings ?? {};
    const voiceId = (ms.voice_id as string | undefined) || input.voiceId || DEFAULT_VOICE_ID;
    const modelId = (ms.model_id as string | undefined) ?? DEFAULT_TTS_MODEL;
    // language: явно указан (не "auto") → передаём; "auto" или не задано в UI →
    // не передаём, Cartesia определит сам по тексту/голосу. Legacy-путь (без
    // modelSettings вообще, т.е. вызов из bot напрямую) сохраняет старый
    // дефолт "ru" для обратной совместимости.
    const languageRaw = ms.language as string | undefined;
    let language: string | null;
    if (languageRaw && languageRaw !== "auto") {
      language = languageRaw;
    } else if (input.modelSettings) {
      language = null;
    } else {
      language = "ru";
    }
    const speed = typeof ms.speed === "number" ? ms.speed : undefined;
    const volume = typeof ms.volume === "number" ? ms.volume : undefined;
    const emotion = ms.emotion as string | undefined;

    // generation_config работает только для sonic-3. Для legacy моделей передаём
    // только базовые поля. Дефолты 1.0 не отправляем — лишний шум в payload'е.
    const generationConfig: Record<string, unknown> = {};
    if (modelId === "sonic-3") {
      if (speed !== undefined && speed !== 1) generationConfig.speed = speed;
      if (volume !== undefined && volume !== 1) generationConfig.volume = volume;
      if (emotion) generationConfig.emotion = emotion;
    }

    const body: Record<string, unknown> = {
      model_id: modelId,
      transcript: input.prompt,
      voice: { mode: "id", id: voiceId },
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
    };
    if (language) body.language = language;
    if (Object.keys(generationConfig).length > 0) body.generation_config = generationConfig;

    const res = await fetchWithLog(
      `${CARTESIA_API}/tts/bytes`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      },
      this.fetchFn,
    );

    if (!res.ok) {
      const text = await res.text();
      if (isCartesiaVoiceError(res.status, text)) {
        throw new UserFacingError(`Cartesia TTS voice unavailable: ${res.status} ${text}`, {
          key: "ttsVoiceUnavailable",
          section: "audio",
        });
      }
      throw new Error(`Cartesia TTS failed: ${res.status} ${text}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, ext: "mp3", contentType: "audio/mpeg" };
  }

  /**
   * Clone a voice from an audio buffer via POST /voices/clone (multipart).
   * Returns the new voice_id. Static — used directly from voice-create flows
   * без инстанцирования адаптера.
   *
   * `language` — основной язык клонируемого голоса (en/ru/...). Cartesia
   * допускает многоязычное использование, но указание основного помогает
   * качеству.
   */
  static async cloneVoice(
    audioBuffer: Buffer,
    filename: string,
    name: string,
    language: string = "ru",
    apiKey: string = config.ai.cartesia ?? "",
  ): Promise<string> {
    // Telegram голосовые приходят как OGG/Opus (.oga), аудиофайлы — в любом
    // контейнере. Cartesia clone-эндпоинт надёжно ест mp3/wav; всё остальное
    // транскодим в MP3, иначе ловим 422 "could not be processed". Битый/
    // не-аудио вход → ffmpeg бросит → UserFacingError (user-fault, не наш баг).
    const contentType = resolveAudioMimeType(audioBuffer, null);
    let clipBuffer = audioBuffer;
    let clipName = filename;
    if (contentType !== "audio/mpeg" && contentType !== "audio/wav") {
      logger.info({ from: contentType }, "Cartesia: transcoding clone clip to MP3");
      try {
        clipBuffer = await transcodeToMp3(audioBuffer);
      } catch (err) {
        throw new UserFacingError(
          `Cartesia clone clip transcode to MP3 failed: ${err instanceof Error ? err.message : String(err)}`,
          { key: "voiceCloneBadAudio", section: "audio", cause: err },
        );
      }
      clipName = `${filename.replace(/\.[^.]+$/, "")}.mp3`;
    }

    const form = new FormData();
    form.append("clip", new Blob([clipBuffer]), clipName);
    form.append("name", name);
    form.append("language", language);

    const res = await fetch(`${CARTESIA_API}/voices/clone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Cartesia-Version": CARTESIA_VERSION,
      },
      body: form,
    });

    if (!res.ok) {
      const text = await res.text();
      // 422 "could not be processed" / "valid audio file" — Cartesia не смогла
      // разобрать клип (слишком короткий, тихий, битый). Это user-fault: retry
      // с тем же файлом бесполезен, ops алёртить незачем — юзеру нужен внятный
      // мессадж про требования к записи.
      if (res.status === 422 && /could not be processed|valid audio file/i.test(text)) {
        throw new UserFacingError(`Cartesia voice clone rejected audio: ${res.status} ${text}`, {
          key: "voiceCloneBadAudio",
          section: "audio",
        });
      }
      throw new Error(`Cartesia voice clone failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { id: string };
    return data.id;
  }

  /**
   * Deletes a voice from Cartesia. Returns true on success (2xx или 404 —
   * слот свободен в любом случае), false otherwise. Логирует ошибку.
   */
  static async deleteVoice(
    voiceId: string,
    apiKey: string = config.ai.cartesia ?? "",
  ): Promise<boolean> {
    try {
      const res = await fetch(`${CARTESIA_API}/voices/${voiceId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Cartesia-Version": CARTESIA_VERSION,
        },
      });
      if (res.ok || res.status === 404) return true;
      const body = await res.text().catch(() => "");
      logger.error({ voiceId, status: res.status, body }, "Cartesia deleteVoice failed");
      return false;
    } catch (reason) {
      logger.error({ voiceId, reason }, "Cartesia deleteVoice network error");
      return false;
    }
  }

  /**
   * Fetch a single voice. Returns null on 404 (voice не существует) или прочей ошибке.
   * Используется для проверки `voiceExistsOn` — есть ли voice на конкретном ключе.
   */
  static async getVoice(
    voiceId: string,
    apiKey: string = config.ai.cartesia ?? "",
  ): Promise<{ id: string; is_owner: boolean; name: string } | null> {
    try {
      const res = await fetch(`${CARTESIA_API}/voices/${voiceId}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Cartesia-Version": CARTESIA_VERSION,
        },
      });
      if (!res.ok) return null;
      return (await res.json()) as { id: string; is_owner: boolean; name: string };
    } catch {
      return null;
    }
  }

  /**
   * Lists all owned voices on the Cartesia account. Paginates через
   * `starting_after` cursor. Возвращает только cloned (is_owner=true) — premade
   * голоса не нужны для eviction (их нельзя удалить и они не занимают slot'ы юзера).
   */
  static async listVoices(
    apiKey: string = config.ai.cartesia ?? "",
  ): Promise<Array<{ voice_id: string; name: string; created_at_unix?: number }>> {
    const all: Array<{ voice_id: string; name: string; created_at_unix?: number }> = [];
    let cursor: string | undefined;
    // Защита от runaway цикла: 50 страниц × 100 voices = 5000 — больше чем
    // можно реалистично иметь в одном аккаунте.
    for (let page = 0; page < 50; page++) {
      const url = new URL(`${CARTESIA_API}/voices`);
      url.searchParams.set("limit", "100");
      url.searchParams.set("is_owner", "true");
      if (cursor) url.searchParams.set("starting_after", cursor);

      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Cartesia-Version": CARTESIA_VERSION,
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Cartesia listVoices failed: ${res.status} ${body}`);
      }
      const data = (await res.json()) as {
        data: Array<{ id: string; name?: string; created_at?: string }>;
        has_more?: boolean;
      };
      for (const v of data.data) {
        all.push({
          voice_id: v.id,
          name: v.name ?? "",
          // Cartesia возвращает ISO date в `created_at`, конвертим в unix-timestamp
          // для совместимости с EL-шаблоном (orderBy oldest first для LRU eviction).
          created_at_unix: v.created_at
            ? Math.floor(new Date(v.created_at).getTime() / 1000)
            : undefined,
        });
      }
      if (!data.has_more || data.data.length === 0) break;
      cursor = data.data[data.data.length - 1].id;
    }
    return all;
  }
}
