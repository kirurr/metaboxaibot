import { db } from "../db.js";
import { getVideoQueue } from "../queues/video.queue.js";
import { AI_MODELS, ONE_SHOT_SETTING_KEYS } from "@metabox/shared";
import { checkBalance } from "./token.service.js";
import { costPreviewService } from "./cost-preview.service.js";
import { createVideoAdapter } from "../ai/video/factory.js";
import { validatePromptRefs } from "./prompt-ref.service.js";
import type {
  VideoInput,
  VideoValidationContext,
  VideoValidationError,
} from "../ai/video/base.adapter.js";

/** Drop one-shot upload fields (voice_*, talking_photo_id) from the history
 * snapshot so `inputData.modelSettings` stays clean of per-generation noise. */
function stripOneShotKeys(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (ONE_SHOT_SETTING_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface SubmitVideoParams {
  userId: bigint;
  modelId: string;
  prompt: string;
  imageUrl?: string;
  /** Named media input slots: { [slotKey]: string[] } */
  mediaInputs?: Record<string, string[]>;
  telegramChatId: number;
  /** Pre-translated label for the "Send as file" inline button. */
  sendOriginalLabel?: string;
  /** Aspect ratio chosen by user, e.g. "16:9". */
  aspectRatio?: string;
  /** Clip duration in seconds chosen by user. */
  duration?: number;
  /** One-shot overrides merged on top of saved modelSettings (e.g. driver_url from uploaded video). */
  extraModelSettings?: Record<string, unknown>;
  /** "{chatId}:{messageId}" of the inline button that triggered this job. Used for dedup. */
  sourceMessageId?: string;
  /** Telegram message_id of the user's prompt — worker replies to it when sending the result. */
  promptMessageId?: number;
}

export interface SubmitVideoResult {
  dbJobId: string;
  isPending: true;
}

export interface ValidateVideoParams {
  modelId: string;
  prompt: string;
  imageUrl?: string;
  aspectRatio?: string;
  duration?: number;
  modelSettings?: Record<string, unknown>;
  mediaInputs?: Record<string, string[]>;
  userId?: bigint;
}

export const videoGenerationService = {
  /**
   * Runs pre-generation checks before any API call is made:
   *   1. @-reference validation (prompt-ref.service): catches wrong element/image/video
   *      syntax and missing media slots immediately with a clear, localised message.
   *   2. Adapter-level checks (e.g. Veo image→8s, HeyGen avatar+voice, Runway requires image).
   * Returns a `VideoValidationError` when the request should be aborted, or `null` when
   * it can proceed. Safe to call before `submitVideo`.
   */
  validateVideoRequest(
    params: ValidateVideoParams,
    ctx?: VideoValidationContext,
  ): VideoValidationError | null {
    const model = AI_MODELS[params.modelId];
    const mediaInputs = params.mediaInputs ?? {};

    const refError = validatePromptRefs({
      prompt: params.prompt,
      mediaInputs,
      capabilities: model?.promptRefs,
    });
    if (refError) return refError;

    // Pre-flight hardcap: ловим заведомо слишком длинный промпт до enqueue +
    // submit'а в провайдер (e.g. xAI/Grok 4096). Без этого юзер ждёт round-trip
    // к провайдеру и получает generic «модель временно недоступна» вместо
    // конкретного «промпт длиннее N — сократите».
    //
    // Меряем UTF-8 byte length, а НЕ code points / .length:
    //  - xAI наблюдаемо отбивает русский промпт ~3500 chars как exceeding 4096,
    //    что соответствует ~7000 UTF-8 bytes (Cyrillic = 2 байта на символ).
    //    Code-point счёт (`[...prompt].length`) недосчитывал и пропускал такие
    //    кейсы на сабмит → 422 от провайдера, юзер видел generic-error.
    //  - Для ASCII-промптов поведение эквивалентно прежнему (1 char = 1 byte).
    //  - Для не-ASCII промптов проверка чуть строже — это безопасно: точная
    //    единица счёта у xAI задокументирована неточно, лучше консервативно
    //    отказать в нашем коде с понятным сообщением, чем словить рандомный 422.
    if (model?.maxPromptLength) {
      const byteLen = Buffer.byteLength(params.prompt, "utf8");
      if (byteLen > model.maxPromptLength) {
        // Юзеру показываем «символы», а не байты. Считаем реальный
        // bytes-per-char ratio для ЕГО промпта: 1.0 для ASCII, 2.0 для
        // кириллицы, 3-4 для эмодзи/китайского/etc. Отображаемый char-лимит =
        // byteLimit / ratio — точно сколько символов его языка влезет.
        //
        // Возвращаем существующий ключ `promptTooLong` (есть в обоих
        // i18n-namespace — `errors.*` и `video.*`), не вводим новый: исключаем
        // риск рассинхрона namespace'ов и crash'а в `applyValidationParams`.
        //
        // charLen ≥ 1 гарантированно: byteLen > maxPromptLength ≥ 1 → деление безопасно.
        const charLen = [...params.prompt].length;
        const bytesPerChar = byteLen / charLen;
        const charLimit = Math.floor(model.maxPromptLength / bytesPerChar);
        return { key: "promptTooLong", params: { limit: charLimit } };
      }
    }

    const adapter = createVideoAdapter(params.modelId);
    if (!adapter.validateRequest) return null;
    const input: VideoInput = {
      prompt: params.prompt,
      imageUrl: params.imageUrl,
      aspectRatio: params.aspectRatio,
      duration: params.duration,
      modelSettings: params.modelSettings,
      mediaInputs,
      userId: params.userId,
    };
    return adapter.validateRequest(input, ctx);
  },

  async submitVideo(params: SubmitVideoParams): Promise<SubmitVideoResult> {
    const { userId, modelId, prompt, imageUrl, telegramChatId, sendOriginalLabel } = params;

    const model = AI_MODELS[modelId];
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const preview = await costPreviewService.previewVideo(params);
    const modelSettings = preview.effectiveModelSettings;
    const effectiveAspectRatio = preview.effectiveAspectRatio;
    const effectiveDuration = preview.effectiveDuration;

    await checkBalance(userId, preview.cost);

    // Create DB job record
    const job = await db.generationJob.create({
      data: {
        userId,
        dialogId: "",
        section: "video",
        modelId,
        prompt,
        inputData: {
          ...(imageUrl ? { imageUrl } : {}),
          ...(params.mediaInputs ? { mediaInputs: params.mediaInputs } : {}),
          ...(() => {
            const historySettings = stripOneShotKeys(
              modelSettings as unknown as Record<string, unknown>,
            );
            return Object.keys(historySettings).length > 0
              ? { modelSettings: JSON.parse(JSON.stringify(historySettings)) }
              : {};
          })(),
        },
        status: "pending",
        ...(params.sourceMessageId ? { sourceMessageId: params.sourceMessageId } : {}),
      },
    });

    // All video models are async — enqueue for worker
    const queue = getVideoQueue();
    await queue.add(
      "generate",
      {
        dbJobId: job.id,
        userId: userId.toString(),
        modelId,
        prompt,
        imageUrl,
        mediaInputs: params.mediaInputs,
        telegramChatId,
        sendOriginalLabel,
        aspectRatio: effectiveAspectRatio,
        duration: effectiveDuration,
        modelSettings,
        ...(params.promptMessageId ? { promptMessageId: params.promptMessageId } : {}),
      },
      {
        jobId: job.id,
        removeOnComplete: true,
        attempts: 3,
        backoff: { type: "exponential", delay: 10000 },
      },
    );

    return { dbJobId: job.id, isPending: true };
  },
};
