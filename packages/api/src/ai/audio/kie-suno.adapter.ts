import type { AudioAdapter, AudioInput, AudioResult } from "./base.adapter.js";
import { config, UserFacingError, validateSunoInput } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { providerHttpError } from "../../utils/rate-limit-error.js";

const KIE_BASE = "https://api.kie.ai";

/**
 * Model version mapping from internal setting values to kie.ai model names.
 * Должен покрывать тот же набор что и SUNO_MODEL_LIMITS в shared/model-limits.ts —
 * иначе валидатор пропустит ввод по лимитам одной модели, а адаптер тихо
 * отправит запрос на другую (`MODEL_MAP[X] ?? "V4_5"`).
 */
const MODEL_MAP: Record<string, string> = {
  V3_5: "V3_5",
  V4: "V4",
  V4_5: "V4_5",
  V4_5PLUS: "V4_5PLUS",
  V4_5ALL: "V4_5ALL",
  V5: "V5",
  V5_5: "V5_5",
};

interface SunoGenerateResponse {
  code: number;
  msg: string;
  data?: { taskId: string };
}

interface SunoTrack {
  id?: string;
  audioUrl?: string;
  streamAudioUrl?: string;
  imageUrl?: string;
  title?: string;
  duration?: number;
}

interface SunoPollResponse {
  code: number;
  msg?: string;
  data?: {
    taskId?: string;
    status?: string;
    errorCode?: number | null;
    errorMessage?: string | null;
    response?: {
      sunoData?: SunoTrack[];
    };
  };
}

/**
 * Suno music generation adapter via kie.ai (primary).
 * Schema проксирует тот же Suno API, что и sunoapi.org — поля и статусы
 * совпадают, отличаются только base URL и источник ключа.
 *
 * Docs: https://docs.kie.ai/suno-api/quickstart
 *       docs/schema/kie/suno-quickstart.md (локальная копия)
 */
export class KieSunoAdapter implements AudioAdapter {
  readonly modelId = "suno";
  readonly isAsync = true;

  private readonly apiKeyOverride: string | undefined;
  private readonly fetchFn: typeof globalThis.fetch | undefined;

  constructor(apiKeyOverride?: string, fetchFn?: typeof globalThis.fetch) {
    this.apiKeyOverride = apiKeyOverride;
    this.fetchFn = fetchFn;
  }

  private get apiKey(): string {
    const key = this.apiKeyOverride ?? config.ai.kie;
    if (!key) throw new Error("KIE_API_KEY not configured");
    return key;
  }

