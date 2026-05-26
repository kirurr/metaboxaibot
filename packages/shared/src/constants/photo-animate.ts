/**
 * Constants for the «Оживить фотографию» (photo animate) preset scenario.
 *
 * Под капотом — KIE Grok Imagine reference-to-video (`grok-imagine/image-to-video`)
 * с FAL fallback'ом на тот же endpoint. Юзер ничего не настраивает: грузит фото —
 * сцена детектит aspect ratio исходника, форсит 720p / 6s и зашивает фикс-промпт.
 * В каталоге модель `photo-animate` помечена `hiddenFromCarousel` — Grok нигде
 * не светится, юзер видит её только как «🎞️ Оживить фото».
 */
export const PHOTO_ANIMATE_MODEL_ID = "photo-animate";

/** Захардкоженная длительность результата в секундах (min Grok r2v = 6). */
export const PHOTO_ANIMATE_DURATION_SEC = 6;

/** Максимальное разрешение, которое поддерживает Grok Imagine. */
export const PHOTO_ANIMATE_RESOLUTION = "720p";

/**
 * Фикс-промпт сценария. Хранится в shared, чтобы scene + (потенциально) тесты
 * шли от одной строки. Английский — Grok тренился на en, перевода не нужно.
 */
export const PHOTO_ANIMATE_PROMPT =
  "Animate a photo with an average level of emotion and without voice acting. That is, the characters in the photo should not say anything.";

/**
 * Маппит реальный AR исходника (W/H) к ближайшему из списка supported
 * соотношений Grok Imagine r2v. Сравниваем по относительной разнице (|src-tgt|
 * /tgt) — это правильнее abs-разницы: 9:16 vs 16:9 на одинаковом «расстоянии»
 * 1, но 1:1 (=1.0) и 9:16 (≈0.56) такую же по abs-разнице дают ≈0.44 — а
 * относительная даёт 0.44/0.56 = 0.78, что честнее отражает «насколько далеко».
 *
 * Живёт в shared: bot-сцена «Оживить фото» детектит AR при загрузке, веб-роут
 * (`web-generation.ts`) — серверно при сабмите. Обе стороны идут от одной таблицы.
 */
const SUPPORTED_AR_RATIOS: ReadonlyArray<[string, number]> = [
  ["1:1", 1],
  ["2:3", 2 / 3],
  ["3:2", 3 / 2],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
];

export function snapAspectRatio(width: number, height: number): string {
  if (!width || !height) return "1:1";
  const src = width / height;
  let best = SUPPORTED_AR_RATIOS[0][0];
  let bestDiff = Infinity;
  for (const [label, target] of SUPPORTED_AR_RATIOS) {
    const diff = Math.abs(src - target) / target;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = label;
    }
  }
  return best;
}
