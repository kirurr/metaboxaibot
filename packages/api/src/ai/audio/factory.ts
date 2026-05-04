import type { AudioAdapter } from "./base.adapter.js";
import { OpenAiTtsAdapter } from "./openai-tts.adapter.js";
import { ElevenLabsAdapter } from "./elevenlabs.adapter.js";
import { CartesiaAdapter } from "./cartesia.adapter.js";
// ApipassSunoAdapter временно не импортируется здесь — после переключения
// Suno на kie он остаётся в репе ради шага 2 этого тикета (fallback на kie
// через FALLBACK_AUDIO_MODELS). Импорт вернётся со вторым коммитом.
import { KieSunoAdapter } from "./kie-suno.adapter.js";
import { buildProxyFetch } from "../transport/proxy-fetch.js";
import type { AdapterContext } from "../with-pool.js";

export { ElevenLabsAdapter, CartesiaAdapter };

export function createAudioAdapter(modelId: string, ctx?: AdapterContext): AudioAdapter {
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
      // Suno переведён на kie (с fallback на apipass — подключается отдельно
      // через FALLBACK_AUDIO_MODELS, см. MET-148). ApipassSunoAdapter
      // оставлен в кодовой базе именно ради этого fallback.
      return new KieSunoAdapter(apiKey, fetchFn);
    default:
      throw new Error(`Unknown audio model: ${modelId}`);
  }
}
