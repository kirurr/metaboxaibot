/**
 * Constants for the «Создать фотографию» (photo create) preset scenario.
 *
 * Под капотом — `nano-banana-pro` @ 2K. Flow: фото → промпт → выбор AR на
 * инлайн-клавиатуре → submit. Юзерский ввод переводится на английский
 * через prompt-translate.service (silent), nano-banana нигде не светится:
 * displayName в подписи = «📸 Создать фотографию».
 *
 * `_BUFFER_MODEL_ID` — псевдо-id для хранения промежуточного state в
 * `UserState.mediaInputs` между шагами (как у object-removal.ts / upscale.ts).
 */
/**
 * `PHOTO_CREATE_MODEL_ID` — это hidden-alias модели в каталоге (см.
 * `design.models.ts → DESIGN_MODELS["photo-create"]`). Под капотом KIE-адаптер
 * мапит его на `nano-banana-pro` (kie.adapter.ts:NANO_BANANA_MODEL_NAMES);
 * evolink — аналогично через alias в submit(). hiddenFromCarousel:true →
 * модель не светится в карусели Дизайна, в истории, в подписях.
 */
export const PHOTO_CREATE_MODEL_ID = "photo-create";
export const PHOTO_CREATE_BUFFER_MODEL_ID = "photo_create";

/** Hard cap on user prompt length (pre-validated in scene). */
export const PHOTO_CREATE_PROMPT_MAX_CHARS = 2000;

/** Фикс-разрешение сценария — 2K (стоимость = nano-banana-pro.costVariants["2K"]). */
export const PHOTO_CREATE_RESOLUTION = "2K";

/**
 * Aspect-ratio варианты, показываемые на инлайн-клавиатуре после промпта.
 * "auto" snap'ится к ближайшему из остальных по размеру исходника (см.
 * `snapPhotoCreateAr` ниже). Все значения, кроме "auto", должны входить в
 * `nano-banana-pro.supportedAspectRatios` — проверка стоит в build'е через
 * tsconfig (несуществующее значение → ошибка на сабмите от провайдера).
 *
 * Символы-префиксы — Unicode arrows со СУФФИКСОМ U+FE0E (variation selector
 * "text presentation"), без него iOS-Telegram рендерит ↕ как цветной emoji,
 * а ↔ оставляет текстовым — получается асимметрия в клавиатуре. FE0E форсит
 * text-glyph на обеих стрелках на всех платформах.
 *   ↕︎ — вертикальные форматы (9:16, 3:4)
 *   ↔︎ — горизонтальные форматы (16:9, 4:3)
 *   без префикса — квадрат (1:1) и auto
 */
export interface PhotoCreateArOption {
  /** Значение, уходящее в `extraModelSettings.aspect_ratio`. "auto" snap'ится. */
  value: "auto" | "1:1" | "9:16" | "16:9" | "4:3" | "3:4";
  /** Подпись на кнопке (с префикс-стрелкой для наглядности). */
  label: string;
}

export const PHOTO_CREATE_AR_OPTIONS: readonly PhotoCreateArOption[] = [
  { value: "auto", label: "Авто" },
  { value: "1:1", label: "1:1" },
  { value: "16:9", label: "↔︎ 16:9" },
  { value: "9:16", label: "↕︎ 9:16" },
  { value: "4:3", label: "↔︎ 4:3" },
  { value: "3:4", label: "↕︎ 3:4" },
] as const;

/**
 * Snap реальный AR исходника (W/H) к ближайшему из non-auto вариантов выше.
 * Используется когда юзер выбрал «Авто». Сравнение по относительной разнице
 * (|src-tgt|/tgt) — тот же метод что в photo-animate.snapAspectRatio.
 */
const SNAP_TARGETS: ReadonlyArray<[string, number]> = [
  ["1:1", 1],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
];

export function snapPhotoCreateAr(width: number, height: number): string {
  if (!width || !height) return "1:1";
  const src = width / height;
  let best = SNAP_TARGETS[0][0];
  let bestDiff = Infinity;
  for (const [label, target] of SNAP_TARGETS) {
    const diff = Math.abs(src - target) / target;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = label;
    }
  }
  return best;
}
