export {
  chatService,
  DocumentNotSupportedError,
  DocumentExtractFailedError,
  ContextOverflowError,
} from "./chat.service.js";
export type { SendMessageParams, SendMessageResult } from "./chat.service.js";
export { dialogService } from "./dialog.service.js";
export type { CreateDialogParams, StoredAttachment } from "./dialog.service.js";
export { generationService } from "./generation.service.js";
export type { SubmitImageParams, SubmitImageResult } from "./generation.service.js";
export { userStateService } from "./user-state.service.js";
export { videoGenerationService } from "./video-generation.service.js";
export type { SubmitVideoParams, SubmitVideoResult } from "./video-generation.service.js";
export { audioGenerationService } from "./audio-generation.service.js";
export type { SubmitAudioParams, SubmitAudioResult } from "./audio-generation.service.js";
export { costPreviewService } from "./cost-preview.service.js";
export type {
  ImageCostPreview,
  VideoCostPreview,
  AudioCostPreview,
} from "./cost-preview.service.js";
export { pendingGenerationService } from "./pending-generation.service.js";
export type {
  PendingSection,
  UpsertPendingInput,
  UpsertPendingResult,
} from "./pending-generation.service.js";
export { paymentService, expireSubscription, grantMetaboxSubscription } from "./payment.service.js";
export type { SaleUserInfo } from "./payment.service.js";
export {
  deductTokens,
  refundTokens,
  checkBalance,
  checkSubscription,
  checkPaidSubscription,
  calculateCost,
  computeVideoTokens,
  usdToTokens,
} from "./token.service.js";
export type { DeductResult } from "./token.service.js";
export {
  s3Service,
  getFileUrl,
  uploadBuffer,
  objectExists,
  measureImageMegapixels,
  probeImageMetadata,
} from "./s3.service.js";
export type { ImageProbeInfo } from "./s3.service.js";
export {
  verifyLinkToken,
  issueSsoToken,
  registerFromBot,
  loginAndLink,
  recordSale,
  issueSsoTokenRemote,
  getAiBotProducts,
  createAiBotInvoice,
  lookupByTelegramId,
  getAiBotCatalog,
  createSubscriptionInvoice,
  resolveReferralCode,
  registerBotUser,
  confirmMerge,
  MetaboxApiError,
  getSubscriptionStatus,
  markTokensGrantedOnMetabox,
  getPendingTokenGrants,
  markOrderGrantedOnMetabox,
  getMetaboxUserStatus,
  resendMetaboxVerification,
  changeMetaboxEmailPending,
} from "./metabox-bridge.service.js";
export type {
  AiBotProduct,
  AiBotCatalog,
  CatalogSubscription,
  CatalogProduct,
  RecordSaleResult,
  MergedAccountInfo,
} from "./metabox-bridge.service.js";
export { getRate, calcStars, updateRate, STAR_PRICE_USD } from "./exchange-rate.service.js";
export { userUploadsService } from "./user-uploads.service.js";
export { userAvatarService } from "./user-avatar.service.js";
export { resolveVoiceForTTS } from "./user-voice.service.js";
export type { ResolvedVoice } from "./user-voice.service.js";
export { translatePromptIfNeeded, looksEnglish } from "./prompt-translate.service.js";
export { describeImageForPrompt } from "./image-describe.service.js";
export { mediaHintService } from "./media-hint.service.js";

// ── Web (ai.metabox.global) ─────────────────────────────────────────────
export { consumeLinkTelegramState, markLinkTelegramLinked } from "./web-session.service.js";

// ── Пул API-ключей с прокси и балансировкой ─────────────────────────────
export {
  acquireKey,
  acquireById,
  markRateLimited,
  recordSuccess,
  recordError,
  getKeyStats,
  invalidatePoolCache,
} from "./key-pool.service.js";
export type { AcquiredKey, ProxyConfig } from "./key-pool.service.js";
