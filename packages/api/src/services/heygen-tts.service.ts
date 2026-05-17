import { AI_MODELS, UserFacingError } from "@metabox/shared";
import { HeyGenAdapter } from "../ai/video/heygen.adapter.js";
import { buildProxyFetch } from "../ai/transport/proxy-fetch.js";
import { acquireKey, markRateLimited } from "./key-pool.service.js";
import { PoolExhaustedError } from "../utils/pool-exhausted-error.js";
import { userStateService } from "./user-state.service.js";
import { getFileUrl, uploadBuffer } from "./s3.service.js";
import { calculateCost, checkBalance } from "./token.service.js";
import { db } from "../db.js";
import { randomBytes } from "crypto";
import { logger } from "../logger.js";
import type { SubmitVideoParams } from "./video-generation.service.js";

/**
 * Pre-flight нижняя оценка длительности будущего HeyGen TTS по длине промпта:
 * 8 chars/sec ≈ медленная речь, floor 5 сек. Используется ТОЛЬКО для отказа
 * заведомо бедным юзерам ДО оплачиваемого вызова HeyGen TTS — финальная цена
 * считается уже по фактической длительности возвращённого аудио (повторный
 * `checkBalance` внутри `previewVideo`).
 */
const TTS_PREFLIGHT_CHARS_PER_SEC = 8;
const TTS_PREFLIGHT_MIN_SECONDS = 5;

/** HeyGen Starfish `/v3/voices/speech` принимает text 1..5000 chars. */
const HEYGEN_TTS_MAX_CHARS = 5000;

function isExternalVoiceProvider(voiceProvider: unknown): boolean {
  return voiceProvider === "elevenlabs" || voiceProvider === "cartesia";
}

/**
 * Совпадает с lookup'ом в `worker/.../video.processor.ts:295-304`. Если
 * `voice_id` соответствует записи в `UserVoice` (клонированный голос
 * Cartesia/EL) — значит это НЕ HeyGen native voice, и наш TTS не нужен.
 * Воркер дальше сам сделает EL/Cartesia TTS через resolveVoiceForTTS.
 *
 * Без этой проверки legacy userState с `voice_id`=UserVoice.id и без
 * `voice_provider` (старый picker) или любой будущий caller с per-request
 * `voice_id` без `voice_provider` приводил бы к ложному
 * `heygenVoiceNotFound`: HeyGen 400'ит на чужой voice_id.
 */
async function isUserClonedVoice(voiceId: string): Promise<boolean> {
  // OR-запрос вместо двух последовательных — экономим один round-trip
  // на каждый HeyGen сабмит. `.catch` логирует, чтобы DB-outage не
  // маскировался под "не UserVoice" и не приводил юзера к misleading
  // `heygenVoiceNotFound` (на самом деле просто DB упал).
  const v = await db.userVoice
    .findFirst({
      where: { OR: [{ id: voiceId }, { externalId: voiceId }] },
      select: { id: true },
    })
    .catch((err) => {
      logger.warn(
        { err, voiceId },
        "isUserClonedVoice: DB lookup failed, assuming HeyGen-native (may misroute)",
      );
      return null;
    });
  return !!v;
}

function resolveSpeed(settings: Record<string, unknown>): number | undefined {
  // `voice_speed` доступен только если юзер включил `voice_settings_enabled`
  // (см. video.models.ts:1090). Не включён → HeyGen использует свой default 1.0.
  if (settings.voice_settings_enabled !== true) return undefined;
  const raw = settings.voice_speed;
  if (typeof raw !== "number" || !isFinite(raw)) return undefined;
  // HeyGen documented range 0.5..2.0; каталог сужает до 0.5..1.5. Зажимаем
  // на всякий случай (stale userState из старого слайдера = 4xx от HeyGen).
  return Math.min(2.0, Math.max(0.5, raw));
}

