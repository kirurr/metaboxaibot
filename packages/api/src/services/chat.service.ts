import { createLLMAdapter } from "../ai/llm/factory.js";
import {
  dialogService,
  readOpenAIFileIds,
  OPENAI_ENV_KEY,
  type StoredAttachment,
} from "./dialog.service.js";
import {
  calculateCost,
  calculateProviderCostUsd,
  checkBalance,
  deductTokens,
} from "./token.service.js";
import { estimateTokens as estimateStringTokens } from "./token-estimator.js";
import { downloadBuffer } from "./s3.service.js";
import {
  uploadFileToOpenAI,
  deleteFileFromOpenAI,
  isOpenAIFileSupportedMime,
} from "../ai/llm/openai-files.js";
import { buildProxyFetch } from "../ai/transport/proxy-fetch.js";
import { acquireById } from "./key-pool.service.js";
import type { Prisma } from "@prisma/client";
import { db } from "../db.js";
import type { LLMInput, MessageAttachment } from "../ai/llm/base.adapter.js";
import { AI_MODELS, UserFacingError, getFallbackCandidates } from "@metabox/shared";
import type { AIModel } from "@metabox/shared";
import { userStateService } from "./user-state.service.js";
import { getFileUrl } from "./s3.service.js";
import {
  extractPdfTextFromS3,
  extractTextFromS3Cached,
  buildDocumentPromptBlock,
  isTextClassMime,
} from "./document-extract.service.js";
import type { MessageRecord } from "../ai/llm/base.adapter.js";
import { ContextOverflowError, isContextOverflowError } from "../ai/llm/truncate.js";
import { logger } from "../logger.js";
import {
  acquireKey,
  markRateLimited,
  recordSuccess,
  recordError,
  type AcquiredKey,
} from "./key-pool.service.js";
import { isPoolExhaustedError } from "../utils/pool-exhausted-error.js";
import { resolveKeyProvider, resolveKeyProviderForModel } from "../ai/key-provider.js";
import {
  classifyRateLimit,
  isFiveXxError,
  isInvalidImageError,
  isTransientNetworkError,
} from "../utils/rate-limit-error.js";

export { ContextOverflowError } from "../ai/llm/truncate.js";

/**
 * Per-request memoiser for `extractTextFromS3Cached` calls. Eliminates the
 * N+1 pattern when the same s3Key appears in multiple history messages
 * (e.g. a CSV re-attached every turn). Lives only for the duration of one
 * `sendMessageStream` invocation.
 */
type ExtractCache = Map<string, Promise<string | null>>;

function getOrExtract(
  cache: ExtractCache,
  s3Key: string,
  mimeType: string,
  name: string,
): Promise<string | null> {
  let p = cache.get(s3Key);
  if (!p) {
    p = extractTextFromS3Cached(s3Key, mimeType, name);
    cache.set(s3Key, p);
  }
  return p;
}

export class DocumentNotSupportedError extends Error {
  constructor() {
    super("Model does not support document inputs");
    this.name = "DocumentNotSupportedError";
  }
}

export class DocumentExtractFailedError extends Error {
  constructor(public readonly fileName: string) {
    super(`Failed to extract text from document: ${fileName}`);
    this.name = "DocumentExtractFailedError";
  }
}

export interface SendMessageParams {
  dialogId: string;
  userId: bigint;
  content: string;
  imageUrl?: string;
  imageUrls?: string[];
  /** S3 keys for user-uploaded images (parallel array to imageUrls). Stored in the message record. */
  imageS3Keys?: string[];
  /** Document attachments (PDFs etc.) for the current user turn. */
  documentAttachments?: StoredAttachment[];
}

export interface SendMessageResult {
  text: string;
  tokensUsed: number;
}

