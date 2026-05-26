import OpenAI, { type ClientOptions as OpenAIClientOptions } from "openai";
import { transcodeOggToMp3 } from "../utils/audio-transcode.js";
import { logger } from "../logger.js";
import { buildProxyFetch } from "../ai/transport/proxy-fetch.js";
import { withKeyRetry } from "../utils/with-key-retry.js";

/**
 * Transcribes an audio buffer to text using OpenAI Whisper API.
 * Automatically transcodes OGG/Opus (Telegram voice) to MP3 before sending.
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
  const isOgg = mimeType.includes("ogg") || mimeType.includes("opus");
  const buffer = isOgg ? await transcodeOggToMp3(audioBuffer) : audioBuffer;
  const ext = isOgg ? "mp3" : (mimeType.split("/")[1]?.replace(/;.*/, "") ?? "mp3");

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