function resolveLocale(settings: Record<string, unknown>): string | undefined {
  // `voice_locale` (BCP-47, напр. "pt-BR") применяется только если юзер
  // включил `voice_settings_enabled` — иначе HeyGen авто-детектит по тексту.
  // Раньше locale уходил через `body.voice_settings.locale` в inline-TTS пути;
  // теперь native-voice идёт через pre-gen `/v3/voices/speech`, поэтому надо
  // явно пробрасывать в `opts.locale` адаптера. Иначе регрессия: юзер
  // включил ru-RU, а получит default локаль.
  if (settings.voice_settings_enabled !== true) return undefined;
  const raw = settings.voice_locale;
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

/**
 * Юзер выставил кастомный pitch — `/v3/voices/speech` (Starfish) не документирует
 * pitch parameter, передавать наугад нельзя (рискуем 400 и сломанным TTS).
 * Поэтому для таких юзеров используем гибридный режим: всё равно зовём наш
 * TTS чтобы узнать длительность (закрывает уход в минус), но в видео аудио
 * НЕ кладём — пускай HeyGen рендерит inline-TTS со своим pitch через
 * `body.voice_settings.pitch` (см. heygen.adapter.ts:436). Цена видео та же,
 * +1 наш TTS-вызов (~$0.005). Сам аудио мы выбрасываем.
 */
function hasCustomPitch(settings: Record<string, unknown>): boolean {
  if (settings.voice_settings_enabled !== true) return false;
  const raw = settings.voice_pitch;
  return typeof raw === "number" && isFinite(raw) && raw !== 0;
}

interface HeygenTtsResult {
  /**
   * S3-ключ загруженного mp3 или `null` если аудио не материализовано — три
   * случая: (1) pitch-bypass, (2) CDN download HeyGen'а упал, (3) S3 upload
   * упал. Во всех трёх caller инжектит только `audioDurationSecHint` без
   * `voice_audio` — HeyGen дальше сделает inline-TTS при рендере видео.
   */
  s3Key: string | null;
  /** Точная длительность синтезированного аудио в секундах (из HeyGen response). */
  durationSec: number;
}

/**
 * Синтезирует речь через HeyGen Starfish (`POST /v3/voices/speech`) и опц.
 * грузит mp3 в S3. Возвращает `{ s3Key, durationSec }`. На любой
 * материализационный фейл (pitch, CDN, S3) — `s3Key: null` с длительностью
 * сохранённой (caller дальше работает по inline-TTS пути HeyGen).
 *
 * Pre-flight `checkBalance` бьётся ДО оплачиваемого TTS-вызова, чтобы
 * бедных юзеров отсечь без затрат. 4xx/5xx/429 проброшены как
 * `UserFacingError` с понятным ключом. Null также возвращается если pre-gen
 * вообще не нужен (модель не HeyGen, пустой prompt, voice_id не задан,
 * voice_provider сторонний, voice_id — клонированный UserVoice).
 */
async function preGenerateHeygenTts(
  userId: bigint,
  modelId: string,
  prompt: string,
  fullModelSettings: Record<string, unknown>,
): Promise<HeygenTtsResult | null> {
  if (modelId !== "heygen") return null;
  const trimmed = prompt.trim();
  if (!trimmed) return null;

  // typeof guard — legacy userState может хранить voice_id как number/null;
  // `as string` без проверки приводил бы к TypeError на `.trim()`.
  const rawVoiceId = fullModelSettings.voice_id;
  const voiceId = typeof rawVoiceId === "string" ? rawVoiceId.trim() : "";
  if (!voiceId) return null;

  if (isExternalVoiceProvider(fullModelSettings.voice_provider)) return null;

  // Skip если voice_id указывает на клонированный UserVoice — это
  // EL/Cartesia, не HeyGen native. Воркер сам поднимет EL/Cartesia TTS
  // через `resolveVoiceForTTS` (см. video.processor.ts:296). Без skip:
  // мы бы дёрнули HeyGen Starfish с чужим voice_id и получили 400.
  if (await isUserClonedVoice(voiceId)) {
    logger.info(
      { voiceId, userId },
      "preGenerateHeygenTts: voice_id is a UserVoice — deferring TTS to worker",
    );
    return null;
  }

  if (trimmed.length > HEYGEN_TTS_MAX_CHARS) {
    throw new UserFacingError(
      `HeyGen TTS text too long (${trimmed.length} > ${HEYGEN_TTS_MAX_CHARS})`,
      { key: "promptTooLong", params: { limit: HEYGEN_TTS_MAX_CHARS } },
    );
  }

  const model = AI_MODELS[modelId];
  if (!model) {
    logger.warn({ modelId }, "preGenerateHeygenTts: model not in catalog");
    return null;
  }

  const speed = resolveSpeed(fullModelSettings);
  const locale = resolveLocale(fullModelSettings);

  // Pre-flight: cmd/sec scaled by speed. При speed=0.5 реальное аудио
  // в ~2 раза длиннее → нужен и более жёсткий минимум. Без масштабирования
  // на длинных промптах с медленной речью pre-flight пропускал, а финальный
  // checkBalance падал ПОСЛЕ оплаченного TTS-вызова.
  const effectiveCharsPerSec = TTS_PREFLIGHT_CHARS_PER_SEC * (speed ?? 1);
  const minDurationSec = Math.max(
    TTS_PREFLIGHT_MIN_SECONDS,
    Math.ceil(trimmed.length / effectiveCharsPerSec),
  );
  const preflightCost = calculateCost(
    model,
    0,
    0,
    undefined,
    undefined,
    fullModelSettings,
    minDurationSec,
  );
  await checkBalance(userId, preflightCost);

  const acquired = await acquireKey("heygen");
  const fetchFn = acquired.proxy ? (buildProxyFetch(acquired.proxy) ?? undefined) : undefined;
  const adapter = new HeyGenAdapter(acquired.apiKey, undefined, fetchFn);

  // Pitch не поддерживается `/v3/voices/speech` параметром — для таких юзеров
  // нам нужна ТОЛЬКО длительность, аудио выбросим. HeyGen на сабмите видео
  // сам перегенерит со своим `voice_settings.pitch`.
  const skipAudioFetch = hasCustomPitch(fullModelSettings);
  const ttsOpts = {
    ...(speed !== undefined ? { speed } : {}),
    ...(locale ? { locale } : {}),
    ...(skipAudioFetch ? { skipAudioFetch: true } : {}),
  };

  let buffer: Buffer | null = null;
  let durationSec = 0;
  // 5xx — транзиентные ошибки HeyGen, делаем до 2 повторов с backoff. 4xx —
  // клиентская ошибка, повтор не поможет. 429 — пометим ключ throttled.
  // CDN-fail после успешного TTS НЕ throw'ит — `generateSpeech` сам деградирует
  // до `buffer:null`, ниже мы это обработаем как pitch-bypass.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      ({ buffer, durationSec } = await adapter.generateSpeech(trimmed, voiceId, ttsOpts));
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const m = msg.match(/HeyGen \S+ failed:\s*(\d{3})\s*(.*)/);
      const status = m ? Number(m[1]) : 0;
      const body = m?.[2] ?? "";

      if (status === 429) {
        if (acquired.keyId) {
          await markRateLimited(acquired.keyId, 60_000, "tts-429").catch(() => void 0);
        }
        throw new UserFacingError("HeyGen TTS rate-limited", {
          key: "modelTemporarilyUnavailable",
          section: "video",
          params: { modelName: "HeyGen" },
        });
      }

      if (status === 400 || status === 404) {
        // Различаем 4xx по телу: модерация → heygenInvalidText, проблема с
        // голосом → heygenVoiceNotFound, иначе общий heygenRejected (чтобы
        // не вводить юзера в заблуждение, если дело не в голосе).
        if (/moderation|policy|inappropriate|prohibited/i.test(body)) {
          throw new UserFacingError("HeyGen TTS text rejected by moderation", {
            key: "heygenInvalidText",
          });
        }
        if (/voice|not.?found|invalid_voice|unsupported/i.test(body)) {
          throw new UserFacingError("HeyGen voice incompatible with TTS", {
            key: "heygenVoiceNotFound",
          });
        }
        throw new UserFacingError("HeyGen TTS rejected request", {
          key: "heygenRejected",
        });
      }

      if (status >= 500 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      // Финальная 5xx, malformed response, sanity-clamp duration>600 — всё
      // это transient/contract-level фейл HeyGen'а, юзер должен видеть
      // понятное «временно недоступно», а не generic generationFailed.
      throw new UserFacingError("HeyGen TTS unavailable", {
        key: "modelTemporarilyUnavailable",
        section: "video",
        params: { modelName: "HeyGen" },
      });
    }
  }

  // CDN-flake или pitch-bypass: длительность знаем, аудио нет. HeyGen на
  // сабмите сделает inline-TTS — цена видео та же, +1 их TTS-вызов.
  if (buffer === null) {
    logger.info(
      {
        userId,
        voiceId,
        durationSec,
        chars: trimmed.length,
        reason: skipAudioFetch ? "pitch" : "cdn-fail",
      },
      "HeyGen TTS: audio not materialized, inline-TTS will run at submit",
    );
    return { s3Key: null, durationSec };
  }

  // Date.now()+random — защита от коллизии при rapid submit'ах из одного userId.
  const s3Key = `voice/heygen-tts/${userId.toString()}/${Date.now()}-${randomBytes(4).toString("hex")}.mp3`;
  const uploadedKey = await uploadBuffer(s3Key, buffer, "audio/mpeg").catch((err) => {
    logger.warn({ err, s3Key }, "HeyGen TTS: S3 upload failed");
    return null;
  });
  if (!uploadedKey) {
    // S3 принципиально недоступен. Деградируем до inline-TTS пути, как при
    // CDN-fail: видео всё равно сгенерится, юзер получит результат.
    logger.warn(
      { userId, voiceId, durationSec },
      "HeyGen TTS: S3 unavailable, degrading to inline-TTS path",
    );
    return { s3Key: null, durationSec };
  }

  logger.info({ userId, voiceId, durationSec, chars: trimmed.length }, "HeyGen TTS pre-generated");
  return { s3Key: uploadedKey, durationSec };
}

