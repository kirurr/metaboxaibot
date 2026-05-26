/**
 * Constants for the «Убрать объект с фото» (object removal) preset scenario.
 *
 * Под капотом — KIE `gpt-image-2-image-to-image` @ 2K. Юзер ничего не настраивает:
 * грузит одно фото, одной фразой пишет что убрать (≤400 chars), мы оборачиваем
 * в фикс-шаблон и переводим на английский через prompt-translate.service.
 *
 * `_BUFFER_MODEL_ID` — псевдо-id для хранения загруженного фото в
 * `UserState.mediaInputs` между шагом загрузки и шагом текста (как у upscale.ts).
 */
export const OBJECT_REMOVAL_MODEL_ID = "object-removal";
export const OBJECT_REMOVAL_BUFFER_MODEL_ID = "object_removal";

/** Hard cap on user prompt length (pre-validated in scene + adapter). */
export const OBJECT_REMOVAL_PROMPT_MAX_CHARS = 400;

/**
 * Фикс-настройки для gpt-image-2 i2i.
 *
 * `resolution:"1K"` + `aspect_ratio:"auto"` — единственная комбинация у KIE,
 * при которой формат выхода в точности совпадает с форматом входа (для 2K/4K
 * нужен явный aspect_ratio из enum {1:1, 9:16, 16:9, 4:3, 3:4} — любой не
 * совпавший с реальным даёт crop или distortion). Сохранение пропорций
 * приоритетнее, чем 2K — поэтому 1K.
 */
export const OBJECT_REMOVAL_SETTINGS: Record<string, string | boolean> = {
  resolution: "1K",
  aspect_ratio: "auto",
};

/**
 * Шаблон, в который оборачивается юзерский ввод (после автоперевода на английский).
 * Подсказывает gpt-image-2 что нужно именно убрать объект и аккуратно дорисовать
 * фон, а не перерисовать всё фото. Шаблон уже на английском — его НЕ переводят,
 * чтобы LLM не размывала инструкцию (переводят только ввод юзера, отдельно).
 *
 * Используется и ботом (`scenes/object-removal.ts`), и веб-роутом
 * (`routes/web-generation.ts`) — общий, чтобы поведение не разъезжалось.
 */
export function buildObjectRemovalPrompt(userText: string): string {
  return `Remove the following from the image: ${userText}. Keep everything else exactly as it was — same composition, same subjects, same colors, same lighting. Inpaint the background where the removed object was, photorealistic and seamless.`;
}
