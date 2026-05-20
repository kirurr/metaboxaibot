import type { AIModel, MediaInputSlot, ModelMode, ModelSettingDef } from "../../types/ai.js";
import { mkAspectRatio, mkDurationSelect, mkDurationSlider } from "./_helpers.js";

const MI_FIRST_FRAME: MediaInputSlot = {
  slotKey: "first_frame",
  mode: "first_frame",
  labelKey: "firstFrame",
};
const MI_FIRST_FRAME_REQUIRED: MediaInputSlot = {
  slotKey: "first_frame",
  mode: "first_frame",
  labelKey: "firstFrame",
  required: true,
};
const MI_LAST_FRAME: MediaInputSlot = {
  slotKey: "last_frame",
  mode: "last_frame",
  labelKey: "lastFrame",
};
const MI_REFERENCE: MediaInputSlot = {
  slotKey: "reference",
  mode: "reference",
  labelKey: "reference",
};
/** Veo accepts up to 3 reference images; last_frame is ignored when references are present. */
const MI_REFERENCE_VEO: MediaInputSlot = {
  slotKey: "reference",
  mode: "reference",
  labelKey: "reference",
  maxImages: 3,
};

/**
 * Kling 3.0 element slots (KIE): up to 3 elements per task, each 2-4 JPG/PNG
 * images (max 10 MB). Referenced in prompt via @Element1 / @Element2 / @Element3.
 */
const MI_REF_ELEMENTS: MediaInputSlot[] = [1, 2, 3].map((i) => ({
  slotKey: `ref_element_${i}`,
  mode: "reference_element",
  labelKey: `refElement${i}`,
  maxImages: 4,
  imagesOnly: true,
}));

/**
 * KIE Kling требует aspect ratio изображения в диапазоне 1:2.5 – 2.5:1
 * (w/h ∈ [0.4, 2.5]) — иначе submit падает на стороне провайдера 422
 * "Image aspect ratio must be between 1:2.5 and 2.5:1". Валидируем на upload'е.
 */
const KLING_IMAGE_ASPECT = { minAspectRatio: 0.4, maxAspectRatio: 2.5 } as const;

/**
 * Runway требует w/h ≥ 0.5 (= 1:2 портрет максимум). Наблюдали 2026-05:
 * submit падал с 400 «Invalid asset aspect ratio. width / height ratio must
 * be at least 0.5. Got 0.462.» Валидируем на upload'е, иначе юзер ждёт
 * 3 пустых BullMQ-ретрая.
 */
const RUNWAY_IMAGE_ASPECT = { minAspectRatio: 0.5 } as const;

// KIE Kling принимает first/last frame одним массивом image_urls, поэтому
// last_frame standalone не имеет смысла — кнопка появляется только после
// загрузки first_frame.
const KLING_MEDIA_INPUTS: MediaInputSlot[] = [
  { ...MI_FIRST_FRAME, constraints: { ...MI_FIRST_FRAME.constraints, ...KLING_IMAGE_ASPECT } },
  {
    ...MI_LAST_FRAME,
    revealAfter: "first_frame",
    constraints: { ...MI_LAST_FRAME.constraints, ...KLING_IMAGE_ASPECT },
  },
  ...MI_REF_ELEMENTS.map((s) => ({
    ...s,
    constraints: { ...s.constraints, ...KLING_IMAGE_ASPECT },
  })),
];

/**
 * Kling Motion: required reference image (image_url). KIE требует минимум
 * 300×300 px по обеим сторонам — иначе submit падает с 422
 * "Image dimensions must be at least 300 pixels". Валидируем на upload'е.
 */
const MI_MOTION_IMAGE: MediaInputSlot = {
  slotKey: "first_frame",
  mode: "first_frame",
  labelKey: "motionImage",
  required: true,
  // KIE: ≥300px по сторонам и aspect ratio 1:2.5 – 2.5:1.
  constraints: { minWidth: 300, minHeight: 300, ...KLING_IMAGE_ASPECT },
};
/** Kling Motion: required reference video (video_url). Provider requires 3–30 s. */
const MI_MOTION_VIDEO: MediaInputSlot = {
  slotKey: "motion_video",
  mode: "motion_video",
  labelKey: "motionVideo",
  required: true,
  constraints: { minDurationSec: 3, maxDurationSec: 30 },
};
const KLING_MOTION_MEDIA_INPUTS: MediaInputSlot[] = [MI_MOTION_IMAGE, MI_MOTION_VIDEO];

const KLING_MOTION_SETTINGS: ModelSettingDef[] = [
  {
    key: "character_orientation",
    label: "Ориентация персонажа",
    description:
      "Определяет, чью ориентацию повторит персонаж в результате. «По видео» — ориентация как в референсном видео (рекомендуется). «По изображению» — ориентация как на исходном фото.",
    type: "select",
    options: [
      { value: "video", label: "По видео" },
      { value: "image", label: "По изображению" },
    ],
    default: "video",
  },
  {
    key: "background_source",
    label: "Источник фона",
    description:
      "Откуда брать фон для итогового видео. «Из видео» — фон берётся из референсного видео. «Из изображения» — фон берётся с исходного фото.",
    type: "select",
    options: [
      { value: "input_video", label: "Из видео" },
      { value: "input_image", label: "Из изображения" },
    ],
    default: "input_video",
  },
];

/** Wan 2.7 driving audio slot (lip-sync / motion timing). */
const MI_DRIVING_AUDIO: MediaInputSlot = {
  slotKey: "driving_audio",
  mode: "driving_audio",
  labelKey: "drivingAudio",
};
/** Wan 2.7 first-clip slot — video that model continues. Wan жёстко режет
 *  входной клип >10s (выяснено по prod-логам: `duration should be at most 10s,
 *  got 14.2s`). Ставим upload-time guard, чтобы юзер не сабмитил заведомо
 *  обречённый payload и не тратил Wan-кредиты. */
const MI_FIRST_CLIP: MediaInputSlot = {
  slotKey: "first_clip",
  mode: "first_clip",
  labelKey: "firstClip",
  constraints: { maxDurationSec: 10 },
};

/** Seedance 2 first/last frame slots — exclusive with reference slots. */
const MI_SEEDANCE_FIRST_FRAME: MediaInputSlot = {
  ...MI_FIRST_FRAME,
  exclusiveGroup: "frames",
};
const MI_SEEDANCE_LAST_FRAME: MediaInputSlot = {
  ...MI_LAST_FRAME,
  exclusiveGroup: "frames",
};

/**
 * Seedance 2 reference-to-video slots — exclusive with frame slots.
 *
 * Constraints ниже взяты из docs/schema/evolink/seedance2.md:
 *   - Изображения: jpeg/png/webp; 300–6000 px по каждой стороне; ratio 0.4–2.5;
 *     ≤30 MB на файл (общий request body ≤64 MB, но это не лимит на отдельный
 *     слот — проверяем по штучно).
 *   - Видео: mp4/mov; 480p–1080p; 300–6000 px; ratio 0.4–2.5; frame pixels
 *     409,600–2,086,876 (≈640² до 2206×946 — 4K phone-видео 8.29M НЕ влезает,
 *     отсюда maxFramePixels); 2–15s; ≤50 MB; total duration всех видео ≤15s.
 *   - Аудио: wav/mp3; 2–15s на клип; ≤15 MB на клип.
 *
 * FPS-чек (24–60) технически тоже есть в доке, но Telegram через
 * `message.video.{...}` его не отдаёт, без ffprobe мы не валидируем.
 * Это единственный gap'а — остальное падает на upload, не на Evolink.
 */
const MI_REF_IMAGES: MediaInputSlot = {
  slotKey: "ref_images",
  mode: "reference_image",
  labelKey: "referenceImages",
  maxImages: 9,
  exclusiveGroup: "refs",
  constraints: {
    maxFileSizeBytes: 30 * 1024 * 1024,
    minWidth: 300,
    maxWidth: 6000,
    minHeight: 300,
    maxHeight: 6000,
    minAspectRatio: 0.4,
    maxAspectRatio: 2.5,
  },
};
const MI_REF_VIDEOS: MediaInputSlot = {
  slotKey: "ref_videos",
  mode: "reference_video",
  labelKey: "referenceVideos",
  maxImages: 3,
  exclusiveGroup: "refs",
  constraints: {
    minDurationSec: 2,
    maxDurationSec: 15,
    maxFileSizeBytes: 50 * 1024 * 1024,
    minWidth: 300,
    maxWidth: 6000,
    minHeight: 300,
    maxHeight: 6000,
    minAspectRatio: 0.4,
    maxAspectRatio: 2.5,
    minFramePixels: 409_600,
    maxFramePixels: 2_086_876,
  },
};
const MI_REF_AUDIOS: MediaInputSlot = {
  slotKey: "ref_audios",
  mode: "reference_audio",
  labelKey: "referenceAudios",
  maxImages: 3,
  exclusiveGroup: "refs",
  constraints: {
    minDurationSec: 2,
    maxDurationSec: 15,
    maxFileSizeBytes: 15 * 1024 * 1024,
  },
};

/** Grok Imagine r2v: до 7 reference-картинок, ссылаются в промпте через @image1..@image7. Required — модель без картинок не имеет смысла. */
const MI_GROK_IMAGINE_REFS_REQUIRED: MediaInputSlot = {
  slotKey: "ref_images",
  mode: "reference_image",
  labelKey: "referenceImages",
  maxImages: 7,
  required: true,
};

/**
 * Grok Imagine extend: исходное видео для продления. Required — без него
 * запрос не валиден. FAL принимает MP4 H.264/H.265/AV1 длиной 2–15s.
 * Заполняется автоматически при тапе на кнопку «Продлить» под результатом.
 */
const MI_GROK_EXTEND_SOURCE_VIDEO: MediaInputSlot = {
  slotKey: "source_video",
  mode: "reference_video",
  labelKey: "sourceVideo",
  maxImages: 1,
  required: true,
};

