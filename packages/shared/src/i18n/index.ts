import type { Language } from "../types/user.js";

export interface Translations {
  start: {
    welcome: string;
    tokensGranted: string;
    yourBalance: string;
    restart: string;
    videoIntro: string;
    mainMenuTitle: string;
    community: string;
    support: string;
    howToVideo_vk: string;
    howToVideo_yt: string;
    knowledgeBase: string;
    channel: string;
    metaboxLinked: string;
    metaboxLinkFailed: string;
    accountsMerged: string;
    selectLanguagePrompt: string;
    onboarding: string;
    onboardingGotIt: string;
  };
  menu: {
    profile: string;
    gpt: string;
    design: string;
    audio: string;
    video: string;
    storage: string;
    scenarios: string;
    help: string;
    knowledgeBase: string;
    language: string;
    chooseLanguage: string;
    languageChanged: string;
  };
  scenarios: {
    sectionTitle: string;
    sectionTooltip: string;
    chooseScenario: string;
    faceSwap: string;
    backToMain: string;
    faceSwapStep1: string;
    faceSwapStep2: string;
    faceSwapNotPhoto: string;
    faceSwapGenerating: string;
    faceSwapPhotoTooLarge: string;
    faceSwapAlbumNotice: string;
    faceSwapWelcome: string;
    clothingTryon: string;
    clothingTryonStep1: string;
    clothingTryonStep2: string;
    clothingTryonNotPhoto: string;
    clothingTryonGenerating: string;
    clothingTryonPhotoTooLarge: string;
    clothingTryonAlbumNotice: string;
    clothingTryonWelcome: string;
    backgroundRemoval: string;
    backgroundRemovalWelcome: string;
    backgroundRemovalStep: string;
    backgroundRemovalNotPhoto: string;
    backgroundRemovalPhotoTooLarge: string;
    backgroundRemovalGenerating: string;
    backgroundRemovalAlbumNotice: string;
    backgroundRemovalFileButton: string;
    photoUpscale: string;
    videoUpscale: string;
    photoUpscaleWelcome: string;
    videoUpscaleWelcome: string;
    photoUpscaleStep: string;
    videoUpscaleStep: string;
    upscaleChooseFactor: string;
    upscaleNotPhoto: string;
    upscaleNotVideo: string;
    upscalePhotoTooLarge: string;
    upscaleAlbumNotice: string;
    upscaleFileTooLarge: string;
    upscaleVideoUnreadable: string;
    upscaleGenerating: string;
    objectRemoval: string;
    objectRemovalWelcome: string;
    objectRemovalStepPhoto: string;
    objectRemovalStepPrompt: string;
    objectRemovalNotPhoto: string;
    objectRemovalPhotoTooLarge: string;
    objectRemovalAlbumNotice: string;
    objectRemovalPromptEmpty: string;
    objectRemovalPromptTooLong: string;
    objectRemovalBufferLost: string;
    objectRemovalGenerating: string;
    photoAnimate: string;
    photoAnimateWelcome: string;
    photoAnimateStepPhoto: string;
    photoAnimateNotPhoto: string;
    photoAnimatePhotoTooLarge: string;
    photoAnimateAlbumNotice: string;
    photoAnimateBufferLost: string;
    photoAnimateGenerating: string;
    copyMotion: string;
    copyMotionWelcome: string;
    copyMotionStepPhoto: string;
    copyMotionStepVideo: string;
    copyMotionNotPhoto: string;
    copyMotionNotVideo: string;
    copyMotionPhotoTooLarge: string;
    copyMotionVideoTooLarge: string;
    copyMotionVideoTooShort: string;
    copyMotionVideoTooLong: string;
    copyMotionVideoUnreadable: string;
    copyMotionAlbumNotice: string;
    copyMotionBufferLost: string;
    copyMotionGenerating: string;
    photoCreate: string;
    photoCreateWelcome: string;
    photoCreateStepPhoto: string;
    photoCreateStepPrompt: string;
    photoCreateStepAr: string;
    photoCreateStepRes: string;
    photoCreatePromptUpdated: string;
    photoCreateNotPhoto: string;
    photoCreatePhotoTooLarge: string;
    photoCreateAlbumNotice: string;
    photoCreatePromptEmpty: string;
    photoCreatePromptTooLong: string;
    photoCreateBufferLost: string;
    photoCreateGenerating: string;
    photoCreateAwaitArHint: string;
    photoCreateAwaitResHint: string;
    imageDecodeFailed: string;
  };
  gpt: {
    sectionTitle: string;
    activateEditor: string;
    management: string;
    newDialog: string;
    prompts: string;
    gptEditorActivated: string;
    newDialogCreated: string;
    photoDefaultPrompt: string;
    docDefaultPrompt: string;
    docUnsupportedType: string;
    docTooLarge: string;
    docModelNotSupported: string;
    docExtractFailed: string;
    docUploadFailed: string;
    contextOverflow: string;
    noActiveDialog: string;
    createDialog: string;
    backToMain: string;
    dialogSelected: string;
    dialogHint: {
      prompt: string;
      attach: string;
      thinkingWarning: string;
      filesWarning: string;
    };
    reasoningHeader: string;
    reasoningPartLabel: string;
    chunkDroppedTelegramLimit: string;
  };
  design: {
    sectionTitle: string;
    sectionTooltip: string;
    management: string;
    newDialog: string;
    backToMain: string;
    modelActivated: string;
    generating: string;
    asyncPending: string;
    generationFailed: string;
    photoSaved: string;
    photoAsReference: string;
    withReference: string;
    refSelected: string;
    refine: string;
    batchActions: string;
    batchActionsNoDownload: string;
    batchPartialFooter: string;
    batchAllFailed: string;
    batchSubJobFailedMessage: string;
    chooseModel: string;
  };
  audio: {
    sectionTitle: string;
    management: string;
    tts: string;
    ttsEl: string;
    ttsOpenai: string;
    ttsCartesia: string;
    voiceClone: string;
    music: string;
    musicEl: string;
    musicSuno: string;
    sounds: string;
    backToMain: string;
    ttsActivated: string;
    chooseTtsProvider: string;
    chooseMusicProvider: string;
    ttsElActivated: string;
    ttsCartesiaActivated: string;
    voiceCloneActivated: string;
    voiceCloneNeedsAudio: string;
    voiceCloneProcessing: string;
    voiceCloneSuccess: string;
    voiceCloneFailed: string;
    voiceCloneProviderUnavailable: string;
    musicActivated: string;
    musicElActivated: string;
    soundsActivated: string;
    activated: string;
    processing: string;
    asyncPending: string;
    generationFailed: string;
  };
  video: {
    sectionTitle: string;
    sectionTooltip: string;
    avatars: string;
    lipSync: string;
    newDialog: string;
    backToMain: string;
    modelActivated: string;
    queuing: string;
    asyncPending: string;
    generationFailed: string;
    management: string;
    avatarActivated: string;
    lipSyncActivated: string;
    videoPhotoSaved: string;
    videoDriverSaved: string;
    videoVoiceSaved: string;
    videoVoiceQueuing: string;
    elVoiceGenerating: string;
    elVoiceTtsExtraCharge: string;
    avatarPhotoSaved: string;
    myVoiceDefaultName: string;
    myAvatarDefaultName: string;
    hintHeygen: string;
    hintDid: string;
    hintHiggsfield: string;
    higgsfieldRequiresImage: string;
    runwayRequiresImage: string;
    heygenNeedsVoice: string;
    heygenNeedsAvatar: string;
    veoImageRequires8s: string;
    soulCreatePrompt: string;
    soulPhotoCount: string;
    soulCreateButton: string;
    soulCreating: string;
    soulReady: string;
    soulFailed: string;
    soulCancelled: string;
    soulCancelButton: string;
    soulMinPhotos: string;
    imageIgnoredUnsupported: string;
    extendButton: string;
    extendPrompt: string;
    extendActivated: string;
    extendNotAvailable: string;
    grokSiblingHintT2v: string;
    grokSiblingHintR2v: string;
    hintVideoTextOnly: string;
    hintVideoDefault: string;
    avatarCreationCancelled: string;
    avatarCreationStarted: string;
    avatarReady: string;
    avatarFailed: string;
  };
  errors: {
    noTool: string;
    noToolGpt: string;
    noToolDesign: string;
    noToolAudio: string;
    noToolVideo: string;
    unexpected: string;
    insufficientTokens: string;
    noSubscription: string;
    noSubscriptionForPurchase: string;
    userBlocked: string;
    /** Пользователь не зарегистрирован (нет в `users` БД) — должен запустить /start. */
    notRegistered: string;
    sendOriginalFailed: string;
    fileTooLargeForTelegram: string;
    fileTooLargeForBotApi: string;
    mediaSlotExpired: string;
    mediaSlotDurationTooShort: string;
    mediaSlotDurationTooLong: string;
    firstClipExceedsOutputDuration: string;
    mediaSlotDurationOutOfRange: string;
    mediaSlotFileTooLarge: string;
    mediaSlotImageTooSmall: string;
    mediaSlotImageTooLarge: string;
    mediaSlotAspectRatioOutOfRange: string;
    mediaSlotFramePixelsOutOfRange: string;
    mediaSlotReadMetadataFailed: string;
    promptTooLong: string;
    kieVideoDurationOutOfRange: string;
    kieImageTooSmall: string;
    kieImageAspectRatioOutOfRange: string;
    kieKlingMissingElement: string;
    ttsTranscriptEmpty: string;
    imageTooLarge: string;
    imageFormatUnsupported: string;
    imageDimensionOutOfRange: string;
    promptRequired: string;
    chatStreamInterrupted: string;
    mediaSlotImagesOnly: string;
    mediaSlotVideosOnly: string;
    mediaSlotAudiosOnly: string;
    contentPolicyViolation: string;
    copyrightViolation: string;
    publicFigureViolation: string;
    identityPreservationNotAllowed: string;
    midjourneySyntaxNotSupported: string;
    klingMotionImageRecognitionFailed: string;
    generationNoResult: string;
    modelDoesNotSupportImg2img: string;
    aiClassifiedError: string;
    recraftImg2imgSvgUnsupported: string;
    recraftImg2imgFileTooLarge: string;
    recraftImg2imgDimensionsTooLarge: string;
    recraftImg2imgResolutionTooLarge: string;
    providerInputRejected: string;
    gptImageModerationBlocked: string;
    audioSensitiveWord: string;
    audioGenerateFailed: string;
    audioCreateTaskFailed: string;
    generationTimeout: string;
    generationFailed: string;
    generationStillRunning: string;
    generationTimedOut24h: string;
    modelTemporarilyUnavailable: string;
    modelReasoningCapExhaustedOpenai: string;
    modelReasoningCapExhaustedAnthropic: string;
    outputLimitReached: string;
    outputLimitOnlyThinking: string;
    modelOnlyThinking: string;
    chatInvalidImage: string;
    upscaleResultTooLarge: string;
    soulProviderUnavailable: string;
    soulMissingAvatar: string;
    soulAvatarNotReady: string;
    avatarOrphaned: string;
    soulDescribingReference: string;
    soulDescribeFailed: string;
    // HeyGen
    heygenBlockedWords: string;
    heygenNsfw: string;
    heygenCelebrity: string;
    heygenChildSafety: string;
    heygenPolicyViolation: string;
    heygenNoFace: string;
    heygenMultipleFaces: string;
    heygenBadImageQuality: string;
    heygenInvalidText: string;
    heygenVideoFormat: string;
    heygenAudioFormat: string;
    heygenFileFormat: string;
    mediaSourceUnavailable: string;
    heygenVideoTooShort: string;
    heygenFileTooLong: string;
    heygenAudioTooLong: string;
    heygenAudioLengthMismatch: string;
    heygenAvatarNotFound: string;
    heygenVoiceNotFound: string;
    heygenVoicePremium: string;
    heygenTtsLanguage: string;
    heygenTrialLimit: string;
    heygenAvatarPermission: string;
    heygenUserBlocked: string;
    heygenTierRequired: string;
    heygenRejected: string;
    // Luma
    lumaBlacklistedWords: string;
    lumaImageModeration: string;
    lumaPromptModeration: string;
    lumaImageLoadError: string;
    lumaPromptRequired: string;
    lumaPromptTooShort: string;
    lumaPromptTooLong: string;
    lumaLoopUnsupported: string;
    lumaNoKeyframes: string;
    lumaUnknownRequestType: string;
    lumaIntellectualProperty: string;
    lumaRejected: string;
    // MiniMax
    minimaxSensitiveContent: string;
    minimaxInvalidChars: string;
    minimaxInvalidParams: string;
    minimaxUsageLimit: string;
    minimaxRejected: string;
    // Runway
    runwayModeration: string;
    runwayInvalidAsset: string;
    runwayRejected: string;
    // Replicate
    replicateOom: string;
    replicateInvalidParams: string;
    replicateFileTooLarge: string;
    replicateContentPolicy: string;
    loraUrlInvalid: string;
    promptNotEnglish: string;
    modelDoesNotSupportImages: string;
    // Fal
    falContentPolicy: string;
    falNoMediaGenerated: string;
    falImageTooSmall: string;
    falImageTooLarge: string;
    falImageLoadError: string;
    falFileDownloadError: string;
    falFaceDetectionError: string;
    falFileTooLarge: string;
    falFileTooLargeLimit: string;
    falAudioTooLong: string;
    falAudioTooShort: string;
    falVideoTooLong: string;
    falVideoTooShort: string;
    falUnsupportedFormat: string;
    falUnsupportedFormatList: string;
    falInvalidArchive: string;
    falInvalidArchiveExts: string;
    falArchiveTooFew: string;
    falArchiveTooFewExts: string;
    falArchiveTooMany: string;
    falFeatureNotSupported: string;
    falOneOf: string;
    falOneOfField: string;
    falStringTooShort: string;
    falStringTooShortField: string;
    falStringTooLong: string;
    falStringTooLongField: string;
    // ElevenLabs
    elevenlabsPromptTooLong: string;
    // Suno
    sunoPromptTooLong: string;
    sunoPromptTooLongNoLyrics: string;
    // Higgsfield
    higgsfieldTooManyMotions: string;
    alreadyGenerating: string;
  };
  common: {
    backToMain: string;
    profile: string;
    knowledgeBase: string;
    management: string;
    newDialog: string;
    comingSoon: string;
    tokens: string;
    sendOriginal: string;
    downloadFile: string;
    generationCostLine: string;
    generationNoPrompt: string;
    generationAudioPrompt: string;
    tariffs: string;
    costPerRequest: string;
    costRangePerRequest: string;
    costPerMPixel: string;
    costPerSecond: string;
    costRangePerSecond: string;
    costPerKChar: string;
    costRangePerKChar: string;
  };
  payments: {
    success: string;
    error: string;
  };
  voice: {
    transcribing: string;
    transcriptionResult: string;
    transcriptionHint: string;
    useAsPrompt: string;
    expired: string;
    failed: string;
    inputHint: string;
    avatarChoiceUseAudio: string;
    avatarChoiceTranscribe: string;
  };
  mediaInput: {
    firstFrame: string;
    lastFrame: string;
    reference: string;
    edit: string;
    styleReference: string;
    multiple_edit: string;
    refElement1: string;
    refElement2: string;
    refElement3: string;
    refElement4: string;
    refElement5: string;
    refElementHint: string;
    referenceImages: string;
    referenceVideos: string;
    referenceAudios: string;
    sourceVideo: string;
    referenceImagesHint: string;
    referenceVideosHint: string;
    referenceAudiosHint: string;
    drivingAudio: string;
    firstClip: string;
    avatarPhoto: string;
    voiceAudio: string;
    firstFrameWanHint: string;
    lastFrameWanHint: string;
    drivingAudioHint: string;
    firstClipHint: string;
    motionImage: string;
    motionVideo: string;
    motionElement: string;
    motionImageSlotHint: string;
    motionVideoSlotHint: string;
    motionElementHint: string;
    uploadPromptVideo: string;
    uploadPrompt: string;
    uploadPromptMulti: string;
    uploadPromptElement: string;
    uploadPromptDesignEdit: string;
    uploadPromptDesignRef: string;
    uploadPromptDesignMulti: string;
    uploadPromptDesignStyleRef: string;
    uploadPromptVideoFirstFrame: string;
    uploadPromptVideoLastFrame: string;
    uploadPromptVideoMotionImage: string;
    uploadPromptVideoDrivingAudio: string;
    uploadPromptVideoMotionVideo: string;
    uploadPromptVideoFirstClip: string;
    uploadPromptVideoRefImages: string;
    uploadPromptVideoRefVideos: string;
    uploadPromptVideoRefAudios: string;
    imageSaved: string;
    imageSavedSingle: string;
    klingHeavyCropWarning: string;
    tooManyMediaSingleSlot: string;
    tooManyMediaMultiSlot: string;
    slotRequired: string;
    replace: string;
    remove: string;
    optional: string;
    required: string;
    referencesNotLoaded: string;
    doneUploading: string;
    readyForPrompt: string;
    readyForPromptOptional: string;
    startGeneration: string;
    cancel: string;
    uploadCancelled: string;
    refineUseActive: string;
    refineActiveLabel: string;
    refineChooseModel: string;
    refineNoSupport: string;
    refineChooseSlot: string;
    refineDesign: string;
    refineVideo: string;
    refineSaved: string;
    refineReadyForPrompt: string;
    refinePickSection: string;
    refineSlotConflict: string;
    refineSlotConflictFull: string;
    refineReplaceBtn: string;
    refineAddBtn: string;
  };
  confirmGeneration: {
    message: string;
    messagePerSecond: string;
    voicePrompt: string;
    start: string;
    cancel: string;
    cancelled: string;
    cancelledWithFiles: string;
    expired: string;
    replaced: string;
    mediaPreviewPhotoSingle: string;
    mediaPreviewPhotoMulti: string;
    mediaPreviewVideoSingle: string;
    mediaPreviewVideoMulti: string;
    mediaPreviewAudioSingle: string;
    mediaPreviewAudioMulti: string;
    mediaPreviewFileSingle: string;
    mediaPreviewFileMulti: string;
    mediaPreviewMixedPhoto: string;
    mediaPreviewMixedVideo: string;
    mediaPreviewMixedAudio: string;
    mediaFileNounOne: string;
    mediaFileNounFew: string;
    mediaFileNounMany: string;
  };
  modelModes: {
    pickerTitle: string;
    pickModeFirstForMedia: string;
    activated: string;
    activatedTextOnly: string;
    change: string;
    t2v: string;
    t2i: string;
    i2v: string;
    i2i: string;
    r2v: string;
    r2i: string;
    clipExtend: string;
  };
  linkMetabox: {
    title: string;
    subtitle: string;
    newAccount: string;
    existingAccount: string;
    registerHint: string;
    loginHint: string;
    password: string;
    submit: string;
    error: string;
  };
  accountDelete: {
    /** Шлётся юзеру в чат после нажатия "Подтвердить" в mini-app. Содержит `{code}`. */
    codeMessage: string;
    cancelButton: string;
    /** Сообщение когда пользователь ввёл правильный код — переходим к финальному confirm. */
    codeAccepted: string;
    finalConfirmButton: string;
    finalCancelButton: string;
    /** Юзер ввёл неверный код — показываем сколько осталось попыток. Содержит `{left}`. */
    codeWrong: string;
    codeExpired: string;
    tooManyAttempts: string;
    cancelled: string;
    /** Финальное сообщение после успешного удаления. */
    success: string;
    /** Если на финальном confirm нет verified-флага в Redis (юзер не вводил код). */
    needCodeFirst: string;
  };
  /**
   * Шутливые вариации текста "модель временно недоступна" для random-pick'а.
   * Содержат `{modelName}` и (опционально) `{alternatives}` — последний раскрывается
   * из `generationFailedAlternatives[section]`. Лежит на верхнем уровне (а не в
   * `errors`) чтобы не ломать `Record<string, string>` в `resolveUserFacingError`
   * и провайдер-error helper'ах.
   */
  generationFailedVariants: string[];
  generationFailedAlternatives: {
    gpt: string;
    design: string;
    video: string;
    audio: string;
  };
}