  async submit(input: AudioInput): Promise<string> {
    const apiKey = this.apiKey;

    const ms = input.modelSettings ?? {};
    const lyrics = (ms.lyrics as string | undefined)?.trim() || undefined;
    const instrumental = (ms.make_instrumental as boolean | undefined) ?? false;
    const modelVersion = (ms.model_version as string | undefined) ?? "V4_5";
    const model = MODEL_MAP[modelVersion] ?? "V4_5";
    const customMode = !instrumental && Boolean(lyrics);

    // Pre-flight длины через shared-валидатор. Service-layer уже валидирует
    // до acquireKey, тут — safety net на случай прямого вызова или будущих
    // путей. KIE/Apipass используют один и тот же валидатор → одинаковый
    // user-facing текст вне зависимости от того, кто из адаптеров поймал.
    validateSunoInput({ prompt: input.prompt, lyrics, instrumental, modelVersion });

    // callBackUrl у kie обязателен.
    const callBackUrl = config.api.publicUrl
      ? `${config.api.publicUrl}/suno-callback`
      : `https://google.com`;

    const body: Record<string, unknown> = customMode
      ? {
          customMode: true,
          instrumental: false,
          model,
          // В Custom Mode prompt — это lyrics, style — описание стиля. Title
          // фиксированный — у нас в UI отдельного поля нет.
          style: input.prompt,
          title: "Track",
          prompt: lyrics,
        }
      : {
          customMode: false,
          instrumental,
          model,
          prompt: input.prompt,
        };
    if (callBackUrl) body.callBackUrl = callBackUrl;

    const resp = await fetchWithLog(
      `${KIE_BASE}/api/v1/generate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      this.fetchFn,
    );

    if (!resp.ok) {
      const txt = await resp.text();
      throw providerHttpError(`Kie Suno API error ${resp.status}: ${txt}`, resp.status);
    }

    const data = (await resp.json()) as SunoGenerateResponse;
    if (data.code === 200 && data.data?.taskId) {
      return data.data.taskId;
    }

    const msg = data.msg ?? "no taskId in response";

    // 402 = Insufficient Credits (см. kie API code table). Аккаунт kie пуст —
    // затрагивает всех пользователей до пополнения. Показываем generic
    // «временно недоступно», скипаем ретраи (UnrecoverableError дальше по
    // стеку), шлём ops-алерт с дедупом. Отдельный ключ от apipass — алерты
    // по разным провайдерам не сливаются, когда подключится fallback.
    if (data.code === 402) {
      throw new UserFacingError(`Kie Suno API: ${msg}`, {
        key: "modelTemporarilyUnavailable",
        section: "audio",
        params: { modelName: "Suno" },
        notifyOps: true,
        opsAlertDedupKey: "suno-kie-credits-exhausted",
      });
    }

    // `code` (напр. 500) включаем в текст и проставляем `status` для 5xx —
    // иначе submitWithFallback не распознаёт серверный сбой kie и не уходит
    // на apipass-fallback.
    throw providerHttpError(`Kie Suno API error ${data.code}: ${msg}`, data.code);
  }

  async poll(taskId: string): Promise<AudioResult | null> {
    const apiKey = this.apiKey;

    const resp = await fetchWithLog(
      `${KIE_BASE}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      this.fetchFn,
    );

    if (!resp.ok) throw providerHttpError(`Kie Suno API poll error ${resp.status}`, resp.status);

    const body = (await resp.json()) as SunoPollResponse;
    const taskData = body.data;
    const status = taskData?.status;

    // Terminal error statuses
    if (
      status === "GENERATE_AUDIO_FAILED" ||
      status === "CREATE_TASK_FAILED" ||
      status === "SENSITIVE_WORD_ERROR"
    ) {
      // errorCode kie несёт серверные сбои таски (напр. 500 "Internal Error,
      // Please try again later."). Кладём его и в текст, и в `status` через
      // providerHttpError — без 5xx-классификации poll-стадия не уходит на
      // apipass-fallback, а ошибка маппится как вина юзера ("измените запрос").
      const failCode = taskData?.errorCode;
      const detail = [status, failCode, taskData?.errorMessage]
        .filter((p) => p !== null && p !== undefined && p !== "")
        .join(" ");
      throw providerHttpError(`Kie Suno generation failed: ${detail}`, failCode);
    }

    // Все прочие статусы (PENDING, TEXT_SUCCESS, CALLBACK_EXCEPTION и т.п.) —
    // не готово, продолжаем поллить. Suno в music-режиме идёт по цепочке
    // PENDING → TEXT_SUCCESS → FIRST_SUCCESS → SUCCESS; TEXT_SUCCESS —
    // intermediate (текст готов, аудио ещё нет), не terminal.
    if (status !== "SUCCESS" && status !== "FIRST_SUCCESS") return null;

    // Берём только финальные audioUrl'ы — streamAudioUrl это HLS/chunked
    // endpoint, его нельзя отдавать как mp3 в Telegram sendAudio.
    //
    // Suno возвращает 2 трека за запрос. Все валидные кладём: первый в
    // основной result, остальные в `extras` (worker сохранит каждый как
    // отдельный output и пришлёт юзеру отдельным сообщением).
    const audioUrls = (taskData?.response?.sunoData ?? [])
      .map((tr) => tr.audioUrl)
      .filter((u): u is string => !!u);
    if (audioUrls.length === 0) return null;

    // На FIRST_SUCCESS обычно готов только первый трек (audioUrl второго ещё
    // null). Не отдаём результат, пока готовы не оба, — иначе юзер получает
    // 1 трек за полную (2-трековую) цену запроса. На SUCCESS отдаём что есть:
    // изредка Suno реально возвращает 1 трек, ждать второй бессмысленно.
    if (status === "FIRST_SUCCESS" && audioUrls.length < 2) return null;

    const [primaryUrl, ...restUrls] = audioUrls;
    return {
      url: primaryUrl,
      ext: "mp3",
      contentType: "audio/mpeg",
      extras: restUrls.map((url) => ({ url, ext: "mp3", contentType: "audio/mpeg" })),
    };
  }
}
