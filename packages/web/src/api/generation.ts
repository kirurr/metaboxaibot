import { apiClient } from "./client";

/**
 * Запуск генерации с веба. Payload соответствует state'у `GenerateScene`:
 * `modelId`, `prompt`, `settings` (≈ `settingValues`), `mediaInputs`
 * (slotKey → массив s3Key'ев из `ChatUploadDto`).
 *
 * Возвращает `dbJobId` — по нему сматчится будущий WS-event
 * `generation:complete` / `generation:failed` (subscriber'а на бэке мы уже
 * подняли через Redis pub/sub).
 */

export interface SubmitMediaGenerationBody {
  modelId: string;
  modeId?: string;
  prompt: string;
  /**
   * Произвольные значения настроек. motion-picker возвращает массив
   * `{ id, strength }`, остальные пикеры — string id'ы, слайдеры — числа и т.д.
   * Бек сохранит как JSON и передаст воркеру.
   */
  settings?: Record<string, unknown>;
  /** slotKey → s3Key'и из ChatUploadDto.s3Key */
  mediaInputs?: Record<string, string[]>;
}

export type SubmitImageGenerationBody = SubmitMediaGenerationBody;
export type SubmitVideoGenerationBody = SubmitMediaGenerationBody;

export interface SubmitAudioGenerationBody {
  modelId: string;
  prompt: string;
  settings?: Record<string, unknown>;
}

export interface SubmitGenerationResponse {
  dbJobId: string;
}

export function submitImageGeneration(
  body: SubmitImageGenerationBody,
): Promise<SubmitGenerationResponse> {
  return apiClient<SubmitGenerationResponse, SubmitImageGenerationBody>("/web/generation/image", {
    method: "POST",
    body,
  });
}

export function submitVideoGeneration(
  body: SubmitVideoGenerationBody,
): Promise<SubmitGenerationResponse> {
  return apiClient<SubmitGenerationResponse, SubmitVideoGenerationBody>("/web/generation/video", {
    method: "POST",
    body,
  });
}

export function submitAudioGeneration(
  body: SubmitAudioGenerationBody,
): Promise<SubmitGenerationResponse> {
  return apiClient<SubmitGenerationResponse, SubmitAudioGenerationBody>("/web/generation/audio", {
    method: "POST",
    body,
  });
}

// ── Cost preview ────────────────────────────────────────────────────────────

export interface PreviewGenerationBody {
  modelId: string;
  modeId?: string;
  prompt?: string;
  settings?: Record<string, unknown>;
  mediaInputs?: Record<string, string[]>;
}

export interface PreviewGenerationResponse {
  /** Цена в токенах. Для `pricingMode="per_second"` — за 1 секунду. */
  cost: number;
  /** "total" — итоговая цена; "per_second" — цена за 1с (длина заранее неизвестна). */
  pricingMode: "total" | "per_second";
  /** Для video: эффективная длительность ролика. */
  durationSec?: number;
  /** Для image: кол-во изображений в виртуальном батче. */
  numImages?: number;
}

/**
 * Динамический предпросмотр стоимости. UI зовёт его после каждого изменения
 * настроек/слотов (с дебаунсом), чтобы цифра на кнопке Generate совпадала с
 * фактическим списанием. Под капотом тот же `costPreviewService`, что и при
 * сабмите.
 *
 * Принимает `AbortSignal` чтобы отменять in-flight запрос при следующем
 * изменении входных данных.
 */
export function previewGeneration(
  body: PreviewGenerationBody,
  init?: { signal?: AbortSignal },
): Promise<PreviewGenerationResponse> {
  return apiClient<PreviewGenerationResponse, PreviewGenerationBody>("/web/generation/preview", {
    method: "POST",
    body,
    ...(init?.signal ? { signal: init.signal } : {}),
  });
}

// ── History ────────────────────────────────────────────────────────────────

export interface GenerationOutputDto {
  id: string;
  /** Презайнднутый S3 URL или прямой outputUrl провайдера. */
  url: string | null;
  thumbnailUrl: string | null;
}

export interface GenerationJobDto {
  id: string;
  section: string;
  modelId: string;
  prompt: string;
  /** "done" | "failed". Pending/processing трекается локально на фронте. */
  status: string;
  error: string | null;
  errorCode: string | null;
  tokensSpent: string | null;
  createdAt: string;
  completedAt: string | null;
  outputs: GenerationOutputDto[];
}

/**
 * История генераций юзера. `modelIds` — CSV для шейринга истории между
 * sibling-моделями семейства (flux + flux-pro и т.п.).
 */
export function listGenerations(opts: {
  modelIds?: string[];
  section?: string;
  limit?: number;
}): Promise<{ items: GenerationJobDto[] }> {
  const query: Record<string, string | number> = {};
  if (opts.modelIds && opts.modelIds.length > 0) query.modelIds = opts.modelIds.join(",");
  if (opts.section) query.section = opts.section;
  if (opts.limit) query.limit = opts.limit;
  return apiClient<{ items: GenerationJobDto[] }>("/web/generations", { query });
}
