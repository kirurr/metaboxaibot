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
  return apiClient<SubmitGenerationResponse, SubmitImageGenerationBody>(
    "/web/generation/image",
    { method: "POST", body },
  );
}

export function submitVideoGeneration(
  body: SubmitVideoGenerationBody,
): Promise<SubmitGenerationResponse> {
  return apiClient<SubmitGenerationResponse, SubmitVideoGenerationBody>(
    "/web/generation/video",
    { method: "POST", body },
  );
}

export function submitAudioGeneration(
  body: SubmitAudioGenerationBody,
): Promise<SubmitGenerationResponse> {
  return apiClient<SubmitGenerationResponse, SubmitAudioGenerationBody>(
    "/web/generation/audio",
    { method: "POST", body },
  );
}
