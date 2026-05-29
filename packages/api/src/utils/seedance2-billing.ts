/**
 * Seedance 2.0 / 2.0 Fast — pure billing helpers для evolink primary.
 *
 * Логика отделена ради тестируемости и переиспользования. Воркер
 * (video.processor) применяет её при списании, а previewVideo (cost-preview) —
 * при оценке предв. цены, оба только когда у задачи есть ref_videos (r2v
 * режим). Для no-video случая обычный `calculateCost` через costMatrix работает.
 *
 * Pricing rules (per evolink docs):
 *   - С видео-инпутом: используется ПОНИЖЕННЫЙ per-second rate, но добавочно
 *     биллится duration входного видео.
 *   - Минимум billable input duration = output duration:
 *     `billable_input = max(total_input_duration, output_duration)`.
 *   - Total billable seconds = `output_duration + billable_input`.
 *   - Final USD = `rate × billable_seconds`.
 */

/** Per-second rates когда у задачи есть `ref_videos` (r2v режим). */
export const SEEDANCE2_RATES_WITH_VIDEO: Record<string, Record<string, number>> = {
  "seedance-2": { "480p": 0.056, "720p": 0.121, "1080p": 0.302 },
  "seedance-2-fast": { "480p": 0.045, "720p": 0.096 },
  // Fast не имеет 1080p — попытка вернёт null и caller должен fallback'нуться
  // на calculateCost с no-video matrix.
};

export interface Seedance2BillingInput {
  modelId: "seedance-2" | "seedance-2-fast";
  /** "480p" | "720p" | "1080p". Для unknown возвращается null. */
  resolution: string;
  /** Длительность output-видео в секундах. */
  outputDuration: number;
  /** Длительности входных reference videos в секундах. Пустой массив = no-video case. */
  inputVideoDurations: number[];
}

/**
 * Возвращает USD-стоимость для seedance-2 в r2v режиме (с input video) или
 * `null` если:
 *   - Неизвестное разрешение (e.g. fast + 1080p).
 *   - Не передано ни одного input video (caller должен использовать обычный
 *     calculateCost path для no-video кейса).
 *
 * Caller отвечает за конвертацию USD → tokens × multiplier.
 */
export function computeSeedance2BillableUsd(input: Seedance2BillingInput): number | null {
  if (input.inputVideoDurations.length === 0) return null;

  const rate = SEEDANCE2_RATES_WITH_VIDEO[input.modelId]?.[input.resolution];
  if (rate === undefined) return null;

  const totalInputDuration = input.inputVideoDurations.reduce((sum, d) => sum + d, 0);
  // "Minimum billable input duration = output duration" — даже если input короче.
  const billableInput = Math.max(totalInputDuration, input.outputDuration);
  const totalSec = input.outputDuration + billableInput;

  return rate * totalSec;
}
