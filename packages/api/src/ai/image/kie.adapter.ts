import type { ImageAdapter, ImageInput, ImageResult } from "./base.adapter.js";
import { AI_MODELS, config, UserFacingError } from "@metabox/shared";
import { fetchWithLog } from "../../utils/fetch.js";
import { buildKieUploadName, parseImageMime, uploadFileUrl } from "../../utils/kie-upload.js";
import { classifyAIError } from "../../services/ai-error-classifier.service.js";

const KIE_BASE = "https://api.kie.ai";

interface KieSubmitResponse {
  code: number;
  msg: string;
  data?: { taskId?: string };
}

interface KieTaskResponse {
  code: number;
  msg: string;
  data?: {
    taskId: string;
    model: string;
    state: "waiting" | "queuing" | "generating" | "success" | "fail";
    resultJson?: string;
    failCode?: string;
    failMsg?: string;
  };
}

/** Grok Imagine: separate t2i / i2i endpoints. */
const GROK_T2I = "grok-imagine/text-to-image";
const GROK_I2I = "grok-imagine/image-to-image";

/**
 * Nano Banana family: single endpoint per model that accepts optional
 * `image_input` array for i2i. The `nano-banana-edit` variant requires
 * images, but we expose pro/2 which gracefully handle both modes.
 */
const NANO_BANANA_MODEL_NAMES: Record<string, string> = {
  "nano-banana-pro": "nano-banana-pro",
  "nano-banana-2": "nano-banana-2",
};

/**
 * KIE adapter for image generation.
 *
 * Endpoints:
 *  - POST /api/v1/jobs/createTask   — submit generation task
 *  - GET  /api/v1/jobs/recordInfo?taskId=X — poll task status
 *
 * Supports:
 *  - Grok Imagine (t2i / i2i)
 *  - Nano Banana Pro / Nano Banana 2 (t2i + optional i2i via image_input)
 *
 * Input images are re-uploaded through KIE's file upload API to ensure
 * KIE can fetch them (presigned S3/Telegram URLs may be blocked or expire).
 */
export class KieImageAdapter implements ImageAdapter {
  readonly isAsync = true;

  private readonly apiKeyOverride: string | undefined;
  private readonly fetchFn: typeof globalThis.fetch | undefined;

  constructor(
    readonly modelId: string,
    apiKey?: string,
    fetchFn?: typeof globalThis.fetch,
  ) {
    this.apiKeyOverride = apiKey;
    this.fetchFn = fetchFn;
  }

  private get apiKey(): string {
    const key = this.apiKeyOverride ?? config.ai.kie;
    if (!key) throw new Error("KIE_API_KEY not configured");
    return key;
  }

