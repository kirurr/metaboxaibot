/**
 * Constants for the «Копировать движение» (copy-motion) preset scenario.
 *
 * Под капотом — `kling-3.0/motion-control` @ 1080p Pro (KIE primary, FAL и
 * Evolink — fallbacks). Юзер ничего не настраивает: грузит фото + референс-
 * видео, адаптер форсит character_orientation="video" и
 * background_source="input_image". Длительность результата = длительность
 * референс-видео (3-30 сек по ограничению Kling). Модель `copy-motion`
 * помечена `hiddenFromCarousel` — kling-motion-pro нигде не светится, юзер
 * видит её только как «🎬 Копировать движение».
 */
export const COPY_MOTION_MODEL_ID = "copy-motion";

/**
 * Pseudo-model id, под которым сцена хранит S3-ключи фото и видео в
 * `UserState.mediaInputs` между двумя шагами (по аналогии с
 * FACE_SWAP_BUFFER_MODEL_ID). Очищается на возврат в главное меню.
 */
export const COPY_MOTION_BUFFER_MODEL_ID = "copy_motion";

/** Slot keys для buffer'а — соответствуют именам полей в kling-motion модели. */
export const COPY_MOTION_SLOT_IMAGE = "first_frame";
export const COPY_MOTION_SLOT_VIDEO = "motion_video";

/** Максимальный размер загружаемой фотографии. Совпадает с photo-animate. */
export const COPY_MOTION_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Telegram Bot API hard cap на `getFile` downloads. Видео тяжелее провайдер
 * физически не достанет — обрезаем на upload'е, чтобы не сабмитить заведомо
 * обречённый payload.
 */
export const COPY_MOTION_VIDEO_MAX_BYTES = 20 * 1024 * 1024;

/** Kling motion-control принимает референс-видео длительностью 3–30 секунд. */
export const COPY_MOTION_VIDEO_MIN_SEC = 3;
export const COPY_MOTION_VIDEO_MAX_SEC = 30;