/**
 * Submit-pipeline wrapper. Если модель HeyGen и `voice_audio` ещё не выставлен
 * (нет raw audio, EL/Cartesia не отрабатывал) — синтезирует речь через
 * HeyGen TTS и инжектит результирующий signed URL в `mediaInputs.voice_audio`.
 * Иначе возвращает params неизменно.
 *
 * Зовётся ИЗ `submitVideo` (`video-generation.service.ts`), чтобы покрыть и
 * бот-путь, и веб-путь, и любые внутренние HTTP-сабмиты — иначе дыра в минус
 * остаётся открытой на surface'ах, забывших позвать helper.
 */
export async function ensureHeygenTtsForVideo(
  submitParams: SubmitVideoParams,
): Promise<SubmitVideoParams> {
  const { userId, modelId, prompt, mediaInputs, extraModelSettings } = submitParams;
  if (modelId !== "heygen") return submitParams;
  if (mediaInputs?.voice_audio?.[0]) return submitParams;
  if (!prompt?.trim()) return submitParams;

  // Совпадает с тем, как cost-preview.service.ts резолвит settings: persistent
  // userState + extraModelSettings override. Иначе web-сабмиты с per-request
  // voice_id могут проскочить мимо (в userState пусто → skip → дыра).
  const allSettings = await userStateService.getModelSettings(userId);
  const fullModelSettings: Record<string, unknown> = {
    ...(allSettings[modelId] ?? {}),
    ...((extraModelSettings as Record<string, unknown> | undefined) ?? {}),
  };

  let result: HeygenTtsResult | null;
  try {
    result = await preGenerateHeygenTts(userId, modelId, prompt, fullModelSettings);
  } catch (err) {
    if (err instanceof PoolExhaustedError) {
      // Все HeyGen-ключи throttled. Поднимаем как UserFacingError — иначе
      // юзер видит generic "generationFailed" без подсказки. Reused key
      // matches the standard "временно недоступно" UX.
      throw new UserFacingError("HeyGen key pool exhausted", {
        key: "modelTemporarilyUnavailable",
        section: "video",
        params: { modelName: "HeyGen" },
      });
    }
    throw err;
  }
  if (!result) return submitParams;

  // Pitch-режим: аудио не сохранили, но длительность знаем. Прокидываем
  // только hint — `voice_audio` остаётся пустым, HeyGen-адаптер пойдёт по
  // inline-TTS пути и применит `voice_settings.pitch`.
  if (result.s3Key === null) {
    return {
      ...submitParams,
      audioDurationSecHint: result.durationSec,
    };
  }

  // mediaInputs.voice_audio в downstream-коде ожидается как fetchable URL
  // (HeyGen-адаптер скачивает по нему перед загрузкой в /v3/assets). Подписываем.
  // TODO(stale-url): этот presigned URL живёт PRESIGN_TTL=1h и попадает в
  // GenerationJob.inputData. Если watchdog (>1h) переэнкью́ит застрявшую джобу,
  // URL уже истекает. EL/Cartesia путь решает это через `preTtsAudio.s3Key` +
  // re-sign в воркере (video.processor.ts:312-366). Сюда симметрично надо
  // добавить тот же fallback. Кейс редкий (HeyGen normal latency 1-3 мин).
  const signedUrl = (await getFileUrl(result.s3Key).catch(() => null)) ?? result.s3Key;

  return {
    ...submitParams,
    mediaInputs: {
      ...(mediaInputs ?? {}),
      voice_audio: [signedUrl],
    },
    // HeyGen TTS endpoint вернул точную длительность вместе с audio_url —
    // прокидываем в previewVideo, чтобы не делать повторный ffprobe того же
    // mp3 на следующем шаге.
    audioDurationSecHint: result.durationSec,
  };
}
