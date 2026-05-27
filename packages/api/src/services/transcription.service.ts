import OpenAI, { type ClientOptions as OpenAIClientOptions } from "openai";
import { transcodeToMp3 } from "../utils/audio-transcode.js";
import { logger } from "../logger.js";
import { buildProxyFetch } from "../ai/transport/proxy-fetch.js";
import { withKeyRetry } from "../utils/with-key-retry.js";

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
 * Ключ берётся из пула (provider="openai") через `withKeyRetry`: на 429 /
 * billing-error ключ помечается throttled и пробуется следующий. Без этого
 * первый юзер, попавший на ключ-только-что-сдох, словил бы «не удалось
 * распознать речь» — хотя в пуле есть живые ключи.
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

  return withKeyRetry("openai", async (acquired) => {
    const fetchFn = buildProxyFetch(acquired.proxy) ?? undefined;
    const client = new OpenAI({
      apiKey: acquired.apiKey,
      ...(fetchFn ? { fetch: fetchFn as unknown as OpenAIClientOptions["fetch"] } : {}),
    });
    const result = await client.audio.transcriptions.create({
      model: "whisper-1",
      file,
      ...(language ? { language } : {}),
    });
    logger.debug({ language, textLength: result.text.length }, "transcribeAudio: done");
    return result.text;
  });
}