  private get jsonHeaders() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async submit(input: ImageInput): Promise<string> {
    const ms = input.modelSettings ?? {};
    const mi = input.mediaInputs ?? {};
    const editImages = mi.edit ?? [];
    const imageUrls = editImages.length > 0 ? editImages : input.imageUrl ? [input.imageUrl] : [];

    const nanoBananaModel = NANO_BANANA_MODEL_NAMES[this.modelId];
    const isNanoBanana = this.modelId === "nano-banana-1" || !!nanoBananaModel;

    // KIE OpenAPI spec для всей nano-banana семьи помечает `prompt` как
    // единственное required-поле. Без него KIE отвечает 500 «This field is
    // required» — юзер видит шутливое «модель отдыхает» и не понимает что
    // ему написать промпт. Ловим up-front, экономим KIE-credit и roundtrip.
    if (isNanoBanana && !input.prompt?.trim()) {
      throw new UserFacingError("Prompt is required for nano-banana models", {
        key: "promptRequired",
      });
    }

    let body: { model: string; input: Record<string, unknown> };

    if (this.modelId === "nano-banana-1") {
      // ── Google Nano Banana v1: t2i / i2i via separate endpoints ────────────
      const isI2I = imageUrls.length > 0;
      const inputPayload: Record<string, unknown> = {
        prompt: input.prompt,
      };

      const imageSize = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio ?? "1:1";
      inputPayload.image_size = imageSize;

      const rawFormat = (ms.output_format as string | undefined) ?? "png";
      inputPayload.output_format = rawFormat === "jpg" ? "jpeg" : rawFormat;

      if (isI2I) {
        const uploaded = await Promise.all(
          imageUrls
            .slice(0, 10)
            .map((url) => uploadFileUrl(this.apiKey, url, buildKieUploadName(url))),
        );
        inputPayload.image_urls = uploaded;
      }

      body = {
        model: isI2I ? "google/nano-banana-edit" : "google/nano-banana",
        input: inputPayload,
      };
    } else if (nanoBananaModel) {
      // ── Nano Banana Pro / Nano Banana 2 ────────────────────────────────────
      const inputPayload: Record<string, unknown> = {
        prompt: input.prompt,
      };

      const aspectRatio = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio ?? "1:1";
      inputPayload.aspect_ratio = aspectRatio;

      const resolution = (ms.resolution as string | undefined) ?? "1K";
      inputPayload.resolution = resolution;

      // KIE accepts only png/jpg; map jpeg → jpg for compatibility with shared settings.
      const rawFormat = (ms.output_format as string | undefined) ?? "png";
      const outputFormat = rawFormat === "jpeg" ? "jpg" : rawFormat;
      inputPayload.output_format = outputFormat;

      if (imageUrls.length > 0) {
        const maxImages = this.modelId === "nano-banana-2" ? 14 : 8;
        const uploaded = await Promise.all(
          imageUrls
            .slice(0, maxImages)
            .map((url) => uploadFileUrl(this.apiKey, url, buildKieUploadName(url))),
        );
        inputPayload.image_input = uploaded;
      }

      body = { model: nanoBananaModel, input: inputPayload };
    } else if (this.modelId === "gpt-image-2") {
      // ── GPT Image 2 via KIE: t2i / i2i via separate endpoints ──────────────
      // Временно проксируем gpt-image-2 через KIE, чтобы не зависеть от прямого
      // OpenAI Images API. Реализация на OpenAI сохранена закомментированной в
      // packages/shared/.../design.models.ts — для отката достаточно вернуть
      // provider:"openai" и снять комменты.
      const isI2I = imageUrls.length > 0;
      const aspectRatio = (ms.aspect_ratio as string | undefined) ?? input.aspectRatio ?? "auto";
      // KIE-схема: aspect_ratio "auto" поддерживает только 1K; aspect_ratio "1:1"
      // не поддерживает 4K. Несовместимые комбинации createTask отклонит — НЕ
      // даунгрейдим client-side, иначе списали бы за выбранное разрешение, а
      // получили бы более низкое (overcharge без feedback'а).
      const resolution = (ms.resolution as string | undefined) ?? "1K";
      const inputPayload: Record<string, unknown> = {
        prompt: input.prompt,
        nsfw_checker: ms.nsfw_checker !== undefined ? ms.nsfw_checker : false,
        aspect_ratio: aspectRatio,
        resolution,
      };

      if (isI2I) {
        const uploaded = await Promise.all(
          imageUrls
            .slice(0, 16)
            .map((url) => uploadFileUrl(this.apiKey, url, buildKieUploadName(url))),
        );
        inputPayload.input_urls = uploaded;
      }

      body = {
        model: isI2I ? "gpt-image-2-image-to-image" : "gpt-image-2-text-to-image",
        input: inputPayload,
      };
    } else if (this.modelId === "grok-imagine-image") {
      // ── Grok Imagine ───────────────────────────────────────────────────────
      const isI2I = imageUrls.length > 0;
      const inputPayload: Record<string, unknown> = {
        prompt: input.prompt,
        nsfw_checker: ms.nsfw_checker !== undefined ? ms.nsfw_checker : false,
      };
      inputPayload.aspect_ratio =
        (ms.aspect_ratio as string | undefined) ?? input.aspectRatio ?? "1:1";
      inputPayload.enable_pro = (ms.enable_pro as boolean | undefined) ?? false;

      if (isI2I) {
        inputPayload.image_urls = await Promise.all(
          imageUrls.map((url) => uploadFileUrl(this.apiKey, url, buildKieUploadName(url))),
        );
      }

      body = { model: isI2I ? GROK_I2I : GROK_T2I, input: inputPayload };
    } else {
      throw new Error(`KIE image: unknown model ${this.modelId}`);
    }

    const resp = await fetchWithLog(
      `${KIE_BASE}/api/v1/jobs/createTask`,
      {
        method: "POST",
        headers: this.jsonHeaders,
        body: JSON.stringify(body),
      },
      this.fetchFn,
    );

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`KIE image submit error ${resp.status}: ${txt}`);
    }

    const data = (await resp.json()) as KieSubmitResponse;
    if (data.code !== 200 || !data.data?.taskId) {
      const msg = data.msg ?? "";
      // Defensive net: nano-banana-2 (и схожие KIE-модели) валидируют тип
      // input-картинки по URL extension'у. Передача `fileName` в uploadFileUrl
      // должна это закрывать, но если в input всё-таки приходит
      // реально-неподдерживаемый формат (HEIC/AVIF и т.п.) — показываем юзеру
      // понятный мессадж со списком поддерживаемых форматов вместо generic
      // «generationFailed». notifyOps + dedup: триггер означает, что
      // fileName-fix что-то пропустил — алёртим оператора, но не спамим.
      if (/file type not supported|invalid image format|unsupported image format/i.test(msg)) {
        throw new UserFacingError(`KIE image submit failed: ${data.code} — ${msg}`, {
          key: "chatInvalidImage",
          notifyOps: true,
          opsAlertDedupKey: `kie-image-unsupported-format-${this.modelId}`,
        });
      }
      throw new Error(`KIE image submit failed: ${data.code} — ${msg}`);
    }
    return data.data.taskId;
  }

  async poll(taskId: string): Promise<ImageResult[] | null> {
    const resp = await fetchWithLog(
      `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
      this.fetchFn,
    );

    if (!resp.ok) throw new Error(`KIE image poll error ${resp.status}`);

    const data = (await resp.json()) as KieTaskResponse;
    if (data.code !== 200 || !data.data) {
      throw new Error(`KIE image poll failed: ${data.code} — ${data.msg}`);
    }

    const task = data.data;

    if (task.state === "fail") {
      const rawFailMsg = task.failMsg ?? "unknown error";
      const failCode = task.failCode;
      // KIE upstream иногда возвращает chat-style ответ с подробным rationale,
      // code-блоками и альтернативным промптом (особенно gpt-image-2 при
      // отказе). Без обрезки 1-2 КБ текста утекают в логи, ops-алёрты и в
      // technicalMessage внутри UserFacingError. Sanitize ТОЛЬКО для
      // technicalMessage; детекция работает по rawFailMsg, иначе ключевые
      // слова (identity / reference photo / copyright) внутри code-блока
      // окажутся за границей среза и regex не сматчатся.
      const sanitizedFailMsg = (() => {
        const codeFenceIdx = rawFailMsg.indexOf("```");
        const cut = codeFenceIdx >= 0 ? rawFailMsg.slice(0, codeFenceIdx) : rawFailMsg;
        const oneLine = cut.replace(/\s+/g, " ").trim();
        return oneLine.length > 400 ? `${oneLine.slice(0, 400)}…` : oneLine;
      })();
      const technicalMessage = `KIE ${this.modelId} generation failed: ${failCode ?? ""} ${sanitizedFailMsg}`;
      // KIE-side инфра-ошибка: 422 + "playground failed"/"task id is blank" →
      // их backend в трауре, но мы передали валидный taskId. Бросаем plain Error
      // (НЕ UserFacingError) чтобы BullMQ ретрайнул и на последней попытке
      // processor через `isKieTransientError` триггернул re-submit на fallback
      // (для моделей с зарегистрированным fallback'ом). Без этой ветки ошибка
      // проваливалась в classifyAIError-фолбек, который галлюцинировал юзеру
      // абсурд про "заполните идентификатор задачи" и спамил ops через
      // notifyOps:true. Также покрывает 422 с обёрнутым "499 Client Closed
      // Request" — апстрим (Google Vertex / Replicate) разорвал коннект,
      // классический transient. Симметрично с kie-error.ts:isKieTransientError.
      if (
        failCode === "422" &&
        /playground failed|task id is blank|client closed request/i.test(rawFailMsg)
      ) {
        throw new Error(technicalMessage);
      }
      const isCopyright = failCode === "501" || /copyright/i.test(rawFailMsg);
      // KIE/evolink content moderation: "Request blocked: ... prominent public figure"
      // → отдельный мессадж про публичные лица (юзер часто пытается грузить фото
      // знаменитостей или просит их в промпте — copyright-сообщение неточно).
      const isPublicFigure = /public figure|public person|prominent figure|celebrity/i.test(
        rawFailMsg,
      );
      // gpt-image-2 (KIE) часто отказывает с chat-style refusal'ом, когда юзер
      // просит «сохранить лицо» с референса. Виды формулировок:
      //   "I can't generate/edit that image ... identity preservation ... real people ... reference photos"
      //   "I can't generate or transform an image of a real child from the provided photos"
      //   "I cannot create ... real person ... uploaded image"
      //   "I can't make ... real face ... face reference"
      // Существующие regex (policy/publicFigure) такие фразы не ловят, и юзеру
      // прилетал сырой длинный текст или галлюцинация classifier'а с notifyOps:true.
      // Маппим на отдельный ключ с подсказкой переключиться на модель,
      // которая лучше работает с face reference.
      //
      // Часть 1 — глагол-«I can't»: добавлен `transform` (OpenAI использует на
      // edit-режиме). Часть 2 — расширена номенклатура «real X»: помимо
      // people/person/face добавлены child/children/kid/baby/infant/minor/
      // individual/human (минор-кейсы провайдеры режут особенно жёстко).
      // Также добавлен `provided (photo|image|reference)s?` рядом с
      // `uploaded` — OpenAI варьирует «uploaded photos» / «provided photos»
      // / «the provided images».
      const isIdentityPreservation =
        /\bI (?:can(?:'|’)?t|cannot) (?:generate|edit|create|produce|make|transform)\b/i.test(
          rawFailMsg,
        ) &&
        /identity|real (?:people|person|faces?|child|children|kid|baby|infant|minor|individual|human)|reference (?:photo|image)|uploaded (?:photo|image|reference)|provided (?:photo|image|reference)s?|face (?:reference|swap)|likeness/i.test(
          rawFailMsg,
        );
      const isPolicy =
        failCode === "430" ||
        failCode === "431" ||
        /sensitive|restrict|policy|prohibited|nsfw|violat|inappropriate|safety|content moderation|blocked|(prompt|request|input|content) (was |is )?rejected/i.test(
          rawFailMsg,
        );
      // Generic "model couldn't generate for this prompt" — Gemini (KIE
      // nano-banana backend) и подобные шлют 500 с message типа
      // "Gemini could not generate an image with the given prompt. Please
      // try again with a different prompt." Это user-facing (юзер должен
      // переформулировать), а НЕ tech 5xx — иначе попало бы в poll-stage
      // KIE-fallback re-submit логику, которая зря сожгла бы fallback
      // attempt и user не понял бы что нужно сделать.
      //
      // Также сюда попадает случай когда gpt-image-2 (KIE) вместо генерации
      // возвращает chat-style ответ ассистента ("Вот несколько вариантов на
      // английском..."). Легитимные upstream-ошибки KIE всегда на английском,
      // поэтому кириллица в failMsg = модель ушла в clarification-режим.
      const hasCyrillic = /[Ѐ-ӿ]/.test(rawFailMsg);
      const isNoResult =
        /could not generate (an? )?(image|video|result)|failed to generate|no image (was )?generated|unable to generate/i.test(
          rawFailMsg,
        ) || hasCyrillic;
      // identityPreservation проверяем РАНЬШЕ noResult: если OpenAI ответит
      // "could not generate ... due to identity preservation" — оба триггера
      // сработают, но конкретная подсказка про face reference полезнее
      // generic "переформулируйте промпт".
      if (isIdentityPreservation)
        throw new UserFacingError(technicalMessage, { key: "identityPreservationNotAllowed" });
      if (isNoResult) {
        throw new UserFacingError(technicalMessage, { key: "generationNoResult" });
      }
      if (isPublicFigure)
        throw new UserFacingError(technicalMessage, { key: "publicFigureViolation" });
      if (isCopyright) throw new UserFacingError(technicalMessage, { key: "copyrightViolation" });
      if (isPolicy) throw new UserFacingError(technicalMessage, { key: "contentPolicyViolation" });
      // Midjourney syntax detector: KIE при 400 от провайдера часто эхает
      // обратно сам промпт юзера в `failMsg`. Если в нём видны характерные
      // Midjourney-маркеры (`/imagine prompt:`, флаги `--ar`/`--stylize`/
      // `--niji`/`--seed`/`--chaos`/`--quality`/`--v` и т.п.) — юзер скопировал
      // промпт из MJ-туториала, а отправил в gpt-image-2/nano-banana/grok-imagine
      // которые такой синтаксис не понимают. Бросаем user-facing подсказку без
      // notifyOps (это user-fault, не наша инфра). Иначе ошибка падала в
      // classifier-фолбек, юзер получал generic «модель устала».
      const isMidjourneySyntax =
        /\/imagine\s+prompt:|--(ar|stylize|niji|seed|chaos|quality|weird|tile|repeat|style|sref|cref|v)\b/i.test(
          rawFailMsg,
        );
      if (isMidjourneySyntax) {
        throw new UserFacingError(technicalMessage, {
          key: "midjourneySyntaxNotSupported",
          params: { modelName: AI_MODELS[this.modelId]?.name ?? this.modelId },
        });
      }

      const classified = await classifyAIError(`${failCode ?? ""} ${sanitizedFailMsg}`.trim());
      if (classified?.shouldShow) {
        throw new UserFacingError(technicalMessage, {
          key: "aiClassifiedError",
          params: { messageRu: classified.messageRu, messageEn: classified.messageEn },
          notifyOps: true,
        });
      }
      throw new Error(technicalMessage);
    }
    if (task.state !== "success") return null;

    if (!task.resultJson) throw new Error("KIE: no resultJson in completed image task");
    const result = JSON.parse(task.resultJson) as { resultUrls?: string[] };
    const urls = result.resultUrls;
    if (!urls?.length) throw new Error("KIE: no image URLs in resultJson");

    return urls.map((url, i) => {
      const { ext, contentType } = parseImageMime(url);
      return {
        url,
        filename: `${this.modelId}-${i}.${ext}`,
        contentType,
      };
    });
  }
}
