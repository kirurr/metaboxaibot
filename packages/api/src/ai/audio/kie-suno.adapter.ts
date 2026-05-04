import type { AudioAdapter, AudioInput, AudioResult } from "./base.adapter.js";
import { config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";

const KIE_BASE = "https://api.kie.ai";

/** Model version mapping from internal setting values to kie.ai model names */
const MODEL_MAP: Record<string, string> = {
  V4: "V4",
  V4_5: "V4_5",
  V4_5PLUS: "V4_5PLUS",
  V5: "V5",
  V5_5: "V5_5",
};

/**
 * Лимиты длины полей по модели (из docs/schema/kie/suno-quickstart.md).
 * `prompt` в Non-Custom режиме всегда 500 chars независимо от модели.
 * V5_5 в доке отдельно не упомянут — относим к группе V4_5+ (та же архитектура).
 */
interface ModelLimits {
  customPrompt: number;
  style: number;
}
const NON_CUSTOM_PROMPT_MAX = 500;
const MODEL_LIMITS: Record<string, ModelLimits> = {
  V4: { customPrompt: 3000, style: 200 },
  V4_5: { customPrompt: 5000, style: 1000 },
  V4_5PLUS: { customPrompt: 5000, style: 1000 },
  V5: { customPrompt: 5000, style: 1000 },
  V5_5: { customPrompt: 5000, style: 1000 },
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
    const limits = MODEL_LIMITS[model] ?? MODEL_LIMITS.V4_5;
    const customMode = !instrumental && Boolean(lyrics);

    // Pre-flight валидация длины — формулировки серверных ошибок у kie не
    // зафиксированы, regex-матчинг постфактум хрупкий. Лимиты из доки —
    // единственный надёжный источник истины.
    if (customMode && lyrics) {
      if (lyrics.length > limits.customPrompt) {
        throw new UserFacingError(
          `Kie Suno: lyrics ${lyrics.length} > ${limits.customPrompt} chars`,
          {
            key: "sunoPromptTooLong",
            params: { max: limits.customPrompt, current: lyrics.length },
          },
        );
      }
      if (input.prompt.length > limits.style) {
        throw new UserFacingError(
          `Kie Suno: style ${input.prompt.length} > ${limits.style} chars`,
          {
            key: "sunoPromptTooLong",
            params: { max: limits.style, current: input.prompt.length },
          },
        );
      }
    } else if (input.prompt.length > NON_CUSTOM_PROMPT_MAX) {
      throw new UserFacingError(
        `Kie Suno: prompt ${input.prompt.length} > ${NON_CUSTOM_PROMPT_MAX} chars`,
        {
          key: "sunoPromptTooLong",
          params: { max: NON_CUSTOM_PROMPT_MAX, current: input.prompt.length },
        },
      );
    }

    // callBackUrl у kie опционален. Передаём только когда есть валидный
    // публичный URL — без подставленного example.com kie ничему не доверяет
    // лишнего, мы всё равно поллим.
    const callBackUrl = config.api.publicUrl ? `${config.api.publicUrl}/suno-callback` : undefined;

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
      throw new Error(`Kie Suno API error ${resp.status}: ${txt}`);
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

    throw new Error(`Kie Suno API: ${msg}`);
  }

  async poll(taskId: string): Promise<AudioResult | null> {
    const apiKey = this.apiKey;

    const resp = await fetchWithLog(
      `${KIE_BASE}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      this.fetchFn,
    );

    if (!resp.ok) throw new Error(`Kie Suno API poll error ${resp.status}`);

    const body = (await resp.json()) as SunoPollResponse;
    const taskData = body.data;
    const status = taskData?.status;
    const track = taskData?.response?.sunoData?.[0];

    // Terminal error statuses
    if (
      status === "GENERATE_AUDIO_FAILED" ||
      status === "CREATE_TASK_FAILED" ||
      status === "SENSITIVE_WORD_ERROR"
    ) {
      throw new Error(`Kie Suno generation failed: ${status} ${taskData?.errorMessage ?? ""}`);
    }

    // TEXT_SUCCESS — успешная генерация только текста (lyrics-only mode).
    // Для модели "music" этот статус — терминальная аномалия (аудио не будет).
    // Когда подключим lyrics-only режим — обработать отдельно.
    if (status === "TEXT_SUCCESS") {
      throw new Error("Kie Suno: text-only result for music task; no audio generated");
    }

    // CALLBACK_EXCEPTION — kie не смог достучаться до нашего callback. Сама
    // генерация может уже быть готова: если в response уже есть финальный
    // audioUrl — забираем результат, иначе считаем терминальной ошибкой.
    if (status === "CALLBACK_EXCEPTION") {
      if (track?.audioUrl) {
        return { url: track.audioUrl, ext: "mp3", contentType: "audio/mpeg" };
      }
      throw new Error(
        `Kie Suno: callback exception with no audio result (${taskData?.errorMessage ?? ""})`,
      );
    }

    // Not ready yet
    if (status !== "SUCCESS" && status !== "FIRST_SUCCESS") return null;

    // Берём только финальный audioUrl. streamAudioUrl — HLS/chunked endpoint,
    // его нельзя отдавать как mp3 в Telegram sendAudio (битый файл / зависший
    // fetch / короткий TTL). На FIRST_SUCCESS audioUrl первого трека уже
    // должен быть готов; если ещё нет — продолжаем поллить до SUCCESS.
    if (!track?.audioUrl) return null;

    return { url: track.audioUrl, ext: "mp3", contentType: "audio/mpeg" };
  }
}