const cache = new Map<Language, Translations>();

async function loadLocale(lang: Language): Promise<Translations> {
  const mod = await import(`./locales/${lang}.js`);
  return mod.default as Translations;
}

/**
 * Загружает переводы при старте приложения.
 * Языки без перевода автоматически используют английский как fallback.
 */
export async function preloadLocales(languages: Language[]): Promise<void> {
  await Promise.all(
    languages.map(async (lang) => {
      try {
        cache.set(lang, await loadLocale(lang));
      } catch {
        // Нет файла перевода — будет использован fallback на en
      }
    }),
  );
}

/**
 * Синхронно возвращает перевод для указанного языка.
 * Требует предварительного вызова preloadLocales().
 */
export function getT(lang: Language): Translations {
  return cache.get(lang) ?? (cache.get("en") as Translations);
}

/**
 * Rounds a token amount to at most 3 decimals and strips trailing zeros:
 *   0.0255 → "0.03", 0.02 → "0.02", 8 → "8".
 */
function formatTokens(n: number): string {
  return String(parseFloat(n.toFixed(2)));
}

/**
 * Возвращает standalone строку «💸 Списано: X ✦\n💳 Баланс: Y ✦» по тому же
 * шаблону `t.common.generationCostLine`, что и cost-блок в caption'ах
 * image/video результатов. Используется когда нужно показать списание
 * отдельным сообщением (например, после ответа LLM в чате — там caption'а нет).
 */
