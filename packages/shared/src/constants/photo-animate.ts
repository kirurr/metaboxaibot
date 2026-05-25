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
