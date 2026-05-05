import type { AudioAdapter } from "./base.adapter.js";
import { OpenAiTtsAdapter } from "./openai-tts.adapter.js";
import { ElevenLabsAdapter } from "./elevenlabs.adapter.js";
import { CartesiaAdapter } from "./cartesia.adapter.js";
import { ApipassSunoAdapter } from "./apipass-suno.adapter.js";
import { KieSunoAdapter } from "./kie-suno.adapter.js";
import { buildProxyFetch } from "../transport/proxy-fetch.js";
import type { AdapterContext } from "../with-pool.js";
import { AI_MODELS, type AIModel } from "@metabox/shared";

export { ElevenLabsAdapter, CartesiaAdapter };

/**
 * Создаёт audio-адаптер по `modelId` или `AIModel` объекту.
 *
 * `AIModel`-вариант нужен для fallback: у fallback-модели тот же `id` что и у
 * primary, но другой `provider` — lookup по id вернул бы primary вместо
 * fallback. Mirror'ит поведение `createLLMAdapter` / `createVideoAdapter`.
 */
export function createAudioAdapter(
  modelOrId: string | AIModel,
  ctx?: AdapterContext,
): AudioAdapter {
  const model = typeof modelOrId === "string" ? AI_MODELS[modelOrId] : modelOrId;
  const modelId = typeof modelOrId === "string" ? modelOrId : modelOrId.id;
  const apiKey = ctx?.apiKey;
  const fetchFn = ctx ? (buildProxyFetch(ctx.proxy) ?? undefined) : undefined;

  switch (modelId) {
    case "tts-openai":
      return new OpenAiTtsAdapter(apiKey, fetchFn);
    // voice-clone — generic ID для UI кнопки "Клонирование голоса". Под капотом
    // теперь Cartesia (заменили ElevenLabs из-за более жёстких лимитов EL на
    // slot'ы клонированных голосов). Legacy UserVoice записи с provider="elevenlabs"
    // продолжают работать через `resolveVoiceForTTS` — ему передаётся voice.provider,
    // и он выбирает нужный адаптер. Этот фактори используется только для AUDIO
    // generation (TTS), не для самого upload'а на клонирование (тот идёт прямо
    // через CartesiaAdapter.cloneVoice / ElevenLabsAdapter.cloneVoice).
    case "voice-clone":
      return new CartesiaAdapter("voice-clone", apiKey, fetchFn);
    case "tts-cartesia":
      return new CartesiaAdapter("tts-cartesia", apiKey, fetchFn);
    case "tts-el":
      return new ElevenLabsAdapter("tts-el", apiKey, fetchFn);
    case "sounds-el":
      return new ElevenLabsAdapter("sounds-el", apiKey, fetchFn);
    case "music-el":
      return new ElevenLabsAdapter("music-el", apiKey, fetchFn);
    case "suno":
      // Provider-based dispatch: kie primary, apipass fallback (см. MET-148).
      // Если lookup по строке не дал AIModel (legacy / неизвестная конфигурация),
      // дефолтимся на kie — primary в текущем каталоге.
      if (model?.provider === "apipass") return new ApipassSunoAdapter(apiKey, fetchFn);
      return new KieSunoAdapter(apiKey, fetchFn);
    default:
      throw new Error(`Unknown audio model: ${modelId}`);
  }
}