export function formatGenerationCostLine(
  t: Translations,
  cost: number,
  subscriptionBalance: number,
  tokenBalance: number,
): string {
  const total = subscriptionBalance + tokenBalance;
  return t.common.generationCostLine
    .replace("{cost}", formatTokens(cost))
    .replace("{total}", formatTokens(total));
}

/**
 * Telegram caption limit (sendPhoto / sendVideo / sendDocument / sendAudio /
 * media group items). Считается ПО РЕНДЕР-длине после parse_mode: HTML — теги
 * `<blockquote>` и `<b>` не учитываются, видимый текст да.
 */
const TELEGRAM_CAPTION_MAX = 1024;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Builds the standard caption shown with a generation result:
 *   ✅ <b>{modelName}</b>{suffix}
 *   <blockquote expandable>{full prompt}</blockquote>
 *
 *   💸 Spent: {cost} ✦
 *   💳 Balance: {total} ✦
 *
 * Промпт идёт целиком в `<blockquote expandable>` — по умолчанию свёрнут, юзер
 * раскрывает тапом. При длинном промпте обрезаем по бюджету Telegram-caption'а
 * (1024 рендер-символов минус header + cost line).
 *
 * **ВАЖНО:** caller должен слать сообщение с `parse_mode: "HTML"`.
 *
 * `cost`/`sub`/`regular` may be undefined when deduction context is unavailable
 * (e.g. crash recovery) — the cost block is then omitted.
 */
