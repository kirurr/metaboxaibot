/**
 * Constants for the «Оживить фотографию» (photo animate) preset scenario.
 *
 * Под капотом — KIE Grok Imagine reference-to-video (`grok-imagine/image-to-video`)
 * с FAL fallback'ом на тот же endpoint. Юзер ничего не настраивает: грузит фото,
 * подтверждает кнопкой — сцена детектит aspect ratio исходника, форсит 720p / 6s
 * и зашивает фикс-промпт. В каталоге модель `photo-animate` помечена
 * `hiddenFromCarousel` — Grok нигде не светится, юзер видит её только как
 * «🎞️ Оживить фото».
 */
export const PHOTO_ANIMATE_MODEL_ID = "photo-animate";
export const PHOTO_ANIMATE_BUFFER_MODEL_ID = "photo_animate";

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
 * Соотношения сторон, которые поддерживает Grok Imagine r2v (из video.models.ts
 * — supportedAspectRatios `grok-imagine-r2v`). Сцена снапит реальный AR
 * исходника к ближайшему из этого списка.
 */
export const PHOTO_ANIMATE_SUPPORTED_ASPECT_RATIOS: readonly string[] = [
  "1:1",
  "2:3",
  "3:2",
  "16:9",
  "9:16",
];
