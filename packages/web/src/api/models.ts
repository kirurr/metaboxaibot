import { apiClient } from "./client";

/**
 * Каталог моделей с бэкенда (`/web/models`). DTO мы держим узким — фронту
 * нужны только id/имя/описание/секция + опц. supportedAspectRatios/Durations
 * для страниц Image/Video/Audio и tokenCostApprox для подписи у каждой модели.
 */

/** Логическая секция модели (определяется в `packages/shared/constants/models/*`). */
export type ModelSection = "gpt" | "design" | "video" | "audio";

export type WebModelDto = {
  id: string;
  name: string;
  description: string;
  section: ModelSection | string;
  provider: string;
  familyId: string | null;
  familyName: string | null;
  versionLabel: string | null;
  variantLabel: string | null;
  descriptionOverride: string | null;
  supportsImages: boolean;
  supportsDocuments: boolean;
  supportsVoice: boolean;
  supportsWeb: boolean;
  isAsync: boolean;
  isLLM: boolean;
  supportedAspectRatios: string[] | null;
  supportedDurations: number[] | null;
  durationRange: { min: number; max: number } | null;
  tokenCostApprox: number;
  /** msg / mpx / second / mvideotoken / kchar / request — единица для подписи стоимости. */
  tokenCostUnit: "msg" | "mpx" | "second" | "mvideotoken" | "kchar" | "request" | string;
};

export function getModels(section?: ModelSection) {
  return apiClient<WebModelDto[]>("/web/models", section ? { query: { section } } : undefined);
}
