import type { AudioAdapter, AudioInput, AudioResult } from "./base.adapter.js";
import { config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { providerHttpError } from "../../utils/rate-limit-error.js";

const SUNOAPI_BASE = "https://api.sunoapi.org";

/** Model version mapping from internal setting values to sunoapi.org model names */
const MODEL_MAP: Record<string, string> = {
  V4: "V4",
  V4_5: "V4_5",
  V4_5PLUS: "V4_5PLUS",
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
 * Suno music generation adapter via sunoapi.org.
 * Docs: https://sunoapi.org
 */
export class ApipassSunoAdapter implements AudioAdapter {
  readonly modelId = "suno";
  readonly isAsync = true;

  private readonly apiKeyOverride: string | undefined;
  private readonly fetchFn: typeof globalThis.fetch | undefined;

  constructor(apiKeyOverride?: string, fetchFn?: typeof globalThis.fetch) {
    this.apiKeyOverride = apiKeyOverride;
    this.fetchFn = fetchFn;
  }

  private get apiKey(): string {
    const key = this.apiKeyOverride ?? config.ai.apipass;
    if (!key) throw new Error("APIPASS_API_KEY not configured");
    return key;
  }

  async submit(input: AudioInput): Promise<string> {
    const apiKey = this.apiKey;

    const ms = input.modelSettings ?? {};
    const lyrics = (ms.lyrics as string | undefined)?.trim() || undefined;
    const instrumental = (ms.make_instrumental as boolean | undefined) ?? false;
    const modelVersion = (ms.model_version as string | undefined) ?? "V4_5";
    const model = MODEL_MAP[modelVersion] ?? "V4_5";

    // sunoapi.org requires callBackUrl — we use polling so any reachable URL works
    const callBackUrl = `${config.api.publicUrl ?? "https://example.com"}/suno-callback`;

    let body: Record<string, unknown>;
    if (!instrumental && lyrics) {
      // Custom mode: user provides lyrics — prompt becomes the lyrics, style is the description
      body = {
        customMode: true,
        instrumental: false,
        model,
        style: input.prompt,
        title: "Track",
        prompt: lyrics,
        callBackUrl,
      };
    } else {
      // Non-custom mode: description-only generation
      body = {
        customMode: false,
        instrumental,
        model,
        prompt: input.prompt,
        callBackUrl,
      };
    }

    const resp = await fetchWithLog(
      `${SUNOAPI_BASE}/api/v1/generate`,
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
      throw providerHttpError(`Suno API error ${resp.status}: ${txt}`, resp.status);
    }

    const data = (await resp.json()) as SunoGenerateResponse;
    if (data.code !== 200 || !data.data?.taskId) {
      const msg = data.msg ?? "no taskId in response";
      if (/cannot exceed \d+ characters/i.test(msg)) {
        const match = msg.match(/exceed\s+(\d+)\s+characters/i);
        const max = match ? Number(match[1]) : 500;
        // 500 = non-custom prompt limit. Подсказываем юзеру обход через свои
        // lyrics в Управлении; в custom-mode (3000/5000/200/1000) ничего такого
        // не подсунешь — там просто «сократите».
        const key = max === 500 ? "sunoPromptTooLongNoLyrics" : "sunoPromptTooLong";
        throw new UserFacingError(`Suno API: ${msg}`, {
          key,
          params: { max, current: input.prompt.length },
        });
      }
      // Provider account out of credits — affects every user job until an
      // operator tops up. Show a generic "temporarily unavailable" to the
      // user (it's not their fault and there's nothing for them to fix),
      // skip retries (BullMQ → UnrecoverableError downstream), and let
      // ops get a burst of alerts (5 per 30min window) — enough to grab
      // attention even when AFK without flooding the tech channel for
      // hours after the first ping.
      // Tightened to credits/balance co-occurrence so we don't false-match
      // unrelated "insufficient X" errors (e.g. prompt-quality complaints)
      // and route the user into a misleading "model unavailable" message.
      if (
        /credits?\s+(?:are|is)?\s*insufficient|insufficient\s+(?:credits?|balance)|top[\s-]?up|out\s+of\s+credits/i.test(
          msg,
        )
      ) {
        throw new UserFacingError(`Suno API: ${msg}`, {
          key: "modelTemporarilyUnavailable",
          section: "audio",
          params: { modelName: "Suno" },
          notifyOps: true,
          opsAlertDedupKey: "suno-credits-exhausted",
        });
      }
      // `code` (напр. 500) включаем в текст и проставляем `status` для 5xx —
      // иначе submitWithFallback не распознаёт серверный сбой провайдера.
      throw providerHttpError(`Suno API error ${data.code}: ${msg}`, data.code);
    }
    return data.data.taskId;
  }

  async poll(taskId: string): Promise<AudioResult | null> {
    const apiKey = this.apiKey;

    const resp = await fetchWithLog(
      `${SUNOAPI_BASE}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      this.fetchFn,
    );

    if (!resp.ok) throw providerHttpError(`Suno API poll error ${resp.status}`, resp.status);

    const body = (await resp.json()) as SunoPollResponse;
    const taskData = body.data;
    const status = taskData?.status;

    // Terminal error statuses
    if (
      status === "GENERATE_AUDIO_FAILED" ||
      status === "CREATE_TASK_FAILED" ||
      status === "SENSITIVE_WORD_ERROR"
    ) {
      // errorCode несёт серверные сбои таски (напр. 500). Кладём его и в текст,
      // и в `status` через providerHttpError — без 5xx-классификации процессор
      // маппит ошибку как вину юзера ("измените запрос") и не шлёт tech-alert.
      const failCode = taskData?.errorCode;
      const detail = [status, failCode, taskData?.errorMessage]
        .filter((p) => p !== null && p !== undefined && p !== "")
        .join(" ");
      throw providerHttpError(`Suno generation failed: ${detail}`, failCode);
    }

    // Not ready yet
    if (status !== "SUCCESS" && status !== "FIRST_SUCCESS") return null;

    // Suno возвращает 2 трека за один запрос. Собираем только финальные
    // `audioUrl` (как kie-адаптер): `streamAudioUrl` — это HLS-эндпоинт,
    // он не играется как mp3 в Telegram sendAudio, и он появляется рано —
    // по нему нельзя судить о готовности трека. Первый URL кладём в основной
    // AudioResult, остальные — в `extras` (worker сохранит каждый отдельным
    // output'ом и пришлёт юзеру отдельным сообщением).
    const tracks = (taskData?.response?.sunoData ?? [])
      .map((tr) => tr.audioUrl)
      .filter((u): u is string => !!u);
    if (tracks.length === 0) return null;

    // На FIRST_SUCCESS обычно готов только первый трек — не отдаём результат,
    // пока готовы не оба, иначе юзер получит 1 трек за полную (2-трековую)
    // цену запроса. На SUCCESS отдаём что есть (изредка Suno возвращает 1).
    if (status === "FIRST_SUCCESS" && tracks.length < 2) return null;

    const [primaryUrl, ...restUrls] = tracks;
    return {
      url: primaryUrl,
      ext: "mp3",
      contentType: "audio/mpeg",
      extras: restUrls.map((url) => ({ url, ext: "mp3", contentType: "audio/mpeg" })),
    };
  }
}