export const chatService = {
  /**
   * Streams the assistant response chunk-by-chunk.
   * Saves both messages to DB and deducts tokens from the user balance.
   * The caller accumulates chunks for display; the final result is returned
   * as the generator's return value via the done object.
   */
  async *sendMessageStream(
    params: SendMessageParams,
  ): AsyncGenerator<string, SendMessageResult, unknown> {
    const { dialogId, userId, content, imageUrl, imageUrls, imageS3Keys, documentAttachments } =
      params;

    const dialog = await dialogService.findById(dialogId);
    if (!dialog) throw new Error(`Dialog ${dialogId} not found`);

    const model = AI_MODELS[dialog.modelId];
    // keyProvider mutable — переключается на fallback'а при исчерпании primary'а
    // на 5xx/network. attemptedProviders отслеживает уже опробованные провайдеры
    // (по полю `model.provider`, не по `keyProvider` — у двух разных провайдеров
    // может быть один key-pool через resolveKeyProvider).
    let keyProvider = resolveKeyProvider(dialog.modelId);
    const attemptedProviders = new Set<string>();
    if (model?.provider) attemptedProviders.add(model.provider);
    // activeAdapterModel хранит модель, использованную для создания текущего
    // adapter'а — primary string'ом или fallback AIModel'ом. На key-rotation
    // нужен этот же модель (а не lookup по id), иначе после fallback-switch
    // следующая key-rotation создала бы primary-адаптер вместо fallback.
    let activeAdapterModel: string | AIModel = dialog.modelId;

    // Acquire a key from the pool before any work. Если primary pool исчерпан
    // на старте (все ключи в cooldown) — пробуем fallback-провайдеров перед тем
    // как сдаваться. Mirror'ит поведение image processor'а на submit-stage.
    let acquired: AcquiredKey;
    try {
      acquired = await acquireKey(keyProvider);
    } catch (err) {
      if (!isPoolExhaustedError(err)) throw err;

      let initFallbackAcquired: AcquiredKey | null = null;
      for (const candidate of getFallbackCandidates(dialog.modelId, "llm")) {
        if (attemptedProviders.has(candidate.provider)) continue;
        const candidateKeyProvider = resolveKeyProviderForModel(candidate);
        try {
          initFallbackAcquired = await acquireKey(candidateKeyProvider);
        } catch (poolErr) {
          if (isPoolExhaustedError(poolErr)) continue;
          throw poolErr;
        }
        logger.warn(
          {
            dialogId,
            modelId: dialog.modelId,
            fromProvider: model?.provider,
            toProvider: candidate.provider,
            reason: "pool_exhausted_at_init",
          },
          "chat.sendMessageStream: primary pool exhausted at init — using fallback provider",
        );
        keyProvider = candidateKeyProvider;
        activeAdapterModel = candidate;
        attemptedProviders.add(candidate.provider);
        break;
      }

      if (!initFallbackAcquired) {
        throw new UserFacingError(`Pool exhausted for ${keyProvider}`, {
          key: "modelTemporarilyUnavailable",
          section: "gpt",
          params: { modelName: model?.name ?? dialog.modelId },
        });
      }
      acquired = initFallbackAcquired;
    }
    // Mutable: на retry с другим ключом (rate-limit / 5xx до первого chunk'а)
    // переприсваиваем acquired/keyId/adapter и шлём запрос заново. На fallback'е
    // (другой провайдер) переприсваиваем дополнительно keyProvider + adapter
    // через AIModel-объект из FALLBACK_LLM_MODELS.
    let acquiredKeyId = acquired.keyId;
    let adapter = createLLMAdapter(activeAdapterModel, acquired);

    // Split attachments into two classes:
    //  - text-class (.txt, .csv, .docx, .xlsx, etc.) — always extracted + inlined.
    //  - native-class (.pdf) — native content blocks for supporting models,
    //    extract+inline fallback otherwise.
    const allDocs = documentAttachments ?? [];
    const textClassDocs = allDocs.filter((d) => isTextClassMime(d.mimeType));
    const nativeClassDocs = allDocs.filter((d) => d.mimeType === "application/pdf");

    // Gate: native-class PDFs on a model with neither flag — reject before any DB writes.
    // Text-class documents are always accepted (they work on any model via inline extract).
    if (
      nativeClassDocs.length > 0 &&
      model &&
      !model.supportsDocuments &&
      !model.documentTextExtractFallback
    ) {
      throw new DocumentNotSupportedError();
    }

    const ms = await userStateService.getEffectiveDialogSettings(userId, dialogId, dialog.modelId);

    // `getEffectiveDialogSettings` возвращает только то что юзер явно сохранил
    // — модельные `default`'ы из `AI_MODELS[id].settings[]` остаются хинтом для
    // UI и до сервера не доезжают. Для ключей где это критично (reasoning_effort
    // на gpt-5-nano: без явного `low` OpenAI применяет свой `medium`, который
    // на узком max_output_tokens вызывает пустые ответы) подмешиваем default
    // здесь. Юзер сохранивший своё значение не пострадает — оно уже в `ms`.
    if (ms.reasoning_effort === undefined && model?.settings) {
      const def = model.settings.find((s) => s.key === "reasoning_effort")?.default;
      if (def !== undefined) ms.reasoning_effort = def;
    }

    const extractCache: ExtractCache = new Map();

    // Check balance > 0 cause we dont know how much outputTokens will be generated
    await checkBalance(userId, 0);

    // Build effectivePrompt by inlining any text-class docs, plus native PDFs
    // for text-extract fallback models. Original `content` stays untouched in DB.
    const inlineBlocks: string[] = [];
    for (const doc of textClassDocs) {
      const text = await getOrExtract(extractCache, doc.s3Key, doc.mimeType, doc.name);
      if (text === null) throw new DocumentExtractFailedError(doc.name);
      inlineBlocks.push(buildDocumentPromptBlock(doc.name, text));
    }
    if (nativeClassDocs.length > 0 && model?.documentTextExtractFallback) {
      for (const doc of nativeClassDocs) {
        const text = await extractPdfTextFromS3(doc.s3Key);
        if (text === null) throw new DocumentExtractFailedError(doc.name);
        inlineBlocks.push(buildDocumentPromptBlock(doc.name, text));
      }
    }
    const effectivePrompt = inlineBlocks.length
      ? `${inlineBlocks.join("\n\n")}\n\n${content}`
      : content;

    // For native-document models, presign URLs for PDF attachments right before the call.
    // Text-class docs are never passed to the adapter — they live in effectivePrompt.
    let currentDocAttachments: MessageAttachment[] | undefined;
    if (nativeClassDocs.length > 0 && model?.supportsDocuments) {
      currentDocAttachments = await Promise.all(
        nativeClassDocs.map(async (d) => ({
          ...d,
          url: (await getFileUrl(d.s3Key)) ?? undefined,
        })),
      );
    }

    // Build input based on context strategy. `let` because retry-on-fallback-key
    // path может пересобрать его (drop previousResponseId + наполнить history).
    let input: LLMInput = {
      prompt: effectivePrompt,
      imageUrl,
      ...(imageUrls?.length ? { imageUrls } : {}),
      ...(currentDocAttachments?.length ? { documentAttachments: currentDocAttachments } : {}),
      ...(ms.temperature !== undefined ? { temperature: ms.temperature as number } : {}),
      ...(ms.max_tokens !== undefined ? { maxTokens: ms.max_tokens as number } : {}),
      ...(ms.system_prompt ? { systemPrompt: ms.system_prompt as string } : {}),
      ...(ms.search_recency_filter
        ? { searchRecencyFilter: ms.search_recency_filter as string }
        : {}),
      ...(ms.search_context_size ? { searchContextSize: ms.search_context_size as string } : {}),
      ...(ms.search_domain_filter ? { searchDomainFilter: ms.search_domain_filter as string } : {}),
      ...(ms.reasoning_effort ? { reasoningEffort: ms.reasoning_effort as string } : {}),
      ...(ms.verbosity ? { verbosity: ms.verbosity as string } : {}),
      ...(ms.extended_thinking !== undefined
        ? { extendedThinking: ms.extended_thinking as boolean }
        : {}),
      ...(ms.enable_thinking !== undefined
        ? { enableThinking: ms.enable_thinking as boolean }
        : {}),
      ...(ms.thinking_budget !== undefined ? { thinkingBudget: ms.thinking_budget as number } : {}),
      ...(ms.show_reasoning !== undefined ? { showReasoning: ms.show_reasoning as boolean } : {}),
      ...(ms.seed != null ? { seed: ms.seed as number } : {}),
      ...(ms.context_window != null ? { contextWindowOverride: ms.context_window as number } : {}),
    };

    // Версия attachments которая попадёт в DB при saveMessage. Для provider_chain
    // переписывается на uploaded-версию (с openaiFileIds) — иначе следующий turn
    // re-uploadнет тот же файл (DB не помнит что мы загрузили).
    let attachmentsToSave: StoredAttachment[] | undefined = documentAttachments;

    if (dialog.contextStrategy === "db_history") {
      const history = await dialogService.getHistory(dialogId, adapter.contextMaxMessages);
      // For every historical message: re-inline text-class attachments by reading
      // them from S3 on each turn (mirrors how claude.ai re-sends extracted text).
      // Additionally, for native-doc models, presign URLs for PDF attachments so
      // the adapter can rebuild document content blocks for prior turns.
      input.history = await Promise.all(
        history.map((m) =>
          augmentHistoryMessage(m, model?.supportsDocuments === true, extractCache),
        ),
      );
    } else if (dialog.contextStrategy === "provider_chain") {
      // Lazy-upload current + history attachments в OpenAI Files API чтобы
      // в input'е использовать file_id вместо file_url. Без этого OpenAI
      // кэшит file_url на стороне previous_response_id и через 1ч (TTL S3
      // presigned URL) re-fetch ломается с 403.
      const filesResult = await ensureOpenAIFiles({
        dialogId,
        currentAttachments: currentDocAttachments,
        apiKey: acquired.apiKey,
        keyId: acquired.keyId,
        proxy: acquired.proxy,
      });
      // Replace current-turn attachments — резолвим openaiFileId из
      // openaiFileIds[currentKey] для адаптера. ВАЖНО: сохраняем url для
      // fallback'а (если upload в OpenAI не прошёл, адаптер всё равно
      // отправит file_url — presigned URL валиден ~1ч, в рамках этого turn'а
      // успеем).
      if (filesResult.currentAttachments && currentDocAttachments) {
        const currentKeyKey = acquired.keyId ?? OPENAI_ENV_KEY;
        input.documentAttachments = filesResult.currentAttachments.map((att, i) => {
          const fileMap = readOpenAIFileIds(att);
          const resolvedFileId = fileMap[currentKeyKey];
          const original = currentDocAttachments![i];
          return {
            s3Key: att.s3Key,
            mimeType: att.mimeType,
            name: att.name,
            size: att.size,
            url: original?.url, // presigned fallback
            openaiFileId: resolvedFileId,
            openaiKeyId: resolvedFileId ? acquired.keyId : undefined,
          };
        });
        // Save в DB uploaded-версию (с openaiFileIds map). Без этого следующий
        // turn'ов ensureOpenAIFiles увидит attachment без fileMap и сделает
        // повторный upload → дубликаты в OpenAI storage.
        attachmentsToSave = filesResult.currentAttachments;
      }

      // Привязка response_id к ключу: используем previousResponseId только
      // если он был создан тем же acquired.keyId. OpenAI response_id привязан
      // к организации/аккаунту — между разными ключами (разные org'и)
      // сервер вернёт 404, теряем continuity.
      //
      // Mismatch (разные keyId, либо legacy-data без сохранённого keyId на DB-key,
      // либо historyHadStaleUploads — в кэше OpenAI старый file_url, который
      // только что заменён на file_id) → fallback на db_history-flow:
      // отправляем full history с обновлёнными attachment'ами, OpenAI кэшит
      // новый response_id с file_id'ами. Со следующего turn'а previous_response_id
      // снова работает.
      const keyMatches =
        !!dialog.providerLastResponseId && dialog.providerLastResponseKeyId === acquired.keyId;
      if (keyMatches && !filesResult.historyHadStaleUploads) {
        input.previousResponseId = dialog.providerLastResponseId ?? undefined;
      } else if (dialog.providerLastResponseId || filesResult.historyHadStaleUploads) {
        const history = await dialogService.getHistory(dialogId, adapter.contextMaxMessages);
        input.history = await Promise.all(
          history.map((m) =>
            augmentHistoryMessage(
              m,
              model?.supportsDocuments === true,
              extractCache,
              acquired.keyId,
            ),
          ),
        );
      }
    }

    // Save user message — keep the ID so we can mark it failed on error.
    // Store BOTH mediaUrl (legacy single-image для UI/галереи) и attachments[]
    // (документы + ВСЕ изображения с s3Key). Прежде сохраняли только первое
    // изображение в mediaUrl — на следующих turn'ах модель не видела остальные.
    // Теперь все S3-keyed изображения пишем в attachments как entries с
    // `mimeType: image/...`; augmentHistoryMessage пресайнит URL'ы и
    // адаптеры эмиттят image-blocks для history-сообщений.
    //
    // We persist the ORIGINAL user content (not effectivePrompt) so UI still
    // shows what the user typed; the extracted-text prefix exists only
    // in-flight for text-fallback models.
    const firstS3Key = imageS3Keys?.[0];
    const firstImageUrl = imageUrl ?? imageUrls?.[0];
    const savedMediaUrl = firstS3Key ?? firstImageUrl;
    const imageAttachments: StoredAttachment[] = (imageS3Keys ?? []).map((s3Key, i) => {
      const ext = s3Key.split(".").pop()?.toLowerCase();
      const mimeType =
        ext === "png"
          ? "image/png"
          : ext === "webp"
            ? "image/webp"
            : ext === "gif"
              ? "image/gif"
              : "image/jpeg";
      return { s3Key, mimeType, name: `image_${i + 1}` };
    });
    const combinedAttachments: StoredAttachment[] = [
      ...(attachmentsToSave ?? []),
      ...imageAttachments,
    ];
    const userMessage = await dialogService.saveMessage(dialogId, "user", content, {
      ...(savedMediaUrl ? { mediaUrl: savedMediaUrl, mediaType: "image" } : {}),
      ...(combinedAttachments.length > 0 ? { attachments: combinedAttachments } : {}),
    });
    logger.debug(
      { dialogId, docs: documentAttachments?.length ?? 0, modelId: dialog.modelId },
      "chat.sendMessageStream: user message saved",
    );

    // Stream response — iterate manually to capture the generator return value.
    // For provider_chain (OpenAI Responses): if the chained call overflows the
    // context window, fall back to sending the full conversation history as
    // messages (truncated by the adapter) — user never sees an overflow error.
    // The retry happens BEFORE any chunks are yielded to the user.
    const chunks: string[] = [];
    let inputTokensUsed: number | undefined;
    let cachedInputTokensUsed: number | undefined;
    let outputTokensUsed: number | undefined;
    let providerUsdCost: number | undefined;
    let incompleteReason: string | undefined;

    const runStream = async function* (
      this: void,
      runInput: LLMInput,
    ): AsyncGenerator<string, void, unknown> {
      const gen = adapter.chatStream(runInput);
      while (true) {
        const next = await gen.next();
        if (next.done) {
          const result = next.value;
          if (result?.newResponseId) {
            // Сохраняем ключ который создал response_id — на следующем turn'е
            // chat-сервис сравнит с acquired.keyId и при mismatch'е дропнет
            // previousResponseId (response_id невалиден между разными OpenAI
            // org/аккаунтами).
            await dialogService.updateProviderContext(dialogId, {
              providerLastResponseId: result.newResponseId,
              providerLastResponseKeyId: acquiredKeyId,
            });
          }
          inputTokensUsed = result?.inputTokensUsed;
          cachedInputTokensUsed = result?.cachedInputTokensUsed;
          outputTokensUsed = result?.outputTokensUsed;
          providerUsdCost = result?.providerUsdCost;
          incompleteReason = result?.incompleteReason;
          return;
        }
        chunks.push(next.value);
        yield next.value;
      }
    };

    // Outer retry loop: на rate-limit / 5xx / network ДО emit'а первого chunk'а
    // пробуем следующий ключ из пула. previousResponseId дропаем (новый ключ ≠
    // старый OpenAI org). Если эмиттнутые chunks > 0 — retry'нуть нельзя
    // (continuity сломается), throw'аем как раньше.
    //
    // Provider-fallback: если key-pool primary'а исчерпан с 5xx/network ошибкой,
    // ищем кандидата в FALLBACK_LLM_MODELS и переключаемся туда (mirror'ит
    // поведение image/video processor'ов). Триггерится только когда chunks=0.
    const MAX_KEY_ATTEMPTS = 2;
    let keyAttempt = 0;
    while (true) {
      try {
        try {
          yield* runStream(input);
        } catch (err) {
          const canRetry =
            dialog.contextStrategy === "provider_chain" &&
            input.previousResponseId !== undefined &&
            chunks.length === 0 &&
            isContextOverflowError(err) &&
            !(err instanceof ContextOverflowError);
          if (!canRetry) throw err;

          logger.warn(
            { dialogId, modelId: dialog.modelId },
            "chat.sendMessageStream: provider context overflow — retrying with full history",
          );
          const history = await dialogService.getHistory(dialogId, 1000);
          const augmented = await Promise.all(
            history.map((m) =>
              augmentHistoryMessage(m, model?.supportsDocuments === true, extractCache),
            ),
          );
          input = {
            ...input,
            history: augmented,
            previousResponseId: undefined,
          };
          yield* runStream(input);
        }
        break; // success — выходим из retry loop'а
      } catch (err) {
        // Permanent input error — провайдер 400'ит на битом/неподдерживаемом
        // изображении в инпуте. Ретрай и fallback бесполезны (та же картинка
        // упадёт у любого провайдера). Сразу UserFacingError, чтобы юзер
        // увидел конкретную причину вместо generic «unexpected error».
        if (isInvalidImageError(err)) {
          await dialogService.markMessageFailed(userMessage.id);
          throw new UserFacingError("Invalid image input", {
            key: "chatInvalidImage",
            section: "gpt",
            cause: err,
          });
        }

        // OpenAI 404 на previousResponseId — провайдер инвалидировал response
        // кэш (billing suspension, принудительная очистка на их стороне). Ключ
        // тот же, но response_id уже не существует. Ретраим с полной историей:
        // для юзера прозрачно, continuity восстановится на следующем turn'е.
        const httpStatus =
          err instanceof Error && "status" in err ? (err as { status?: number }).status : undefined;
        if (httpStatus === 404 && input.previousResponseId !== undefined && chunks.length === 0) {
          const history = await dialogService.getHistory(dialogId, adapter.contextMaxMessages);
          const augmented = await Promise.all(
            history.map((m) =>
              augmentHistoryMessage(
                m,
                model?.supportsDocuments === true,
                extractCache,
                acquired.keyId,
              ),
            ),
          );
          input = { ...input, history: augmented, previousResponseId: undefined };
          logger.warn(
            { dialogId, modelId: dialog.modelId },
            "chat: OpenAI 404 on previousResponseId — retrying with full history",
          );
          continue;
        }

        // Per-key metrics + throttle on 429-class errors. We only attribute when
        // the pool actually gave us a DB-tracked key (env-fallback yields keyId=null).
        const cls = classifyRateLimit(err, keyProvider);
        const is5xx = isFiveXxError(err);
        const isNetwork = isTransientNetworkError(err);
        const isTransient = cls.isRateLimit || is5xx || isNetwork;
        const haveChunks = chunks.length > 0;
        const canKeyRetry = keyAttempt + 1 < MAX_KEY_ATTEMPTS && !haveChunks && isTransient;

        const transientReason = cls.isRateLimit
          ? "Rate-limited"
          : is5xx
            ? "5xx error"
            : "Network error";
        const failureReasonLabel = cls.isRateLimit ? "rate_limit" : is5xx ? "5xx" : "network";

        if (acquiredKeyId) {
          if (cls.isRateLimit) {
            void markRateLimited(acquiredKeyId, cls.cooldownMs, cls.reason);
          } else {
            void recordError(acquiredKeyId, err instanceof Error ? err.message : String(err));
          }
        }

        // Closure: пытается переключиться на fallback-провайдера. Возвращает
        // true если switch удался (caller должен `continue` outer loop'а),
        // false если fallback'а нет / chunks уже отдавались / ошибка не
        // транзиентная / pool fallback'а тоже пуст.
        const trySwitchToFallbackProvider = async (): Promise<boolean> => {
          if (haveChunks) return false;
          if (!isTransient) return false;

          const candidates = getFallbackCandidates(dialog.modelId, "llm").filter(
            (m: AIModel) => !attemptedProviders.has(m.provider),
          );
          if (candidates.length === 0) return false;

          const next = candidates[0]!;
          const nextKeyProvider = resolveKeyProviderForModel(next);

          let nextAcquired;
          try {
            nextAcquired = await acquireKey(nextKeyProvider);
          } catch (poolErr) {
            if (isPoolExhaustedError(poolErr)) return false;
            throw poolErr;
          }

          logger.warn(
            {
              dialogId,
              modelId: dialog.modelId,
              fromProvider: model?.provider ?? keyProvider,
              toProvider: next.provider,
              reason: failureReasonLabel,
            },
            "chat.sendMessageStream: switching to fallback provider",
          );

          attemptedProviders.add(next.provider);
          keyProvider = nextKeyProvider;
          acquired = nextAcquired;
          acquiredKeyId = nextAcquired.keyId;
          adapter = createLLMAdapter(next, nextAcquired);
          activeAdapterModel = next;

          // Новый провайдер = другая org для OpenAI-семейства → previousResponseId
          // невалиден. Дропаем + шлём полную историю.
          if (input.previousResponseId !== undefined) {
            const history = await dialogService.getHistory(dialogId, adapter.contextMaxMessages);
            const augmented = await Promise.all(
              history.map((m) =>
                augmentHistoryMessage(m, model?.supportsDocuments === true, extractCache),
              ),
            );
            input = { ...input, history: augmented, previousResponseId: undefined };
          }

          // Сбрасываем счётчик попыток — у fallback'а тоже свой бюджет MAX_KEY_ATTEMPTS.
          keyAttempt = 0;
          return true;
        };

        // Helper: фактическая модель/провайдер на момент броска. Если был
        // fallback — `activeAdapterModel` уже не равно primary, и tech-alert
        // должен показать обе модели вместо одной только primary из dialog.
        const buildTechMeta = (): UserFacingError["tech"] => {
          const activeModelId =
            typeof activeAdapterModel === "string" ? activeAdapterModel : activeAdapterModel.id;
          const activeProvider =
            typeof activeAdapterModel === "string"
              ? (model?.provider ?? keyProvider)
              : activeAdapterModel.provider;
          return {
            activeModelId,
            activeProvider,
            primaryModelId: dialog.modelId,
            primaryProvider: model?.provider,
            fallbackUsed: activeModelId !== dialog.modelId,
          };
        };

        if (!canKeyRetry) {
          // В пределах текущего провайдера попыток не осталось → пробуем
          // переключиться на fallback. Если получилось — outer loop рестартует
          // с новым keyProvider.
          if (await trySwitchToFallbackProvider()) {
            continue;
          }
          await dialogService.markMessageFailed(userMessage.id);
          // Convert transient errors (429 / 5xx / network) into a user-facing
          // message. Raw stack trace юзеру бесполезен; оригинал кладём в cause,
          // notifyTechError развернёт его в alert'е.
          if (isTransient) {
            // Mid-stream обрыв: часть ответа уже доехала до юзера, fallback к
            // другому провайдеру невозможен (был бы шизофренический склейк).
            // Отдельный ключ — иначе юзер видит «временно недоступен» сразу
            // после того как модель уже отвечала.
            if (haveChunks) {
              throw new UserFacingError(`Stream interrupted on ${keyProvider}`, {
                key: "chatStreamInterrupted",
                params: { modelName: model?.name ?? dialog.modelId },
                notifyOps: true,
                cause: err,
                tech: buildTechMeta(),
              });
            }
            throw new UserFacingError(`${transientReason} on ${keyProvider}`, {
              key: "modelTemporarilyUnavailable",
              section: "gpt",
              params: { modelName: model?.name ?? dialog.modelId },
              notifyOps: true,
              cause: err,
              tech: buildTechMeta(),
            });
          }
          throw err;
        }

        // Try next key from the pool (already-throttled keys excluded).
        let nextAcquired;
        try {
          nextAcquired = await acquireKey(keyProvider);
        } catch (poolErr) {
          if (isPoolExhaustedError(poolErr)) {
            // Все ключи текущего провайдера throttled → пробуем fallback-провайдера.
            if (await trySwitchToFallbackProvider()) {
              continue;
            }
            await dialogService.markMessageFailed(userMessage.id);
            if (isTransient) {
              throw new UserFacingError(`${transientReason} on ${keyProvider}`, {
                key: "modelTemporarilyUnavailable",
                section: "gpt",
                params: { modelName: model?.name ?? dialog.modelId },
                notifyOps: true,
                cause: err,
                tech: buildTechMeta(),
              });
            }
            throw err;
          }
          throw poolErr;
        }

        logger.warn(
          {
            dialogId,
            modelId: dialog.modelId,
            prevKey: acquiredKeyId,
            newKey: nextAcquired.keyId,
            reason: failureReasonLabel,
          },
          "chat.sendMessageStream: retrying with fallback key",
        );

        // Switch state. previousResponseId привязан к старому ключу (другая
        // OpenAI org) — при реальной ротации дропаем и шлём полную историю.
        // При retry с тем же ключом (env-fallback / совпавший keyId) previousResponseId
        // остаётся валидным — экономим SQL-запрос за историей и трафик к провайдеру.
        const keyChanged = acquiredKeyId !== nextAcquired.keyId;
        acquired = nextAcquired;
        acquiredKeyId = nextAcquired.keyId;
        adapter = createLLMAdapter(activeAdapterModel, nextAcquired);

        if (keyChanged && input.previousResponseId !== undefined) {
          const history = await dialogService.getHistory(dialogId, adapter.contextMaxMessages);
          const augmented = await Promise.all(
            history.map((m) =>
              augmentHistoryMessage(m, model?.supportsDocuments === true, extractCache),
            ),
          );
          input = { ...input, history: augmented, previousResponseId: undefined };
        }

        keyAttempt++;
      }
    }

    if (acquiredKeyId) void recordSuccess(acquiredKeyId);

    const responseText = stripThinkingBlocks(chunks.join(""));

    // Провайдер дошёл до конца стрима без визуального текста (gpt-5 reasoning
    // съел max_output_tokens, пустой response.completed, refusal без content
    // и т.п.). Раньше пустая строка молча сохранялась в БД, токены списывались
    // — юзер видел пропавшее сообщение. Теперь маркируем user-message как
    // failed и поднимаем UserFacingError; assistant-сообщение не сохраняем,
    // токены не списываем (стоимость reasoning-токенов оплачиваем мы, юзер
    // не виноват в пустом ответе).
    if (responseText.length === 0) {
      logger.warn(
        {
          dialogId,
          modelId: dialog.modelId,
          inputTokens: inputTokensUsed,
          outputTokens: outputTokensUsed,
          providerUsdCost,
          chunkCount: chunks.length,
          incompleteReason,
        },
        "chat.sendMessageStream: provider returned empty response",
      );
      await dialogService.markMessageFailed(userMessage.id);
      // Три ветки по incompleteReason:
      //  - `max_output_tokens` — reasoning + visible не уложились в лимит,
      //    даём адресную подсказку (понизить effort / поднять лимит). Алёртим
      //    ops, чтобы видеть тренды (зашитый лимит давит юзеров) без походов в логи.
      //  - `content_filter` — провайдер зарубил ответ по своим правилам
      //    (Claude refusal, OpenAI moderation). Юзер видит тот же текст,
      //    что у image/video. Ops НЕ алёртим: причина — пользовательский
      //    контент, не наша инфра.
      //  - всё остальное (network drop / silent end_turn / unknown) — generic
      //    «временно недоступен», алёртим — причина непрозрачна.
      const isContentFilter = incompleteReason === "content_filter";
      // Подсказка для `max_output_tokens` зависит от провайдера: у OpenAI
      // reasoning-моделей единственный рычаг — снизить `reasoning_effort`
      // (слайдер max_tokens мы убрали — на reasoning он только мешал). У
      // Claude можно либо отключить extended_thinking, либо поднять
      // max_tokens-слайдер. Дефолт на Anthropic-вариант — он более общий
      // и сработает в случае незнакомого провайдера.
      const isOpenai = model?.provider === "openai";
      const reasoningKey = isOpenai
        ? "modelReasoningCapExhaustedOpenai"
        : "modelReasoningCapExhaustedAnthropic";
      const messageKey =
        incompleteReason === "max_output_tokens"
          ? reasoningKey
          : isContentFilter
            ? "contentPolicyViolation"
            : "modelTemporarilyUnavailable";
      throw new UserFacingError(
        `Provider returned empty response (reason: ${incompleteReason ?? "unknown"}, chunks: ${chunks.length}, outputTokens: ${outputTokensUsed ?? 0})`,
        {
          key: messageKey,
          section: "gpt",
          params: { modelName: model?.name ?? dialog.modelId },
          notifyOps: !isContentFilter,
          // Burst-throttle: 5 алёртов / 30 мин per (cause, model). При шторме
          // (зашитый maxTokens прижимает 100 юзеров) не флудим ops-чат, но
          // первые 5 пробьются — этого хватит увидеть тренд.
          opsAlertDedupKey: `chat-empty-${incompleteReason ?? "unknown"}-${dialog.modelId}`,
        },
      );
    }

    // ── Token usage logging ─────────────────────────────────────────────
    // Provider возвращает usage не всегда (некоторые SSE-стримы или non-stream
    // ответы у проксей вроде KIE). Когда нет — выводим нашу оценку через
    // tiktoken cl100k_base (token-estimator.ts) с пометкой `estimated`,
    // чтобы при анализе логов было видно что число — наша аппроксимация,
    // а не provider-truth.
    const inputTokensFromProvider = inputTokensUsed !== undefined;
    const outputTokensFromProvider = outputTokensUsed !== undefined;
    const inputTokensCount = inputTokensFromProvider
      ? (inputTokensUsed as number)
      : estimateStringTokens(content);
    const outputTokensCount = outputTokensFromProvider
      ? (outputTokensUsed as number)
      : estimateStringTokens(responseText);

    logger.info(
      {
        dialogId,
        modelId: dialog.modelId,
        inputTokens: inputTokensCount,
        inputTokensSource: inputTokensFromProvider ? "provider" : "estimated",
        outputTokens: outputTokensCount,
        outputTokensSource: outputTokensFromProvider ? "provider" : "estimated",
        ...(cachedInputTokensUsed !== undefined && cachedInputTokensUsed > 0
          ? { cachedInputTokens: cachedInputTokensUsed }
          : {}),
      },
      `chat: token usage [input=${inputTokensCount}${inputTokensFromProvider ? "" : " est."}, output=${outputTokensCount}${outputTokensFromProvider ? "" : " est."}]`,
    );

    const tokensUsed =
      providerUsdCost !== undefined
        ? providerUsdCost
        : model && inputTokensUsed !== undefined && outputTokensUsed !== undefined
          ? calculateCost(
              model,
              inputTokensUsed,
              outputTokensUsed,
              undefined,
              undefined,
              ms,
              undefined,
              undefined,
              {
                cachedInputTokens: cachedInputTokensUsed,
              },
            )
          : estimateTokens(content, responseText);

    // Save assistant message
    await dialogService.saveMessage(dialogId, "assistant", responseText, { tokensUsed });

    // Audit-метаданные: фактический provider (отличается от primary при
    // fallback'е) и сырая цена в USD по нему. Считаем по `activeAdapterModel`
    // если она в виде AIModel-объекта (т.е. был fallback), иначе — по primary
    // `model`. Если usage нет от провайдера — actualCostUsd оставляем undefined
    // (расчёт без токенов был бы неинформативен).
    const activeModelObj = typeof activeAdapterModel === "string" ? model : activeAdapterModel;
    const actualProvider = activeModelObj?.provider ?? keyProvider;
    const actualCostUsd =
      activeModelObj && inputTokensUsed !== undefined && outputTokensUsed !== undefined
        ? calculateProviderCostUsd(
            activeModelObj,
            inputTokensUsed,
            outputTokensUsed,
            undefined,
            undefined,
            ms,
            undefined,
            undefined,
            { cachedInputTokens: cachedInputTokensUsed },
          )
        : undefined;

    // Deduct tokens
    await deductTokens(userId, tokensUsed, dialog.modelId, dialogId, undefined, {
      actualProvider,
      actualCostUsd,
    });

    return { text: responseText, tokensUsed };
  },
};