import type { UserFacingError } from "../errors.js";
import { resolveUserFacingError } from "../errors.js";

/** Секции, для которых поддерживается random-вариация generationFailed-текста. */
export type GenerationFailedSection = "gpt" | "design" | "video" | "audio";

/**
 * Возвращает случайно выбранный шутливый текст «модель временно недоступна».
 * Под каждый рендер дёргает random — последовательные показы юзеру одной и
 * той же ошибки могут быть разными. Вариант с `{alternatives}` подставляет
 * специфичный для секции список альтернативных моделей.
 *
 * Используется processor'ами (video/image/audio) на терминальной ошибке,
 * `pool exhausted`-ветке и chat.service'ом через UserFacingError → bot scene.
 *
 * Fallback на legacy одиночный `generationFailed` текст, если по какой-то
 * причине variants-массив пуст (защита от частичных переводов).
 */
export function pickGenerationFailedMessage(
  t: Translations,
  modelName: string,
  section: GenerationFailedSection,
): string {
  const variants = t.generationFailedVariants;
  if (!Array.isArray(variants) || variants.length === 0) {
    return t.errors.generationFailed.replace("{modelName}", modelName);
  }
  const idx = Math.floor(Math.random() * variants.length);
  const template = variants[idx]!;
  const alternatives = t.generationFailedAlternatives[section];
  return template.replace("{modelName}", modelName).replace("{alternatives}", alternatives);
}

