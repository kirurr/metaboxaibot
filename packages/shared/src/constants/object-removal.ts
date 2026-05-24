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