/**
 * Rebuilds a historical message for adapter consumption:
 *  - Text-class attachments are extracted from S3 on every turn and inlined
 *    into the message content as `<document>` blocks (silent skip on failure,
 *    so a single corrupted file doesn't block the whole dialog).
 *  - PDF attachments are kept on `attachments[]` with a freshly presigned URL
 *    (only useful for adapters that build native document blocks).
 */
interface HistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Legacy single-image storage (до миграции на attachments[]). Bridge'им. */
  mediaUrl?: string | null;
  mediaType?: string | null;
  attachments?: StoredAttachment[];
}

async function augmentHistoryMessage(
  m: HistoryMessage,
  presignNativePdfs: boolean,
  extractCache: ExtractCache,
  /**
   * Текущий acquired keyId — нужен чтобы резолвить openaiFileIds[keyId] в
   * MessageAttachment.openaiFileId для OpenAI-адаптера. null = env-fallback.
   * undefined = не резолвить (для адаптеров где OpenAI files не применяется).
   */
  openaiKeyId?: string | null,
): Promise<MessageRecord> {
  const atts = m.attachments ?? [];
  const textDocs = atts.filter((a) => isTextClassMime(a.mimeType));
  const nativeDocs = atts.filter((a) => a.mimeType === "application/pdf");
  const imageAtts = atts.filter((a) => a.mimeType.startsWith("image/"));

  // Backward-compat: старые сообщения хранили одно изображение в mediaUrl.
  // Если в attachments[] нет image-entry, но mediaUrl содержит s3Key — добавим
  // его как одно image-attachment.
  const hasLegacyImage =
    imageAtts.length === 0 &&
    !!m.mediaUrl &&
    m.mediaType === "image" &&
    !m.mediaUrl.startsWith("http");
  const legacyImage: StoredAttachment | null = hasLegacyImage
    ? {
        s3Key: m.mediaUrl!,
        mimeType: extToImageMime(m.mediaUrl!),
        name: "image",
      }
    : null;
  const allImages = legacyImage ? [legacyImage, ...imageAtts] : imageAtts;

  if (atts.length === 0 && !legacyImage) {
    return { id: m.id, role: m.role, content: m.content };
  }

  const blocks: string[] = [];
  for (const d of textDocs) {
    const text = await getOrExtract(extractCache, d.s3Key, d.mimeType, d.name);
    if (text !== null) blocks.push(buildDocumentPromptBlock(d.name, text));
  }
  const augmentedContent = blocks.length ? `${blocks.join("\n\n")}\n\n${m.content}` : m.content;

  let presignedNative: MessageAttachment[] | undefined;
  if (presignNativePdfs && nativeDocs.length > 0) {
    const keyKey = openaiKeyId === undefined ? null : (openaiKeyId ?? OPENAI_ENV_KEY);
    presignedNative = await Promise.all(
      nativeDocs.map(async (d) => {
        const fileMap = readOpenAIFileIds(d);
        const resolvedFileId = keyKey ? fileMap[keyKey] : undefined;
        return {
          ...d,
          // file_url presigned per-turn для адаптеров без OpenAI Files (Anthropic,
          // Gemini). OpenAIAdapter предпочтёт openaiFileId если он есть.
          url: (await getFileUrl(d.s3Key)) ?? undefined,
          openaiFileId: resolvedFileId,
          openaiKeyId: resolvedFileId ? openaiKeyId : undefined,
        };
      }),
    );
  }

  // Presign image attachments — все vision-адаптеры читают url с history-турн'а.
  const presignedImages: MessageAttachment[] = [];
  for (const a of allImages) {
    const url = await getFileUrl(a.s3Key).catch(() => null);
    if (url) presignedImages.push({ ...a, url });
  }

  const finalAttachments: MessageAttachment[] = [...(presignedNative ?? []), ...presignedImages];

  return {
    id: m.id,
    role: m.role,
    content: augmentedContent,
    ...(finalAttachments.length > 0 ? { attachments: finalAttachments } : {}),
  };
}

