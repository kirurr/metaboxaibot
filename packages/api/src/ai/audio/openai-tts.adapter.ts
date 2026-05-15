import OpenAI, { type ClientOptions as OpenAIClientOptions } from "openai";
import type { AudioAdapter, AudioInput, AudioResult } from "./base.adapter.js";
import { config } from "@metabox/shared";
import { logCall } from "../../utils/fetch.js";

const DEFAULT_VOICE: OpenAI.Audio.Speech.SpeechCreateParams["voice"] = "alloy";

/**
 * OpenAI Text-to-Speech adapter — synchronous, returns MP3 buffer.
 */
export class OpenAiTtsAdapter implements AudioAdapter {
  readonly modelId = "tts-openai";
  readonly isAsync = false;

  private client: OpenAI;

  constructor(apiKey = config.ai.openai, fetchFn?: typeof globalThis.fetch) {
    this.client = new OpenAI({
      apiKey,
      ...(fetchFn ? { fetch: fetchFn as unknown as OpenAIClientOptions["fetch"] } : {}),
    });
  }

  async generate(input: AudioInput): Promise<AudioResult> {
    const ms = input.modelSettings ?? {};
    const model = ((ms.model as string | undefined) ??
      "tts-1") as OpenAI.Audio.Speech.SpeechCreateParams["model"];
    const voice = ((ms.voice as string | undefined) ??
      input.voiceId ??
      DEFAULT_VOICE) as OpenAI.Audio.Speech.SpeechCreateParams["voice"];
    const speed = (ms.speed as number | undefined) ?? 1.0;
    const format = ((ms.format as string | undefined) ??
      "mp3") as OpenAI.Audio.Speech.SpeechCreateParams["response_format"];
    const instructions =
      model === "gpt-4o-mini-tts" ? (ms.instructions as string | undefined) : undefined;

    logCall(model as string, "tts", {
      voice,
      speed,
      format,
      ...(instructions ? { instructions } : {}),
    });
    const response = await this.client.audio.speech.create({
      model,
      input: input.prompt,
      voice,
      speed,
      response_format: format,
      ...(instructions ? { instructions } : {}),
    } as OpenAI.Audio.Speech.SpeechCreateParams);

    const ext =
      format === "opus"
        ? "ogg"
        : format === "aac"
          ? "aac"
          : format === "flac"
            ? "flac"
            : format === "wav"
              ? "wav"
              : "mp3";
    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, ext, contentType: `audio/${ext === "mp3" ? "mpeg" : ext}` };
  }
}