/**
 * Wrapper над `resolveUserFacingError` с поддержкой random-вариантов.
 *
 * Для UserFacingError с `key: "modelTemporarilyUnavailable"` и проставленным
 * `section` — выбирает случайный вариант из `generationFailedVariants` через
 * `pickGenerationFailedMessage` (даёт юзеру разные шутливые тексты на повторных
 * показах). Для всех остальных ошибок — стандартное поведение
 * `resolveUserFacingError` (lookup по key + interpolate params).
 */
export function resolveUserFacingErrorVariant(err: UserFacingError, t: Translations): string {
  if (err.key === "modelTemporarilyUnavailable" && err.section) {
    const modelName = String(err.params?.modelName ?? err.section);
    return pickGenerationFailedMessage(t, modelName, err.section);
  }
  return resolveUserFacingError(err, t.errors);
}

export function buildResultCaption(
  t: Translations,
  displayName: string,
  prompt: string,
  opts?: {
    cost?: number;
    subscriptionBalance?: number;
    tokenBalance?: number;
    suffix?: string;
    /** Игнорируется (legacy parameter — раньше задавал точку обрезки). */
    maxPromptLen?: number;
    emptyPromptLabel?: string;
  },
): string {
  const hasPrompt = !!prompt && prompt.trim().length > 0;
  const safeName = escapeHtml(displayName);
  const safeSuffix = opts?.suffix ? ` ${escapeHtml(opts.suffix)}` : "";

  // Cost block считаем заранее — размер фиксированный, нужен для бюджета промпта.
  let costBlock = "";
  const cost = opts?.cost;
  const sub = opts?.subscriptionBalance;
  const reg = opts?.tokenBalance;
  if (cost !== undefined && sub !== undefined && reg !== undefined) {
    const total = sub + reg;
    const line = t.common.generationCostLine
      .replace("{cost}", formatTokens(cost))
      .replace("{total}", formatTokens(total));
    costBlock = `\n\n${line}`;
  }

  if (!hasPrompt) {
    const empty = opts?.emptyPromptLabel ?? "";
    if (!empty) return `✅ <b>${safeName}</b>${safeSuffix}${costBlock}`;
    return `✅ <b>${safeName}</b>: ${escapeHtml(empty)}${safeSuffix}${costBlock}`;
  }

  // Header без промпта; промпт идёт отдельной строкой в <blockquote expandable>.
  const header = `✅ <b>${safeName}</b>${safeSuffix}\n`;

  // Бюджет рендер-символов для промпта = TELEGRAM_CAPTION_MAX − header − cost
  // − safety. Header/cost содержат HTML-теги (<b>), но они НЕ учитываются
  // Telegram'ом — для расчёта оцениваем рендер-длину (без тегов).
  const headerRenderLen = header.replace(/<\/?b>/g, "").length;
  const costRenderLen = costBlock.length; // costBlock без HTML-тегов
  const safety = 16;
  const promptBudget = TELEGRAM_CAPTION_MAX - headerRenderLen - costRenderLen - safety;

  let promptToShow = prompt;
  if (promptToShow.length > promptBudget) {
    promptToShow = promptToShow.slice(0, Math.max(0, promptBudget - 3)) + "...";
  }
  const safePrompt = escapeHtml(promptToShow);

  return `${header}<blockquote expandable>${safePrompt}</blockquote>${costBlock}`;
}

/**
 * Builds a capability hint for a GPT dialog based on the model's features.
 * Used both in the mini-app activation route and the bot's new-dialog flow.
 */
export function buildDialogHint(
  t: Translations,
  model:
    | {
        supportsThinking?: boolean;
      }
    | undefined,
): string {
  if (!model) return "";

  const lines: string[] = [t.gpt.dialogHint.prompt, t.gpt.dialogHint.attach];

  if (model.supportsThinking) {
    lines.push(t.gpt.dialogHint.thinkingWarning);
  }

  lines.push(t.gpt.dialogHint.filesWarning);

  return lines.join("\n");
}