// ── Mode definitions per model ────────────────────────────────────────────
//
// A model with `modes` always shows a mode picker after activation. Slots are
// then filtered to only those listed in `slotKeys`. When `requiredSlotKeys` is
// set, it overrides each slot's intrinsic `required` flag for this mode (lets
// the same slot be required in one mode and optional in another).

const SEEDANCE_MODES: ModelMode[] = [
  { id: "t2v", labelKey: "t2v", slotKeys: [], textOnly: true, default: true },
  {
    id: "i2v",
    labelKey: "i2v",
    slotKeys: ["first_frame", "last_frame"],
    requiredSlotKeys: ["first_frame"],
  },
  {
    id: "r2v",
    labelKey: "r2v",
    slotKeys: ["ref_images", "ref_videos", "ref_audios"],
  },
];

const VEO_MODES: ModelMode[] = [
  { id: "t2v", labelKey: "t2v", slotKeys: [], textOnly: true, default: true },
  {
    id: "i2v",
    labelKey: "i2v",
    slotKeys: ["first_frame", "last_frame"],
    requiredSlotKeys: ["first_frame"],
  },
  {
    id: "r2v",
    labelKey: "r2v",
    slotKeys: ["reference"],
    requiredSlotKeys: ["reference"],
  },
];

/**
 * Modes для KIE Veo Quality (`veo3`). По докам KIE REFERENCE_2_VIDEO работает
 * ТОЛЬКО на Fast (`veo3_fast`), поэтому r2v убран — иначе юзер бы выбирал
 * режим, который KIE отвергает.
 */
const VEO_MODES_KIE_QUALITY: ModelMode[] = [
  { id: "t2v", labelKey: "t2v", slotKeys: [], textOnly: true, default: true },
  {
    id: "i2v",
    labelKey: "i2v",
    slotKeys: ["first_frame", "last_frame"],
    requiredSlotKeys: ["first_frame"],
  },
];
/**
 * Settings для GOOGLE Veo (Quality + Fast).
 */
const VEO_GOOGLE_SETTINGS: ModelSettingDef[] = [
  mkAspectRatio(["16:9", "9:16"]),
  {
    key: "duration",
    label: "Длительность",
    description:
      "Продолжительность видеоклипа в секундах. При использовании референсных изображений или разрешений 1080p/4K доступен только вариант 8 с.",
    type: "select",
    options: [
      { value: 4, label: "4 с", unavailableIf: { key: "resolution", neq: "720p" } },
      { value: 6, label: "6 с", unavailableIf: { key: "resolution", neq: "720p" } },
      { value: 8, label: "8 с" },
    ],
    default: 4,
  },
  {
    key: "resolution",
    label: "Разрешение",
    description: "Качество видео: 720p — любая длительность, 1080p — только 8 секунд.",
    type: "select",
    options: [
      { value: "720p", label: "720p" },
      {
        value: "1080p",
        label: "1080p",
        unavailableIf: { key: "duration", neq: 8 },
      },
      {
        value: "4k",
        label: "4k",
        unavailableIf: { key: "duration", neq: 8 },
      },
    ],
    default: "720p",
  },
  {
    key: "person_generation",
    label: "Генерация людей",
    description: "Разрешить ли появление людей в видео.",
    type: "select",
    options: [
      { value: "dont_allow", label: "Запрещено" },
      { value: "allow_adult", label: "Разрешены взрослые" },
    ],
    default: "allow_adult",
  },
];

/**
 * Settings для KIE Veo (Quality + Fast). KIE Veo всегда 8s output, длительность
 * нельзя настроить через payload, поэтому duration-слайдер убран. Также нет
 * person_generation (Google-only). Остаётся: aspect ratio + resolution.
 */
const VEO_KIE_SETTINGS: ModelSettingDef[] = [
  mkAspectRatio(["16:9", "9:16"]),
  {
    key: "resolution",
    label: "Разрешение",
    description: "Качество видео. 4K требует больше кредитов.",
    type: "select",
    options: [
      { value: "720p", label: "720p" },
      { value: "1080p", label: "1080p" },
      { value: "4k", label: "4k" },
    ],
    default: "720p",
  },
];

/**
 * Settings для Veo 3.1 через evolink. evolink поддерживает все продвинутые
 * параметры: длительность, разрешение, звук, генерация людей, resize_mode,
 * negative prompt. В REFERENCE mode evolink сам игнорирует duration/aspect/
 * advanced params (по докам), наш UI это не запрещает явно — юзер увидит
 * настройки, но они не будут применены если он загрузил reference image.
 */
const VEO_EVOLINK_SETTINGS: ModelSettingDef[] = [
  // aspect_ratio в r2v evolink форсит 16:9 — скрываем настройку в этом режиме
  // чтобы юзер не думал что его выбор применится.
  {
    ...mkAspectRatio(["16:9", "9:16", "auto"]),
    unavailableIf: { key: "_mode", eq: "r2v" },
  },
  {
    key: "duration",
    label: "Длительность",
    description: "Продолжительность видеоклипа в секундах. В режиме REFERENCE — фиксировано 8 с.",
    type: "select",
    options: [
      // r2v: evolink фиксирует 8s — дизейблим 4 и 6 (комбинируем с existing
      // resolution-constraint через `or`).
      {
        value: 4,
        label: "4 с",
        unavailableIf: {
          or: [
            { key: "resolution", neq: "720p" },
            { key: "_mode", eq: "r2v" },
          ],
        },
      },
      {
        value: 6,
        label: "6 с",
        unavailableIf: {
          or: [
            { key: "resolution", neq: "720p" },
            { key: "_mode", eq: "r2v" },
          ],
        },
      },
      { value: 8, label: "8 с" },
    ],
    default: 4,
  },
  {
    key: "resolution",
    label: "Разрешение",
    description: "Качество видео. 4K увеличивает стоимость.",
    type: "select",
    options: [
      { value: "720p", label: "720p" },
      { value: "1080p", label: "1080p", unavailableIf: { key: "duration", neq: 8 } },
      { value: "4k", label: "4k", unavailableIf: { key: "duration", neq: 8 } },
    ],
    default: "720p",
    // r2v: evolink игнорирует resolution (фактически 720p) — скрываем.
    unavailableIf: { key: "_mode", eq: "r2v" },
  },
  {
    key: "generate_audio",
    label: "Звук",
    description: "Генерировать звук в видео. Влияет на стоимость.",
    type: "toggle",
    default: true,
  },
  {
    key: "person_generation",
    label: "Генерация людей",
    description: "Разрешить ли появление людей в видео.",
    type: "select",
    options: [
      { value: "allow_adult", label: "Разрешены взрослые" },
      { value: "dont_allow", label: "Запрещено" },
    ],
    default: "allow_adult",
    // r2v evolink не поддерживает person_generation (по докам "other advanced
    // params not supported"). Скрываем чтобы юзер не запутался.
    unavailableIf: { key: "_mode", eq: "r2v" },
  },
  {
    key: "resize_mode",
    label: "Режим resize",
    description: "Только для image-to-video. pad — добавить поля; crop — обрезать.",
    type: "select",
    options: [
      { value: "pad", label: "pad" },
      { value: "crop", label: "crop" },
    ],
    default: "pad",
    advanced: true,
    // resize_mode применим только в I2V (FIRST&LAST). В t2v и r2v скрываем.
    unavailableIf: {
      or: [
        { key: "_mode", eq: "t2v" },
        { key: "_mode", eq: "r2v" },
      ],
    },
  },
  {
    key: "negative_prompt",
    label: "Негативный промпт",
    description: "Что НЕ должно появляться в видео.",
    type: "text",
    default: "",
    advanced: true,
    // r2v не поддерживает negative_prompt.
    unavailableIf: { key: "_mode", eq: "r2v" },
  },
];

/**
 * Wan 2.7 supports two distinct image-driven modes per provider docs:
 *  - i2v: starts from a still frame, optional last_frame and driving_audio.
 *  - clipExtend: continues from an existing short video, optional last_frame.
 * The two are mutually exclusive in the provider API, hence separate modes.
 */
const WAN_MODES: ModelMode[] = [
  { id: "t2v", labelKey: "t2v", slotKeys: [], textOnly: true, default: true },
  {
    id: "i2v",
    labelKey: "i2v",
    slotKeys: ["first_frame", "last_frame", "driving_audio"],
    requiredSlotKeys: ["first_frame"],
  },
  {
    id: "clipExtend",
    labelKey: "clipExtend",
    slotKeys: ["first_clip", "last_frame"],
    requiredSlotKeys: ["first_clip"],
  },
];

const KLING_SETTINGS: ModelSettingDef[] = [
  mkAspectRatio(["16:9", "9:16", "1:1"]),
  {
    key: "crop_to_aspect",
    label: "Автокроп фото под формат",
    description:
      "По умолчанию Kling подгоняет видео под пропорции фото. Включи, чтобы вместо этого обрезать фото под выбранный формат (края обрежутся).",
    type: "toggle",
    default: false,
  },
  {
    key: "duration",
    label: "Длительность",
    description: "Продолжительность видеоклипа в секундах.",
    type: "slider",
    default: 5,
    min: 3,
    max: 15,
    step: 1,
  },
  {
    key: "generate_audio",
    label: "Генерировать аудио",
    description: "Включить автоматическую генерацию звукового сопровождения к видео.",
    type: "toggle",
    default: true,
  },
];

