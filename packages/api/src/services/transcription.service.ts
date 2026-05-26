import OpenAI, { type ClientOptions as OpenAIClientOptions } from "openai";
import { transcodeToMp3 } from "../utils/audio-transcode.js";
import { logger } from "../logger.js";
import { acquireKey, recordSuccess, recordError, markRateLimited } from "./key-pool.service.js";
import { classifyRateLimit } from "../utils/rate-limit-error.js";
import { buildProxyFetch } from "../ai/transport/proxy-fetch.js";

/**
 * Whisper API принимает только эти расширения. Любое другое → 400
 * "Invalid file format". Поэтому всё, что не в whitelist'е, прогоняем
 * через ffmpeg → mp3. Список из официальной OpenAI-ошибки.
 */
const WHISPER_SUPPORTED_EXTS = new Set([
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "oga",
  "ogg",
  "wav",
  "webm",
]);

/**
 * Transcribes an audio buffer to text using OpenAI Whisper API.
 * Любой формат вне whitelist'а Whisper'а транскодится в MP3 через ffmpeg
 * (Telegram voice = OGG/Opus всегда транскодим; обычные audio с экзотическим
 * mime типа application/quicktime / video/* — тоже).
 *
 * Ключ берётся из пула (provider="openai"). PoolExhaustedError всплывает наверх —
 * caller (бот) должен показать пользователю сообщение об ошибке.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
  language?: string,
): Promise<string> {
  const rawExt = mimeType.split("/")[1]?.replace(/;.*/, "").toLowerCase() ?? "";
  const needsTranscode = !WHISPER_SUPPORTED_EXTS.has(rawExt);
  const buffer = needsTranscode ? await transcodeToMp3(audioBuffer) : audioBuffer;
  const ext = needsTranscode ? "mp3" : rawExt;

  const file = new File([buffer], `voice.${ext}`, { type: `audio/${ext}` });

  const acquired = await acquireKey("openai");
  const fetchFn = buildProxyFetch(acquired.proxy) ?? undefined;
  const client = new OpenAI({
    apiKey: acquired.apiKey,
    ...(fetchFn ? { fetch: fetchFn as unknown as OpenAIClientOptions["fetch"] } : {}),
  });

  try {
    const result = await client.audio.transcriptions.create({
      model: "whisper-1",
      file,
      ...(language ? { language } : {}),
    });
    if (acquired.keyId) void recordSuccess(acquired.keyId);
    logger.debug({ language, textLength: result.text.length }, "transcribeAudio: done");
    return result.text;
  } catch (err) {
    if (acquired.keyId) {
      const cls = classifyRateLimit(err, "openai");
      if (cls.isRateLimit) {
        void markRateLimited(acquired.keyId, cls.cooldownMs, cls.reason);
      } else {
        void recordError(acquired.keyId, err instanceof Error ? err.message : String(err));
      }
    }
    throw err;
  }
}