function extToImageMime(s3KeyOrName: string): string {
  const ext = s3KeyOrName.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

/**
 * Lazy-upload attachments to OpenAI Files API for provider_chain dialogs.
 *
 * Зачем: OpenAI Responses API кэширует input по `previous_response_id`. Если
 * у нас в кэше file_url (presigned S3), он протухает через 1ч — на следующем
 * turn'е OpenAI re-fetch'ит → 403 → 400.
 *
 * Каждый attachment хранит МАП `openaiFileIds[keyId] → fileId`. На rotation
 * между ключами один и тот же файл загружается на каждый ключ ОДИН раз и
 * далее переиспользуется — никакого upload churn'а при чередовании ключей.
 *
 * Возвращаем `historyHadStaleUploads` — если хоть для одного history-attachment
 * пришлось делать upload именно сейчас (т.е. для current keyId раньше fileId
 * не было), это значит cached previous_response_id ссылается либо на старый
 * file_url либо на file_id другого ключа. Chat.service дропает
 * previousResponseId и собирает full history с обновлёнными file_id'ами;
 * со следующего turn'а previous_response_id снова работает.
 */
async function ensureOpenAIFiles(opts: {
  dialogId: string;
  currentAttachments: StoredAttachment[] | undefined;
  apiKey: string;
  keyId: string | null;
  /** Proxy config от acquired.proxy — используется для всех Files API вызовов
   *  (upload), чтобы IP-bound ключи работали через тот же канал что chat completions. */
  proxy: AcquiredKey["proxy"];
}): Promise<{
  currentAttachments: StoredAttachment[] | undefined;
  historyHadStaleUploads: boolean;
}> {
  const keyKey = opts.keyId ?? OPENAI_ENV_KEY;
  const fetchFn = buildProxyFetch(opts.proxy) ?? undefined;

  const uploadOne = async (
    att: StoredAttachment,
  ): Promise<{ att: StoredAttachment; uploaded: boolean }> => {
    if (!isOpenAIFileSupportedMime(att.mimeType)) return { att, uploaded: false };

    const fileMap = readOpenAIFileIds(att);
    if (fileMap[keyKey]) {
      // Уже загружен на текущий ключ — переиспользуем. Возвращаем att с
      // нормализованной map (мигрируем legacy single-fileId формат на map).
      const normalised: StoredAttachment = { ...att, openaiFileIds: fileMap };
      return { att: normalised, uploaded: false };
    }

    const bytes = await downloadBuffer(att.s3Key);
    if (!bytes) {
      logger.warn(
        { s3Key: att.s3Key },
        "ensureOpenAIFiles: S3 download failed, skipping OpenAI upload — adapter will fall back to file_url",
      );
      return { att, uploaded: false };
    }

    try {
      const fileId = await uploadFileToOpenAI(opts.apiKey, bytes, att.name, fetchFn);
      logger.info(
        { s3Key: att.s3Key, fileId, keyId: opts.keyId },
        "ensureOpenAIFiles: uploaded to OpenAI Files API",
      );
      const updatedMap = { ...fileMap, [keyKey]: fileId };
      return {
        att: { ...att, openaiFileIds: updatedMap },
        uploaded: true,
      };
    } catch (err) {
      logger.warn(
        { err, s3Key: att.s3Key },
        "ensureOpenAIFiles: OpenAI upload failed — adapter will fall back to file_url",
      );
      return { att, uploaded: false };
    }
  };

  // Current turn attachments
  const currentResults = opts.currentAttachments
    ? await Promise.all(opts.currentAttachments.map(uploadOne))
    : [];
  const currentAttachments = opts.currentAttachments ? currentResults.map((r) => r.att) : undefined;

  // History attachments — find Message rows in this dialog with attachments
  const messages = await db.message.findMany({
    where: { dialogId: opts.dialogId, failed: false },
    select: { id: true, attachments: true },
  });

  let historyHadStaleUploads = false;
  for (const msg of messages) {
    const atts = msg.attachments as unknown as StoredAttachment[] | null;
    if (!Array.isArray(atts) || atts.length === 0) continue;

    const results = await Promise.all(atts.map(uploadOne));
    const updated = results.map((r) => r.att);
    const anyUploaded = results.some((r) => r.uploaded);
    // Записываем обратно если был фактический upload ИЛИ legacy-формат
    // мигрировался на map (openaiFileIds появился). Map-only check
    // достаточен — uploadOne сохраняет старые поля как есть.
    const anyMigrated = updated.some(
      (u, i) => u.openaiFileIds !== atts[i].openaiFileIds && u.openaiFileIds,
    );
    if (anyUploaded || anyMigrated) {
      if (anyUploaded) historyHadStaleUploads = true;
      await db.message.update({
        where: { id: msg.id },
        data: { attachments: updated as unknown as Prisma.InputJsonValue },
      });
    }
  }

  return { currentAttachments, historyHadStaleUploads };
}

/**
 * Cleanup всех OpenAI files этого диалога. Вызывается из dialogService.softDelete.
 * Best-effort — ошибки логируются, не пробрасываются (delete-операция не должна
 * падать если файл уже не существует на стороне OpenAI или ключ пропал).
 *
 * Группируем file_id'ы по ключу-аплоадеру: каждый удаляется ИМЕННО тем ключом
 * (file_id виден только своей organization). Для legacy single-fileId формата
 * читаем через `readOpenAIFileIds` (нормализует в map).
 */
export async function cleanupOpenAIFilesForDialog(dialogId: string): Promise<void> {
  const messages = await db.message.findMany({
    where: { dialogId },
    select: { attachments: true },
  });

  // mapKey ("_env" для env-fallback или CUID ProviderKey.id) → fileIds[]
  const filesByKeyKey = new Map<string, string[]>();
  for (const msg of messages) {
    const atts = msg.attachments as unknown as StoredAttachment[] | null;
    if (!Array.isArray(atts)) continue;
    for (const att of atts) {
      const fileMap = readOpenAIFileIds(att);
      for (const [keyKey, fileId] of Object.entries(fileMap)) {
        if (!fileId) continue;
        const list = filesByKeyKey.get(keyKey) ?? [];
        list.push(fileId);
        filesByKeyKey.set(keyKey, list);
      }
    }
  }

  for (const [keyKey, fileIds] of filesByKeyKey) {
    const realKeyId = keyKey === OPENAI_ENV_KEY ? null : keyKey;
    let acquired: AcquiredKey;
    try {
      acquired = await acquireById(realKeyId, "openai");
    } catch (err) {
      logger.warn(
        { err, keyKey, fileCount: fileIds.length },
        "cleanupOpenAIFilesForDialog: failed to acquire key, skipping",
      );
      continue;
    }
    const fetchFn = buildProxyFetch(acquired.proxy) ?? undefined;
    for (const fileId of fileIds) {
      await deleteFileFromOpenAI(acquired.apiKey, fileId, fetchFn);
    }
    logger.info(
      { keyKey, deleted: fileIds.length, dialogId },
      "cleanupOpenAIFilesForDialog: deleted OpenAI files",
    );
  }
}

/** Strip <think>...</think> reasoning blocks from model output before saving. */
function stripThinkingBlocks(text: string): string {
  return text.replace(/\s*<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

/** Rough token estimation: ~4 chars per token. */
function estimateTokens(prompt: string, completion: string): number {
  return Math.ceil((prompt.length + completion.length) / 4) / 1000;
}