export const VIDEO_MODELS: Record<string, AIModel> = {
  kling: {
    id: "kling",
    name: "🎥 Kling 3.0",
    description:
      "Генерирует видео до 15 секунд со звуком. Лучше всех передаёт движения людей. Стандартная версия — быстрее и дешевле Pro.",
    section: "video",
    provider: "kie",
    familyId: "kling",
    variantLabel: "Standard",
    // $0.10/s with audio (default), $0.07/s without audio
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.1,
    costVariants: {
      settingKey: "generate_audio",
      map: { true: { costUsdPerSecond: 0.1 }, false: { costUsdPerSecond: 0.07 } },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    mediaInputs: KLING_MEDIA_INPUTS,
    promptRefs: { elements: { max: 3 } },
    durationRange: { min: 3, max: 15 },
    settings: [...KLING_SETTINGS],
  },
  "kling-pro": {
    id: "kling-pro",
    name: "🎥 Kling 3.0 Pro",
    description:
      "Генерирует видео до 15 секунд со звуком. Лучше всех передаёт движения людей. Pro-версия — повышенная детализация и качество движений.",
    section: "video",
    provider: "kie",
    familyId: "kling",
    variantLabel: "Pro",
    // $0.135/s with audio (default), $0.09/s without audio
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.135,
    costVariants: {
      settingKey: "generate_audio",
      map: { true: { costUsdPerSecond: 0.135 }, false: { costUsdPerSecond: 0.09 } },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    mediaInputs: KLING_MEDIA_INPUTS,
    promptRefs: { elements: { max: 3 } },
    durationRange: { min: 3, max: 15 },
    settings: [...KLING_SETTINGS],
  },
  "kling-motion": {
    id: "kling-motion",
    name: "🎥 Kling Motion",
    description:
      "Переносит движения из референсного видео на любого персонажа с изображения. Standard-версия — быстрее и дешевле Pro. Идеален для портретов и простых анимаций.",
    section: "video",
    provider: "kie",
    familyId: "kling-motion",
    variantLabel: "Standard",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.1,
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    promptOptional: true,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    mediaInputs: KLING_MOTION_MEDIA_INPUTS,
    settings: [...KLING_MOTION_SETTINGS],
  },
  "kling-motion-pro": {
    id: "kling-motion-pro",
    name: "🎥 Kling Motion Pro",
    description:
      "Переносит движения из референсного видео на любого персонажа с изображения. Pro-версия — повышенная точность переноса и детализация.",
    section: "video",
    provider: "kie",
    familyId: "kling-motion",
    variantLabel: "Pro",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.135,
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    promptOptional: true,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    mediaInputs: KLING_MOTION_MEDIA_INPUTS,
    settings: [...KLING_MOTION_SETTINGS],
  },
  // KIE Topaz Video Upscaler. Доступна ТОЛЬКО через готовый сценарий «Апскейл
  // видео» — hiddenFromCarousel убирает её из карусели выбора видеомоделей.
  // Цена — по секундам исходного видео, ставка зависит от `upscale_factor`.
  "video-upscale": {
    id: "video-upscale",
    name: "🎬 Апскейл видео",
    description: "Увеличивает разрешение и чёткость видео с помощью Topaz AI.",
    section: "video",
    provider: "kie",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.04, // base = upscale_factor "2"
    costVariants: {
      settingKey: "upscale_factor",
      map: {
        "2": { costUsdPerSecond: 0.04 },
        "4": { costUsdPerSecond: 0.07 },
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    promptOptional: true,
    isAsync: true,
    hiddenFromCarousel: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    mediaInputs: [{ slotKey: "motion_video", mode: "motion_video", labelKey: "motionVideo" }],
    settings: [
      {
        key: "upscale_factor",
        label: "Степень увеличения",
        description: "Во сколько раз увеличить ширину и высоту видео. Влияет на цену.",
        type: "select",
        options: [
          { value: "2", label: "×2" },
          { value: "4", label: "×4" },
        ],
        default: "2",
      },
    ],
  },
  seedance: {
    id: "seedance",
    name: "💃 Seedance 1.5 Pro (ByteDance)",
    description:
      "Создаёт видео с выразительным движением и генерацией звука. Предыдущее поколение — проверенная стабильность, до 12 секунд. Хорош для креативных и стилизованных роликов.",
    section: "video",
    provider: "evolink",
    familyId: "seedance",
    variantLabel: "1.5 Pro",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.052, // base = 720p with audio (default settings)
    costMatrix: {
      dims: ["resolution", "generate_audio"],
      table: {
        "480p__false": 0.012,
        "480p__true": 0.024,
        "720p__false": 0.026,
        "720p__true": 0.052,
        "1080p__false": 0.058,
        "1080p__true": 0.117,
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    mediaInputs: [MI_FIRST_FRAME, MI_LAST_FRAME],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedDurations: null,
    durationRange: { min: 4, max: 12 },
    settings: [
      mkAspectRatio(["16:9", "9:16", "1:1"]),
      mkDurationSlider(4, 12),
      {
        key: "resolution",
        label: "Разрешение видео",
        description:
          "480p — быстрее генерируется, 720p — стандарт, 1080p — максимальная детализация. Влияет на цену.",
        type: "select",
        options: [
          { value: "480p", label: "480p" },
          { value: "720p", label: "720p" },
          { value: "1080p", label: "1080p" },
        ],
        default: "720p",
      },
      {
        key: "generate_audio",
        label: "Генерировать аудио",
        description:
          "Включить автоматическую генерацию звукового сопровождения к видео. Влияет на цену.",
        type: "toggle",
        default: true,
      },
    ],
  },
  "seedance-2": {
    id: "seedance-2",
    name: "💃 Seedance 2.0 (ByteDance)",
    description:
      "Новейшая видеомодель ByteDance — значительно выше качество и реалистичность движений по сравнению с 1.5. Встроенный звук, до 15 секунд, широкий выбор соотношений сторон.",
    section: "video",
    provider: "evolink",
    familyId: "seedance",
    variantLabel: "2.0 Standard",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.199, // base = 720p no-video
    costVariants: {
      settingKey: "resolution",
      map: {
        "480p": { costUsdPerSecond: 0.092 },
        "720p": { costUsdPerSecond: 0.199 },
        "1080p": { costUsdPerSecond: 0.496 },
      },
    },
    costAddons: [
      // Web search: +$0.0006 per request when enabled (только t2v реально использует)
      { settingKey: "enable_web_search", map: { true: 0.0006 } },
    ],
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    mediaInputs: [
      MI_SEEDANCE_FIRST_FRAME,
      MI_SEEDANCE_LAST_FRAME,
      MI_REF_IMAGES,
      MI_REF_VIDEOS,
      MI_REF_AUDIOS,
    ],
    modes: SEEDANCE_MODES,
    supportedAspectRatios: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    durationRange: { min: 4, max: 15 },
    settings: [
      mkAspectRatio(["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], { auto: "Авто" }),
      mkDurationSlider(4, 15),
      {
        key: "resolution",
        label: "Разрешение видео",
        description:
          "480p — быстрее генерируется, 720p — более чёткое видео, 1080p — максимальная детализация. Влияет на цену.",
        type: "select",
        options: [
          { value: "480p", label: "480p" },
          { value: "720p", label: "720p" },
          { value: "1080p", label: "1080p" },
        ],
        default: "720p",
      },
      {
        key: "generate_audio",
        label: "Генерировать аудио",
        description:
          "Включить автоматическую генерацию звукового сопровождения к видео. На evolink аудио — бесплатно.",
        type: "toggle",
        default: true,
      },
      {
        key: "enable_web_search",
        label: "Web search",
        description: "Подключить веб-поиск (только text-to-video). +$0.0006 за запрос.",
        type: "toggle",
        default: false,
        advanced: true,
      },
    ],
  },
  "seedance-2-fast": {
    id: "seedance-2-fast",
    name: "💃 Seedance 2.0 Fast (ByteDance)",
    description:
      "Ускоренная версия Seedance 2.0 — быстрее и дешевле стандарта при схожем качестве. Встроенная генерация звука, до 15 секунд.",
    section: "video",
    provider: "evolink",
    familyId: "seedance",
    variantLabel: "2.0 Fast",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.161, // base = 720p no-video
    costVariants: {
      settingKey: "resolution",
      map: {
        "480p": { costUsdPerSecond: 0.075 },
        "720p": { costUsdPerSecond: 0.161 },
      },
    },
    costAddons: [{ settingKey: "enable_web_search", map: { true: 0.0006 } }],
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    mediaInputs: [
      MI_SEEDANCE_FIRST_FRAME,
      MI_SEEDANCE_LAST_FRAME,
      MI_REF_IMAGES,
      MI_REF_VIDEOS,
      MI_REF_AUDIOS,
    ],
    modes: SEEDANCE_MODES,
    supportedAspectRatios: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    durationRange: { min: 4, max: 15 },
    settings: [
      mkAspectRatio(["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], { auto: "Авто" }),
      mkDurationSlider(4, 15),
      {
        key: "resolution",
        label: "Разрешение видео",
        description: "480p — быстрее генерируется, 720p — более чёткое видео. Влияет на цену.",
        type: "select",
        options: [
          { value: "480p", label: "480p" },
          { value: "720p", label: "720p" },
        ],
        default: "720p",
      },
      {
        key: "generate_audio",
        label: "Генерировать аудио",
        description:
          "Включить автоматическую генерацию звукового сопровождения к видео. На evolink аудио — бесплатно.",
        type: "toggle",
        default: true,
      },
      {
        key: "enable_web_search",
        label: "Web search",
        description: "Подключить веб-поиск (только text-to-video). +$0.0006 за запрос.",
        type: "toggle",
        default: false,
        advanced: true,
      },
    ],
  },
  "higgsfield-lite": {
    id: "higgsfield-lite",
    name: "🎬 Higgsfield Lite",
    description:
      "Реалистичная анимация людей — мимика, жесты и движения тела. Lite — самая быстрая и бюджетная версия Higgsfield.",
    section: "video",
    provider: "higgsfield",
    familyId: "higgsfield",
    variantLabel: "Lite",
    costUsdPerRequest: 0.125,
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [MI_FIRST_FRAME_REQUIRED],
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedDurations: [5],
    settings: [
      mkAspectRatio(["16:9", "9:16", "1:1"]),
      {
        key: "motions",
        label: "Пресеты движений",
        description:
          "Выберите до 2 пресетов движения камеры. Можно комбинировать два пресета одновременно.",
        type: "motion-picker",
        default: null,
      },
      {
        key: "enhance_prompt",
        label: "Улучшение промпта",
        description:
          "Автоматически улучшает ваш промпт с помощью ИИ для более детального результата.",
        type: "toggle",
        default: true,
      },
      {
        key: "seed",
        label: "Seed",
        description:
          "Фиксирует случайность генерации для воспроизводимых результатов (1–1 000 000). Оставьте пустым для случайного.",
        type: "number",
        min: 1,
        max: 1000000,
        default: null,
        advanced: true,
      },
    ],
  },
  higgsfield: {
    id: "higgsfield",
    name: "🎬 Higgsfield Turbo",
    description:
      "Реалистичная анимация людей — мимика, жесты и движения тела. Turbo — баланс качества и скорости, выше детализация чем Lite.",
    section: "video",
    provider: "higgsfield",
    familyId: "higgsfield",
    variantLabel: "Turbo",
    costUsdPerRequest: 0.406,
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [MI_FIRST_FRAME_REQUIRED],
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedDurations: [5],
    settings: [
      mkAspectRatio(["16:9", "9:16", "1:1"]),
      {
        key: "motions",
        label: "Пресеты движений",
        description:
          "Выберите до 2 пресетов движения камеры. Можно комбинировать два пресета одновременно.",
        type: "motion-picker",
        default: null,
      },
      {
        key: "enhance_prompt",
        label: "Улучшение промпта",
        description:
          "Автоматически улучшает ваш промпт с помощью ИИ для более детального результата.",
        type: "toggle",
        default: true,
      },
      {
        key: "seed",
        label: "Seed",
        description:
          "Фиксирует случайность генерации для воспроизводимых результатов (1–1 000 000). Оставьте пустым для случайного.",
        type: "number",
        min: 1,
        max: 1000000,
        default: null,
        advanced: true,
      },
    ],
  },
  "higgsfield-preview": {
    id: "higgsfield-preview",
    name: "🎬 Higgsfield Preview",
    description:
      "Реалистичная анимация людей — мимика, жесты и движения тела. Preview — флагманская версия с максимальным качеством, освещением и кинематографичностью.",
    section: "video",
    provider: "higgsfield",
    familyId: "higgsfield",
    variantLabel: "Preview",
    descriptionOverride:
      "Флагманская версия с максимальным качеством — наиболее реалистичное освещение, детали и кинематографичность.",
    costUsdPerRequest: 0.563,
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [MI_FIRST_FRAME_REQUIRED],
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedDurations: [5],
    settings: [
      mkAspectRatio(["16:9", "9:16", "1:1"]),
      {
        key: "motions",
        label: "Пресеты движений",
        description:
          "Выберите до 2 пресетов движения камеры. Можно комбинировать два пресета одновременно.",
        type: "motion-picker",
        default: null,
      },
      {
        key: "enhance_prompt",
        label: "Улучшение промпта",
        description:
          "Автоматически улучшает ваш промпт с помощью ИИ для более детального результата.",
        type: "toggle",
        default: true,
      },
      {
        key: "seed",
        label: "Seed",
        description:
          "Фиксирует случайность генерации для воспроизводимых результатов (1–1 000 000). Оставьте пустым для случайного.",
        type: "number",
        min: 1,
        max: 1000000,
        default: null,
        advanced: true,
      },
    ],
  },
  heygen: {
    id: "heygen",
    name: "👤 HeyGen",
    description:
      "Особенно популярен среди соло-креаторов, инфлюенсеров и небольших команд. Для аватаров, lip-sync, перевода видео на 175+ языков.",
    section: "video",
    provider: "heygen",
    // $0.05/s Engine IV (Avatar IV — custom photo upload) ≈ $6.00/min
    // + $0.04 flat fee per request (API overhead) (deprecated)
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.05,
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: true,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16"],
    supportedDurations: null, // avatar duration is script-driven
    mediaInputs: [
      { slotKey: "avatar_photo", mode: "reference_image", labelKey: "avatarPhoto" },
      { slotKey: "voice_audio", mode: "driving_audio", labelKey: "voiceAudio" },
    ],
    settings: [
      mkAspectRatio(["16:9", "9:16"]),
      {
        key: "avatar_id",
        label: "Аватар",
        description: "Выберите официальный аватар HeyGen или загрузите собственное фото.",
        type: "avatar-picker",
        default: "",
      },
      {
        key: "voice_id",
        label: "Голос",
        description: "Выберите официальный голос HeyGen или клонированный голос ElevenLabs.",
        type: "voice-picker",
        default: "",
      },
      {
        key: "background_color",
        label: "Цвет фона",
        type: "color",
        default: "#FFFFFF",
        advanced: true,
      },
      {
        key: "resolution",
        label: "Разрешение",
        type: "select",
        options: [
          { value: "1080p", label: "1080p" },
          { value: "720p", label: "720p" },
        ],
        default: "1080p",
      },
      {
        key: "expressiveness",
        label: "Выразительность",
        description: "Только для фото-аватара",
        type: "select",
        options: [
          { value: "low", label: "Низкая" },
          { value: "medium", label: "Средняя" },
          { value: "high", label: "Высокая" },
        ],
        default: "low",
        unavailableIf: {
          and: [
            { key: "avatar_id", present: true },
            { key: "image_asset_id", absent: true },
          ],
        },
      },
      {
        key: "motion_prompt",
        label: "Описание движений",
        description: "Только для фото-аватара",
        type: "text",
        default: null,
        advanced: true,
        unavailableIf: {
          and: [
            { key: "avatar_id", present: true },
            { key: "image_asset_id", absent: true },
          ],
        },
      },
      {
        key: "voice_settings_enabled",
        label: "Настроить голос",
        type: "toggle",
        default: false,
        advanced: true,
      },
      {
        key: "voice_speed",
        label: "Скорость речи",
        type: "slider",
        min: 0.5,
        max: 1.5,
        step: 0.1,
        default: 1.0,
        advanced: true,
        unavailableIf: { key: "voice_settings_enabled", absent: true },
      },
      {
        key: "voice_pitch",
        label: "Тон голоса",
        type: "slider",
        min: -50,
        max: 50,
        step: 1,
        default: 0,
        advanced: true,
        unavailableIf: { key: "voice_settings_enabled", absent: true },
      },
      {
        key: "voice_locale",
        label: "Язык голоса",
        type: "dropdown",
        default: null,
        advanced: true,
        options: [
          { value: "", label: "auto" },
          { value: "ru-RU", label: "🇷🇺 Русский" },
          { value: "uk-UA", label: "🇺🇦 Українська" },
          { value: "kk-KZ", label: "🇰🇿 Қазақша" },
          { value: "be-BY", label: "🇧🇾 Беларуская" },
          { value: "uz-UZ", label: "🇺🇿 O'zbek" },
          { value: "az-AZ", label: "🇦🇿 Azərbaycan" },
          { value: "hy-AM", label: "🇦🇲 Հայերեն" },
          { value: "ka-GE", label: "🇬🇪 ქართული" },
          { value: "tg-TJ", label: "🇹🇯 Тоҷикӣ" },
          { value: "tk-TM", label: "🇹🇲 Türkmen" },
          { value: "ky-KG", label: "🇰🇬 Кыргызча" },
          { value: "mn-MN", label: "🇲🇳 Монгол" },
          { value: "lv-LV", label: "🇱🇻 Latviešu" },
          { value: "lt-LT", label: "🇱🇹 Lietuvių" },
          { value: "et-EE", label: "🇪🇪 Eesti" },
          { value: "en-US", label: "🇺🇸 English (US)" },
          { value: "en-GB", label: "🇬🇧 English (UK)" },
          { value: "de-DE", label: "🇩🇪 Deutsch" },
          { value: "zh-CN", label: "🇨🇳 中文" },
          { value: "tr-TR", label: "🇹🇷 Türkçe" },
          { value: "es-ES", label: "🇪🇸 Español" },
          { value: "fr-FR", label: "🇫🇷 Français" },
          { value: "pt-BR", label: "🇧🇷 Português (BR)" },
          { value: "ar-SA", label: "🇸🇦 العربية" },
          { value: "hi-IN", label: "🇮🇳 हिन्दी" },
          { value: "ja-JP", label: "🇯🇵 日本語" },
          { value: "ko-KR", label: "🇰🇷 한국어" },
          { value: "it-IT", label: "🇮🇹 Italiano" },
          { value: "pl-PL", label: "🇵🇱 Polski" },
          { value: "id-ID", label: "🇮🇩 Bahasa Indonesia" },
        ],
        unavailableIf: { key: "voice_settings_enabled", absent: true },
      },
    ],
  },
  // ── Grok Imagine: разделено на text-to-video и reference-to-video ──────────
  // Раньше была одна модель `grok-imagine` с durationRange 6-30, но реальные
  // лимиты xAI отличаются по режимам: t2v поддерживает до 15s, r2v — до 10s.
  // Юзеры выставляли длительность больше реального лимита и получали 5xx от
  // KIE. Разделили на 2 видимых в UI модели, durationRange у каждой —
  // фактический лимит провайдера. Идентификатор `grok-imagine` сохранён за
  // t2v чтобы не сломать сохранённый `videoModelId` у существующих юзеров.
  "grok-imagine": {
    id: "grok-imagine",
    name: "🔮 Grok Imagine (текст → видео)",
    description:
      "Видеомодель от xAI (Grok), режим text-to-video. Без референсных изображений — генерация только по текстовому промпту.",
    section: "video",
    provider: "kie",
    familyId: "grok-imagine",
    variantLabel: "текст → видео",
    // Resolution-based: 480p $0.008/s, 720p $0.015/s
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.008,
    costVariants: {
      settingKey: "resolution",
      map: {
        "480p": { costUsdPerSecond: 0.008 },
        "720p": { costUsdPerSecond: 0.015 },
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: false,
    mediaInputs: [],
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["2:3", "3:2", "1:1", "16:9", "9:16"],
    durationRange: { min: 6, max: 15 },
    // xAI (Grok) hardcap — провайдер 422-ит запрос «Prompt length exceeds the
    // maximum allowed length of 4096». Лимит модели, одинаков и на KIE primary,
    // и на FAL fallback — поэтому объявлен на самой AIModel записи, а не на адаптере.
    maxPromptLength: 4096,
    settings: [
      mkAspectRatio(["16:9", "9:16", "1:1", "2:3", "3:2"]),
      mkDurationSlider(6, 15),
      {
        key: "resolution",
        label: "Разрешение видео",
        description: "480p — быстрее и дешевле, 720p — более чёткое видео. Влияет на цену.",
        type: "select",
        options: [
          { value: "480p", label: "480p" },
          { value: "720p", label: "720p" },
        ],
        default: "480p",
      },
      {
        key: "mode",
        label: "Режим генерации",
        description:
          "Fun — более креативная и игривая интерпретация, Normal — сбалансированный подход.",
        type: "select",
        options: [
          { value: "fun", label: "Fun" },
          { value: "normal", label: "Normal" },
        ],
        default: "normal",
      },
    ],
  },
  "grok-imagine-r2v": {
    id: "grok-imagine-r2v",
    name: "🔮 Grok Imagine (фото → видео)",
    description:
      "Видеомодель от xAI (Grok), режим reference-to-video. Принимает до 7 референсных изображений — ссылайтесь на них в промпте через @Image1, @Image2 и т.д.",
    section: "video",
    provider: "kie",
    familyId: "grok-imagine",
    variantLabel: "фото → видео",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.008,
    costVariants: {
      settingKey: "resolution",
      map: {
        "480p": { costUsdPerSecond: 0.008 },
        "720p": { costUsdPerSecond: 0.015 },
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [MI_GROK_IMAGINE_REFS_REQUIRED],
    promptRefs: { images: { max: 7 } },
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["2:3", "3:2", "1:1", "16:9", "9:16"],
    durationRange: { min: 6, max: 10 },
    // xAI (Grok) hardcap — см. комментарий на `grok-imagine`.
    maxPromptLength: 4096,
    settings: [
      mkAspectRatio(["16:9", "9:16", "1:1", "2:3", "3:2"]),
      mkDurationSlider(6, 10),
      {
        key: "resolution",
        label: "Разрешение видео",
        description: "480p — быстрее и дешевле, 720p — более чёткое видео. Влияет на цену.",
        type: "select",
        options: [
          { value: "480p", label: "480p" },
          { value: "720p", label: "720p" },
        ],
        default: "480p",
      },
      {
        key: "mode",
        label: "Режим генерации",
        description:
          "Fun — более креативная и игривая интерпретация, Normal — сбалансированный подход.",
        type: "select",
        options: [
          { value: "fun", label: "Fun" },
          { value: "normal", label: "Normal" },
        ],
        default: "normal",
      },
    ],
  },
  // ── Grok Imagine Extend (скрытая модель) ─────────────────────────────────────
  // Активируется только через кнопку «🔁 Продлить» под результатом Grok-видео.
  // FAL endpoint `xai/grok-imagine-video/extend-video`: prompt + video_url +
  // duration. Output = original + extension склеенные. Источник видео
  // прикрепляется в slot source_video автоматически.
  //
  // Один уровень глубины: после extend output > 15s часто, и FAL не примет
  // его как input для повторного extend (limit 2-15s). Поэтому кнопку
  // «Продлить» под результатом extend'а НЕ показываем.
  //
  // Pricing: FAL extend pricing — $0.06/s flat (между r2v $0.05 и t2v $0.07).
  "grok-imagine-extend": {
    id: "grok-imagine-extend",
    name: "🔁 Grok Imagine — продление",
    description:
      "Продление существующего Grok-видео. Активируется только через кнопку «🔁 Продлить» под результатом.",
    section: "video",
    provider: "fal",
    hiddenFromCarousel: true,
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.06,
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: false,
    mediaInputs: [MI_GROK_EXTEND_SOURCE_VIDEO],
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: [],
    // xAI (Grok) hardcap — см. комментарий на `grok-imagine`.
    maxPromptLength: 4096,
    // FAL spec формально допускает 2-10s, но на коротких extension'ах (2-5s)
    // провайдер часто возвращает ошибки/невалидный output — сужаем диапазон
    // до 6-10s, что совпадает с FAL endpoint default = 6 и даёт стабильный
    // результат. Cost preview, slider и адаптер используют эту же min для
    // дефолта, чтобы не было расхождения «показали $X — списали $Y».
    durationRange: { min: 6, max: 10 },
    settings: [mkDurationSlider(6, 10)],
  },
  veo: {
    id: "veo",
    name: "📽️ Veo 3.1",
    description:
      "Видео от Google со звуком и голосами. Поддерживает вертикальный формат для Reels и Shorts. Standard — максимальное качество, выше детализации чем Fast. Можно задать первый и последний кадр — Veo сгенерирует плавный переход между ними.",
    section: "video",
    provider: "evolink",
    familyId: "veo",
    variantLabel: "Pro",
    // Evolink Veo 3.1 Pro: per-second × resolution × generate_audio (см. costMatrix).
    //   720p/1080p, no audio:  $0.186/s
    //   720p/1080p, with audio: $0.373/s
    //   4K, no audio:           $0.373/s
    //   4K, with audio:         $0.559/s
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.186,
    costMatrix: {
      dims: ["resolution", "generate_audio"],
      table: {
        "720p__false": 0.186,
        "720p__true": 0.373,
        "1080p__false": 0.186,
        "1080p__true": 0.373,
        "4k__false": 0.373,
        "4k__true": 0.559,
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [MI_FIRST_FRAME, MI_LAST_FRAME, MI_REFERENCE_VEO],
    modes: VEO_MODES,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16", "auto"],
    supportedDurations: [4, 6, 8],
    settings: VEO_EVOLINK_SETTINGS,
  },
  "veo-fast": {
    id: "veo-fast",
    name: "📽️ Veo 3.1 Fast",
    description:
      "Быстрая и более доступная версия Veo 3.1 от Google. Со звуком и голосами, но чуть ниже детализация чем Standard. Поддерживает 4K. Можно задать первый и последний кадр — Veo сгенерирует плавный переход между ними.",
    section: "video",
    provider: "evolink",
    familyId: "veo",
    variantLabel: "Fast",
    // Evolink Veo 3.1 Fast: per-second × resolution × generate_audio.
    //   720p/1080p, no audio:  $0.093/s
    //   720p/1080p, with audio: $0.140/s
    //   4K, no audio:           $0.280/s
    //   4K, with audio:         $0.327/s
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.093,
    costMatrix: {
      dims: ["resolution", "generate_audio"],
      table: {
        "720p__false": 0.093,
        "720p__true": 0.14,
        "1080p__false": 0.093,
        "1080p__true": 0.14,
        "4k__false": 0.28,
        "4k__true": 0.327,
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [MI_FIRST_FRAME, MI_LAST_FRAME, MI_REFERENCE_VEO],
    modes: VEO_MODES,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16", "auto"],
    supportedDurations: [4, 6, 8],
    settings: VEO_EVOLINK_SETTINGS,
  },
  "hailuo-fast": {
    id: "hailuo-fast",
    name: "🎞️ Hailuo 2.3 Fast",
    description:
      "Быстрая версия Hailuo 2.3 от MiniMax — ~40% дешевле стандартной при схожем качестве. Чуть ниже детализация. Требует фото как первый кадр.",
    section: "video",
    provider: "minimax",
    familyId: "minimax",
    variantLabel: "Fast",
    mediaInputs: [MI_FIRST_FRAME, MI_LAST_FRAME],
    // Default: 768P × 6s = $0.19. Exact price depends on resolution × duration — see costMatrix.
    costUsdPerRequest: 0.19,
    costMatrix: {
      dims: ["resolution", "duration"],
      table: {
        "768P__6": 0.19,
        "768P__10": 0.32,
        "1080P__6": 0.33,
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9"],
    supportedDurations: [6, 10],
    settings: [
      mkDurationSelect([6, 10]),
      {
        key: "resolution",
        label: "Разрешение видео",
        description:
          "768p — для любой длины включая 10с, 1080p — Full HD только для 6-секундных клипов.",
        type: "select",
        options: [
          { value: "768P", label: "768p" },
          { value: "1080P", label: "1080p" },
        ],
        default: "768P",
      },
    ],
  },
  hailuo: {
    id: "hailuo",
    name: "🎞️ Hailuo 2.3",
    description:
      "Стандартная версия Hailuo 2.3 от MiniMax — максимальное качество, поддержка 1080p и 10-секундных клипов. Принимает фото как первый кадр.",
    section: "video",
    provider: "minimax",
    familyId: "minimax",
    variantLabel: "Standard",
    mediaInputs: [MI_FIRST_FRAME, MI_LAST_FRAME],
    // Default: 768P × 6s = $0.28. Exact price depends on resolution × duration — see costMatrix.
    costUsdPerRequest: 0.28,
    costMatrix: {
      dims: ["resolution", "duration"],
      table: {
        "768P__6": 0.28,
        "768P__10": 0.56,
        "1080P__6": 0.49,
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9"],
    supportedDurations: [6, 10],
    settings: [
      {
        key: "duration",
        label: "Длительность",
        description: "Продолжительность видеоклипа в секундах.",
        type: "select",
        options: [
          { value: 6, label: "6 с" },
          { value: 10, label: "10 с", unavailableIf: { key: "resolution", eq: "1080P" } },
        ],
        default: 6,
      },
      {
        key: "resolution",
        label: "Разрешение видео",
        description:
          "768p — для любой длины включая 10с, 1080p — Full HD только для 6-секундных клипов.",
        type: "select",
        options: [
          { value: "768P", label: "768p" },
          { value: "1080P", label: "1080p", unavailableIf: { key: "duration", eq: 10 } },
        ],
        default: "768P",
      },
    ],
  },
  sora: {
    id: "sora",
    name: "🌌 Sora 2",
    description:
      "Устаревшая модель генерации видео от OpenAI. Объекты двигаются как в реальности, со звуком и правильной физикой. Отправьте фото вместе с текстом — оно станет первым кадром видео.",
    section: "video",
    provider: "replicate",
    // $0.10/s (via Replicate openai/sora)
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.1,
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [MI_REFERENCE],
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    // Native Replicate values: "portrait" (720×1280) and "landscape" (1280×720)
    supportedAspectRatios: ["portrait", "landscape"],
    supportedDurations: [4, 8, 12],
    settings: [
      {
        key: "aspect_ratio",
        label: "Соотношение сторон",
        description: "Portrait — вертикальное видео 720×1280, Landscape — горизонтальное 1280×720.",
        type: "select",
        options: [
          { value: "portrait", label: "Portrait (9:16)" },
          { value: "landscape", label: "Landscape (16:9)" },
        ],
        default: "portrait",
      },
      mkDurationSelect([4, 8, 12]),
    ],
  },
  runway: {
    id: "runway",
    name: "🛫 Runway Gen-4.5",
    description:
      "Полный контроль над видео: указывайте, что и как должно двигаться, управляйте камерой. Выбор профессионалов.",
    section: "video",
    provider: "runway",
    // $0.12/s (Gen-4.5); 5s=$0.60, 8s=$0.96, 10s=$1.20
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.12,
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    // first_frame опциональный: с ним → POST /v1/image_to_video; без него →
    // POST /v1/text_to_video (адаптер выбирает endpoint автоматически).
    mediaInputs: [{ ...MI_FIRST_FRAME, constraints: RUNWAY_IMAGE_ASPECT }],
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["1280:720", "720:1280"],
    supportedDurations: [5, 10],
    settings: [
      mkAspectRatio(["1280:720", "720:1280"], {
        "1280:720": "16:9",
        "720:1280": "9:16",
      }),
      mkDurationSelect([5, 10]),
      {
        key: "seed",
        label: "Seed",
        description:
          "Число для воспроизведения результата. Пусто — случайный результат каждый раз.",
        type: "number",
        min: 0,
        max: 4294967295,
        default: null,
        advanced: true,
      },
      // {
      //   key: "camera_horizontal",
      //   label: "Движение камеры: лево/право",
      //   description:
      //     "Панорамирование камеры по горизонтали: отрицательные значения — влево, положительные — вправо.",
      //   type: "slider",
      //   min: -10,
      //   max: 10,
      //   step: 0.5,
      //   default: 0,
      //   advanced: true,
      // },
      // {
      //   key: "camera_vertical",
      //   label: "Движение камеры: вверх/вниз",
      //   description:
      //     "Панорамирование камеры по вертикали: отрицательные значения — вниз, положительные — вверх.",
      //   type: "slider",
      //   min: -10,
      //   max: 10,
      //   step: 0.5,
      //   default: 0,
      //   advanced: true,
      // },
      // {
      //   key: "camera_zoom",
      //   label: "Зум камеры",
      //   description:
      //     "Приближение или удаление камеры: положительные значения — наезд, отрицательные — отъезд.",
      //   type: "slider",
      //   min: -10,
      //   max: 10,
      //   step: 0.5,
      //   default: 0,
      //   advanced: true,
      // },
    ],
  },
  "luma-ray2": {
    id: "luma-ray2",
    name: "☀️ Luma: Ray 2",
    description:
      "Реалистичное видео от Luma AI. Плавные движения, кинематографическое качество. Поддерживает фото как первый кадр.",
    section: "video",
    provider: "luma",
    // Per-second billing; rate depends on resolution (default 720p = $0.142/s)
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.142,
    costVariants: {
      settingKey: "resolution",
      map: {
        "540p": { costUsdPerSecond: 0.08 },
        "720p": { costUsdPerSecond: 0.142 },
        "1080p": { costUsdPerSecond: 0.172 },
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [MI_FIRST_FRAME, MI_LAST_FRAME],
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16", "4:3", "3:4", "1:1"],
    supportedDurations: [5, 9],
    settings: [
      mkAspectRatio(["16:9", "9:16", "4:3", "3:4", "1:1"]),
      mkDurationSelect([5, 9]),
      {
        key: "resolution",
        label: "Разрешение видео",
        description: "540p — дешевле, 720p — стандарт, 1080p — Full HD. Влияет на цену.",
        type: "select",
        options: [
          { value: "540p", label: "540p" },
          { value: "720p", label: "720p" },
          { value: "1080p", label: "1080p" },
        ],
        default: "720p",
      },
      {
        key: "loop",
        label: "Зациклить видео",
        description:
          "Последний кадр плавно переходит в первый — идеально для бесконечных анимаций.",
        type: "toggle",
        default: false,
      },
    ],
  },
  minimax: {
    id: "minimax",
    name: "🎦 MiniMax Video-01",
    description:
      "Китайская видеомодель с отличным качеством движения персонажей. Генерирует 6-секундные клипы с высокой плавностью.",
    section: "video",
    provider: "minimax",
    costUsdPerRequest: 0.43,
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: false,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9"],
    supportedDurations: [6],
    settings: [
      {
        key: "resolution",
        label: "Разрешение видео",
        description: "Качество выходного видео. 720P — стандартное HD.",
        type: "select",
        options: [{ value: "720P", label: "720p" }],
        default: "720P",
      },
    ],
  },
  pika: {
    id: "pika",
    name: "📸 Pika 2.2",
    description:
      "Быстрые видео с крутыми спецэффектами: взрывы, плавление, сжатие. Идеально для TikTok и Reels. Поддерживает фото как первый кадр.",
    section: "video",
    provider: "fal",
    // Per-generation flat fee: 720p/5s=$0.20, 1080p/5s=$0.45 (10s assumed ×2)
    costUsdPerRequest: 0.2,
    costMatrix: {
      dims: ["resolution", "duration"],
      table: {
        "720p__5": 0.2,
        "720p__10": 0.4,
        "1080p__5": 0.45,
        "1080p__10": 0.9,
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [MI_FIRST_FRAME],
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: null,
    supportedDurations: [5, 10],
    settings: [
      mkDurationSelect([5, 10]),
      {
        key: "resolution",
        label: "Разрешение видео",
        description: "720p — быстрее и дешевле, 1080p — Full HD. Влияет на цену.",
        type: "select",
        options: [
          { value: "720p", label: "720p" },
          { value: "1080p", label: "1080p" },
        ],
        default: "720p",
      },
      {
        key: "negative_prompt",
        label: "Негативный промпт",
        description: "Что НЕ должно появляться в видео.",
        type: "text",
        default: "",
        advanced: true,
      },
      {
        key: "seed",
        label: "Seed",
        description: "Зерно генерации для воспроизводимого результата.",
        type: "number",
        min: 0,
        default: null,
        advanced: true,
      },
    ],
  },
  wan: {
    id: "wan",
    name: "🏯 Wan 2.7 (Alibaba)",
    description:
      "Видеомодель Alibaba с высоким качеством движения и поддержкой 1080p. Поддерживает три режима: image-to-video (первый кадр, опционально последний кадр и driving audio) и video continuation (начальный клип, опционально последний кадр). Без медиа — text-to-video с соотношением из настроек.",
    section: "video",
    provider: "alibaba",
    // Per-second billing: 720P=$0.10/s, 1080P=$0.15/s (international endpoint)
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.1,
    costVariants: {
      settingKey: "resolution",
      map: {
        "720P": { costUsdPerSecond: 0.1 },
        "1080P": { costUsdPerSecond: 0.15 },
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [MI_FIRST_FRAME, MI_LAST_FRAME, MI_DRIVING_AUDIO, MI_FIRST_CLIP],
    modes: WAN_MODES,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    supportedDurations: null,
    durationRange: { min: 2, max: 15 },
    settings: [
      mkAspectRatio(["16:9", "9:16", "1:1", "4:3", "3:4"]),
      mkDurationSlider(2, 15),
      {
        key: "resolution",
        label: "Разрешение видео",
        description: "720P — стандартное HD, 1080P — Full HD. Влияет на цену.",
        type: "select",
        options: [
          { value: "720P", label: "720p" },
          { value: "1080P", label: "1080p" },
        ],
        default: "720P",
      },
      {
        key: "prompt_extend",
        label: "Улучшение промпта",
        description:
          "Автоматически расширяет ваш промпт через LLM для более детального результата.",
        type: "toggle",
        default: true,
      },
      {
        key: "negative_prompt",
        label: "Негативный промпт",
        description:
          "Что НЕ должно появляться в видео. Перечислите нежелательные объекты или стили.",
        type: "text",
        default: "",
        advanced: true,
      },
      {
        key: "seed",
        label: "Seed",
        description: "Зерно генерации для воспроизводимого результата. Пусто — случайный.",
        type: "number",
        min: 0,
        max: 2147483647,
        default: null,
        advanced: true,
      },
    ],
  },
};

/**
 * Fallback-альтернативы для видео-моделей. `id` совпадает с primary
 * из VIDEO_MODELS; `provider` (и всё остальное) — собственное.
 * При недоступности primary processor возьмёт первую запись с тем же id,
 * совместимую с media-режимом задачи (см. isFallbackCompatible).
 *
 * Пустой массив = fallback выключен. Цена для биллинга всегда берётся
 * из primary, независимо от того, какой fallback сработал.
 *
 * Для sticky-моделей (HeyGen avatar) fallback не имеет смысла — не заполняем.
 */
export const FALLBACK_VIDEO_MODELS: AIModel[] = [
  // ── Kling Motion via evolink (https://api.evolink.ai) ──────────────────────
  // KIE primary'и роутятся на evolink kling-v3-motion-control:
  //   kling-motion     → quality=720p
  //   kling-motion-pro → quality=1080p
  // Билинг при fallback'е по KIE-цене ($0.10/$0.135 per second). При промоушене
  // в primary — evolink-цена ($0.12/$0.16 per second), задана в costUsdPerSecond.
  // KIE primary settings (`character_orientation`, `background_source`) частично
  // совместимы: evolink принимает character_orientation, но НЕ background_source —
  // лишний setting просто игнорируется адаптером.
  {
    id: "kling-motion",
    name: "Kling Motion (evolink fallback)",
    description: "Fallback на evolink при недоступности KIE.",
    section: "video",
    provider: "evolink",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.12, // 720p quality
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    promptOptional: true,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    // Те же slot-keys что у primary'я для совместимости в isFallbackCompatible.
    mediaInputs: KLING_MOTION_MEDIA_INPUTS,
    settings: [
      {
        key: "character_orientation",
        label: "Ориентация персонажа",
        description:
          "«По видео» — ориентация как в референсном видео (рекомендуется). «По изображению» — ориентация как на исходном фото.",
        type: "select",
        options: [
          { value: "video", label: "По видео" },
          { value: "image", label: "По изображению" },
        ],
        default: "video",
      },
      {
        key: "keep_sound",
        label: "Сохранить звук",
        description: "Оставить оригинальный звук из референсного видео.",
        type: "toggle",
        default: true,
      },
    ],
  },
  {
    id: "kling-motion-pro",
    name: "Kling Motion Pro (evolink fallback)",
    description: "Fallback на evolink при недоступности KIE.",
    section: "video",
    provider: "evolink",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.16, // 1080p quality
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    promptOptional: true,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    mediaInputs: KLING_MOTION_MEDIA_INPUTS,
    settings: [
      {
        key: "character_orientation",
        label: "Ориентация персонажа",
        description:
          "«По видео» — ориентация как в референсном видео (рекомендуется). «По изображению» — ориентация как на исходном фото.",
        type: "select",
        options: [
          { value: "video", label: "По видео" },
          { value: "image", label: "По изображению" },
        ],
        default: "video",
      },
      {
        key: "keep_sound",
        label: "Сохранить звук",
        description: "Оставить оригинальный звук из референсного видео.",
        type: "toggle",
        default: true,
      },
    ],
  },
  // ── Kling 3.0 / 3.0 Pro via evolink (kling-o3-image-to-video) ──────────────
  // Routed на эту модель потому что kling-v3-image-to-video требует image_start
  // (нет t2v), а kling-o3-r2v требует video_url. o3-i2v — единственный вариант
  // покрывающий и t2v и i2v режимы primary'я.
  //
  // Pricing (per-second, varies by quality × sound):
  //   720p off=$0.079, on=$0.106
  //   1080p off=$0.106, on=$0.132
  // Биллинг при fallback'е по KIE-цене ($0.10/$0.135 with audio). При промоушене
  // в primary — evolink-цена ниже у std (но дороже у pro).
  //
  // Element references (primary's ref_element_*) маппятся через image_urls:
  // берём ПЕРВОЕ изображение из каждого слота → image_urls[i] →
  // referenceable в prompt'е через <<<image_N>>> (адаптер сам переписывает
  // @elementN syntax). Это degraded-режим — теряем многокадровое представление
  // элемента, но сохраняем визуальный референс.
  {
    id: "kling",
    name: "Kling 3.0 (evolink fallback)",
    description: "Fallback на evolink при недоступности KIE.",
    section: "video",
    provider: "evolink",
    costUsdPerRequest: 0,
    // base = audio on (matches primary KLING_SETTINGS default)
    costUsdPerSecond: 0.106,
    costVariants: {
      settingKey: "generate_audio",
      map: {
        true: { costUsdPerSecond: 0.106 },
        false: { costUsdPerSecond: 0.079 },
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    mediaInputs: KLING_MEDIA_INPUTS,
    promptRefs: { elements: { max: 3 } },
    durationRange: { min: 3, max: 15 },
    settings: [...KLING_SETTINGS],
  },
  {
    id: "kling-pro",
    name: "Kling 3.0 Pro (evolink fallback)",
    description: "Fallback на evolink при недоступности KIE.",
    section: "video",
    provider: "evolink",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.132,
    costVariants: {
      settingKey: "generate_audio",
      map: {
        true: { costUsdPerSecond: 0.132 },
        false: { costUsdPerSecond: 0.106 },
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    mediaInputs: KLING_MEDIA_INPUTS,
    promptRefs: { elements: { max: 3 } },
    durationRange: { min: 3, max: 15 },
    settings: [...KLING_SETTINGS],
  },
  // ── Kling 3.0 / 3.0 Pro via FAL kling-video/o3 (вторичный fallback) ─────────
  // Перебирается ПОСЛЕ evolink. FalVideoAdapter сам выбирает endpoint по inputs:
  //   нет media       → fal-ai/kling-video/o3/{quality}/text-to-video
  //   только start/end → fal-ai/kling-video/o3/{quality}/image-to-video
  //   ref_element_*   → fal-ai/kling-video/o3/{quality}/reference-to-video
  //
  // Pricing (per-second × quality × audio):
  //   standard 720p: off=$0.084, on=$0.112
  //   pro 1080p:     off=$0.112, on=$0.140
  //
  // Полная fidelity для elements (frontal_image_url + reference_image_urls)
  // в отличие от evolink i2v — здесь используется родная FAL element-структура.
  {
    id: "kling",
    name: "Kling 3.0 (fal fallback)",
    description: "Fallback на FAL при недоступности KIE и evolink.",
    section: "video",
    provider: "fal",
    costUsdPerRequest: 0,
    // base = audio on (matches primary KLING_SETTINGS default)
    costUsdPerSecond: 0.112,
    costVariants: {
      settingKey: "generate_audio",
      map: {
        true: { costUsdPerSecond: 0.112 },
        false: { costUsdPerSecond: 0.084 },
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    mediaInputs: KLING_MEDIA_INPUTS,
    promptRefs: { elements: { max: 3 } },
    durationRange: { min: 3, max: 15 },
    settings: [...KLING_SETTINGS],
  },
  {
    id: "kling-pro",
    name: "Kling 3.0 Pro (fal fallback)",
    description: "Fallback на FAL при недоступности KIE и evolink.",
    section: "video",
    provider: "fal",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.14,
    costVariants: {
      settingKey: "generate_audio",
      map: {
        true: { costUsdPerSecond: 0.14 },
        false: { costUsdPerSecond: 0.112 },
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    mediaInputs: KLING_MEDIA_INPUTS,
    promptRefs: { elements: { max: 3 } },
    durationRange: { min: 3, max: 15 },
    settings: [...KLING_SETTINGS],
  },
  // ── Seedance 1.5 Pro via FAL (бывший primary) ───────────────────────────────
  // Промоушен evolink в primary; FAL-реализация осталась как fallback.
  // Pricing FAL: per-video-token (token = w×h×fps×duration / 1024).
  //   $2.4/M tokens with audio, $1.2/M without audio.
  // FalVideoAdapter уже умеет seedance modelId (FAL_ENDPOINTS / FAL_I2V_ENDPOINTS) —
  // никаких adapter-changes не нужно.
  {
    id: "seedance",
    name: "Seedance 1.5 Pro (fal fallback)",
    description: "Fallback на FAL при недоступности evolink.",
    section: "video",
    provider: "fal",
    costUsdPerRequest: 0,
    costUsdPerMVideoToken: 2.4,
    costVariants: {
      settingKey: "generate_audio",
      map: { true: { costUsdPerMVideoToken: 2.4 }, false: { costUsdPerMVideoToken: 1.2 } },
    },
    videoFps: 24,
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    mediaInputs: [MI_FIRST_FRAME, MI_LAST_FRAME],
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportedDurations: null,
    durationRange: { min: 4, max: 12 },
    settings: [
      mkAspectRatio(["16:9", "9:16", "1:1"]),
      mkDurationSlider(4, 12),
      {
        key: "resolution",
        label: "Разрешение видео",
        type: "select",
        options: [
          { value: "480p", label: "480p" },
          { value: "720p", label: "720p" },
          { value: "1080p", label: "1080p" },
        ],
        default: "720p",
      },
      { key: "generate_audio", label: "Генерировать аудио", type: "toggle", default: true },
    ],
  },
  // ── Seedance 2.0 / 2.0 Fast via KIE (бывший primary) ────────────────────────
  // Промоушен evolink в primary; KIE-реализация осталась как fallback.
  // Pricing KIE сохранён как был (matrix [resolution × generate_audio]).
  // KIE-адаптер уже умеет seedance-2 / seedance-2-fast (KieVideoAdapter
  // SEEDANCE_MODEL_MAP) — никаких adapter-changes не нужно.
  {
    id: "seedance-2",
    name: "Seedance 2.0 (kie fallback)",
    description: "Fallback на KIE при недоступности evolink.",
    section: "video",
    provider: "kie",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.125,
    costMatrix: {
      dims: ["resolution", "generate_audio"],
      table: {
        "480p__true": 0.0575,
        "480p__false": 0.095,
        "720p__true": 0.125,
        "720p__false": 0.205,
        "1080p__true": 0.31,
        "1080p__false": 0.51,
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    mediaInputs: [
      MI_SEEDANCE_FIRST_FRAME,
      MI_SEEDANCE_LAST_FRAME,
      MI_REF_IMAGES,
      MI_REF_VIDEOS,
      MI_REF_AUDIOS,
    ],
    modes: SEEDANCE_MODES,
    supportedAspectRatios: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    durationRange: { min: 4, max: 15 },
    settings: [
      mkAspectRatio(["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], { auto: "Авто" }),
      mkDurationSlider(4, 15),
      {
        key: "resolution",
        label: "Разрешение видео",
        type: "select",
        options: [
          { value: "480p", label: "480p" },
          { value: "720p", label: "720p" },
          { value: "1080p", label: "1080p" },
        ],
        default: "720p",
      },
      { key: "generate_audio", label: "Генерировать аудио", type: "toggle", default: true },
    ],
  },
  {
    id: "seedance-2-fast",
    name: "Seedance 2.0 Fast (kie fallback)",
    description: "Fallback на KIE при недоступности evolink.",
    section: "video",
    provider: "kie",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.1,
    costMatrix: {
      dims: ["resolution", "generate_audio"],
      table: {
        "480p__true": 0.045,
        "480p__false": 0.0775,
        "720p__true": 0.1,
        "720p__false": 0.165,
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    mediaInputs: [
      MI_SEEDANCE_FIRST_FRAME,
      MI_SEEDANCE_LAST_FRAME,
      MI_REF_IMAGES,
      MI_REF_VIDEOS,
      MI_REF_AUDIOS,
    ],
    modes: SEEDANCE_MODES,
    supportedAspectRatios: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    durationRange: { min: 4, max: 15 },
    settings: [
      mkAspectRatio(["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], { auto: "Авто" }),
      mkDurationSlider(4, 15),
      {
        key: "resolution",
        label: "Разрешение видео",
        type: "select",
        options: [
          { value: "480p", label: "480p" },
          { value: "720p", label: "720p" },
        ],
        default: "720p",
      },
      { key: "generate_audio", label: "Генерировать аудио", type: "toggle", default: true },
    ],
  },
  // ── Grok Imagine via FAL — fallback'и для двух разделённых primary моделей ──
  // Primary разделён на 2 модели:
  //   - `grok-imagine`     (KIE t2v, durationRange 6-15)  → FAL fallback t2v ниже
  //   - `grok-imagine-r2v` (KIE r2v, durationRange 6-10) → FAL fallback r2v ниже
  //
  // Pricing (общий для обоих endpoint'ов): 480p $0.05/s, 720p $0.07/s.
  // Per-image input fee $0.002 не учитываем (1-5% от total; biling при
  // fallback'е идёт по primary KIE цене всё равно).
  //
  // Prompt syntax: KIE использует @image1 (lowercase), FAL — @Image1.
  // FalVideoAdapter сам делает remap. Endpoint в адаптере выбирается по
  // modelId (если "*-r2v") или по наличию ref_images (для legacy).
  {
    id: "grok-imagine",
    name: "Grok Imagine t2v (fal fallback)",
    description: "Fallback на FAL text-to-video при недоступности KIE.",
    section: "video",
    provider: "fal",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.05, // base = 480p
    costVariants: {
      settingKey: "resolution",
      map: {
        "480p": { costUsdPerSecond: 0.05 },
        "720p": { costUsdPerSecond: 0.07 },
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    // Нет media слотов — isFallbackCompatible отвергнет этот fallback на запросах
    // с любыми media inputs (e.g. ref_images), направив их на r2v entry ниже.
    mediaInputs: [],
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["2:3", "3:2", "1:1", "16:9", "9:16"],
    // FAL t2v: 1-15s. Intersection с primary (6-30): 6..15.
    durationRange: { min: 6, max: 15 },
    settings: [
      mkAspectRatio(["16:9", "9:16", "1:1", "2:3", "3:2"]),
      mkDurationSlider(6, 15),
      {
        key: "resolution",
        label: "Разрешение видео",
        description: "480p — быстрее и дешевле, 720p — более чёткое видео.",
        type: "select",
        options: [
          { value: "480p", label: "480p" },
          { value: "720p", label: "720p" },
        ],
        default: "480p",
      },
    ],
  },
  {
    // Primary `grok-imagine-r2v` (KIE r2v) → fallback FAL r2v. Раньше id был
    // "grok-imagine" (когда primary был monolithic), после разделения primary
    // r2v живёт под `grok-imagine-r2v` — id fallback'а должен совпадать.
    id: "grok-imagine-r2v",
    name: "Grok Imagine r2v (fal fallback)",
    description: "Fallback на FAL reference-to-video при недоступности KIE.",
    section: "video",
    provider: "fal",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.05,
    costVariants: {
      settingKey: "resolution",
      map: {
        "480p": { costUsdPerSecond: 0.05 },
        "720p": { costUsdPerSecond: 0.07 },
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [
      {
        // required:true → t2v запросы (без ref_images) пропускают этот fallback.
        slotKey: "ref_images",
        mode: "reference_image",
        labelKey: "referenceImages",
        maxImages: 7,
        required: true,
      },
    ],
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["2:3", "3:2", "1:1", "16:9", "9:16"],
    durationRange: { min: 6, max: 10 },
    settings: [
      mkAspectRatio(["16:9", "9:16", "1:1", "2:3", "3:2"]),
      mkDurationSlider(6, 10),
      {
        key: "resolution",
        label: "Разрешение видео",
        description: "480p — быстрее и дешевле, 720p — более чёткое видео.",
        type: "select",
        options: [
          { value: "480p", label: "480p" },
          { value: "720p", label: "720p" },
        ],
        default: "480p",
      },
    ],
  },
  // ── Veo 3.1 (Quality) via Google Gemini API — fallback при недоступности KIE.
  // Те же media-input slot keys (first_frame/last_frame/reference) что у primary,
  // чтобы isFallbackCompatible не отсекал. Биллинг при fallback'е по primary
  // (KIE) цене — providerUsdCost из adapter'а игнорируется в effective !== primary.
  {
    id: "veo",
    name: "Veo 3.1 (google fallback)",
    description: "Fallback на прямую Google Gemini API при недоступности KIE.",
    section: "video",
    provider: "google",
    familyId: "veo",
    variantLabel: "Standard",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.4,
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [MI_FIRST_FRAME, MI_LAST_FRAME, MI_REFERENCE_VEO],
    modes: VEO_MODES,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16"],
    supportedDurations: [4, 6, 8],
    settings: VEO_GOOGLE_SETTINGS,
  },
  // ── Veo 3.1 Fast via Google Gemini API — fallback при недоступности evolink.
  {
    id: "veo-fast",
    name: "Veo 3.1 Fast (google fallback)",
    description: "Fallback на прямую Google Gemini API при недоступности evolink.",
    section: "video",
    provider: "google",
    familyId: "veo",
    variantLabel: "Fast",
    costUsdPerRequest: 0,
    costUsdPerSecond: 0.1,
    costVariants: {
      settingKey: "resolution",
      map: {
        "720p": { costUsdPerSecond: 0.1 },
        "1080p": { costUsdPerSecond: 0.12 },
        "4k": { costUsdPerSecond: 0.3 },
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [MI_FIRST_FRAME, MI_LAST_FRAME, MI_REFERENCE_VEO],
    modes: VEO_MODES,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16"],
    supportedDurations: [4, 6, 8],
    settings: VEO_GOOGLE_SETTINGS,
  },
  // ── Veo 3.1 Quality via KIE — последний fallback (после Google).
  // Биллинг при fallback'е по primary (evolink) цене, KIE свой costMatrix не
  // применяется. KIE Quality не поддерживает REFERENCE_2_VIDEO режим, поэтому
  // mediaInputs/modes урезаны (без MI_REFERENCE_VEO, без r2v mode). При
  // приходе sub-job'а с references фолбек скипнется через isFallbackCompatible.
  {
    id: "veo",
    name: "Veo 3.1 (kie fallback)",
    description: "Fallback на KIE при недоступности evolink и Google.",
    section: "video",
    provider: "kie",
    familyId: "veo",
    variantLabel: "Standard",
    costUsdPerRequest: 1.25,
    costUsdPerSecond: 0,
    costVariants: {
      settingKey: "resolution",
      map: {
        "720p": { costUsdPerRequest: 1.25 },
        "1080p": { costUsdPerRequest: 1.275 },
        "4k": { costUsdPerRequest: 1.85 },
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [MI_FIRST_FRAME, MI_LAST_FRAME],
    modes: VEO_MODES_KIE_QUALITY,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16"],
    supportedDurations: [8],
    settings: VEO_KIE_SETTINGS,
  },
  // ── Veo 3.1 Fast via KIE — последний fallback (после Google).
  {
    id: "veo-fast",
    name: "Veo 3.1 Fast (kie fallback)",
    description: "Fallback на KIE при недоступности evolink и Google.",
    section: "video",
    provider: "kie",
    familyId: "veo",
    variantLabel: "Fast",
    costUsdPerRequest: 0.3,
    costUsdPerSecond: 0,
    costVariants: {
      settingKey: "resolution",
      map: {
        "720p": { costUsdPerRequest: 0.3 },
        "1080p": { costUsdPerRequest: 0.325 },
        "4k": { costUsdPerRequest: 0.9 },
      },
    },
    inputCostUsdPerMToken: 0,
    outputCostUsdPerMToken: 0,
    supportsImages: true,
    mediaInputs: [MI_FIRST_FRAME, MI_LAST_FRAME, MI_REFERENCE_VEO],
    modes: VEO_MODES,
    supportsVoice: false,
    supportsWeb: false,
    isAsync: true,
    contextStrategy: "db_history",
    contextMaxMessages: 0,
    supportedAspectRatios: ["16:9", "9:16"],
    supportedDurations: [8],
    settings: VEO_KIE_SETTINGS,
  },
];
