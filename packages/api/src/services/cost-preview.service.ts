import {
  AI_MODELS,
  getModelDefaultDuration,
  parseVideoShots,
  sumShotDuration,
} from "@metabox/shared";
import { calculateCost, computeVideoTokens, usdToTokens } from "./token.service.js";
import { getModelMultiplier } from "./pricing-config.service.js";
import { userStateService } from "./user-state.service.js";
import { probeAudioDurationSec } from "../utils/audio-transcode.js";
import { probeVideoMetadata } from "../utils/mp4-duration.js";
import { computeSeedance2BillableUsd } from "../utils/seedance2-billing.js";
import { logger } from "../logger.js";
import type { SubmitImageParams } from "./generation.service.js";
import type { SubmitVideoParams } from "./video-generation.service.js";
import type { SubmitAudioParams } from "./audio-generation.service.js";

/**
 * For HeyGen lip-sync the output video length equals the input audio length,
 * and HeyGen bills per second. We must measure audio up-front so the balance
 * check (and the user-facing confirmation message) reflects reality.
 */
export async function probeHeygenAudioDuration(
  _modelSettings: Record<string, unknown>,
  mediaInputs: Record<string, string[]> | undefined,
): Promise<number | null> {
  const url =
    mediaInputs?.voice_audio?.[0] ??
    mediaInputs?.driving_audio?.[0] ??
    mediaInputs?.reference_audios?.[0] ??
    null;
  if (!url) return null;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return await probeAudioDurationSec(buf);
  } catch (err) {
    logger.warn({ err }, "probeHeygenAudioDuration: failed to fetch/probe input audio");
    return null;
  }
}

export interface ImageCostPreview {
  cost: number;
  perImageCost: number;
  numImages: number;
  effectiveAspectRatio: string | undefined;
  effectiveModelSettings: Record<string, unknown>;
}

export type VideoPricingMode = "total" | "per_second";

export interface VideoCostPreview {
  cost: number;
  /**
   * "total" — `cost` это полная предварительная цена ролика.
   * "per_second" — длительность заранее неизвестна (HeyGen без входного аудио):
   *   `cost` это цена ОДНОЙ секунды видео, бот должен показать её отдельным
   *   текстом и не выдавать за итоговую сумму.
   */
  pricingMode: VideoPricingMode;
  effectiveDuration: number;
  effectiveAspectRatio: string | undefined;
  effectiveModelSettings: Record<string, unknown>;
  estimatedVideoTokens: number | undefined;
}

export interface AudioCostPreview {
  cost: number;
  effectiveModelSettings: Record<string, unknown>;
}

export const costPreviewService = {
  async previewImage(params: SubmitImageParams): Promise<ImageCostPreview> {
    const { userId, modelId, aspectRatio, extraModelSettings } = params;
    const model = AI_MODELS[modelId];
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const allModelSettings = await userStateService.getModelSettings(userId);
    const modelSettings = { ...(allModelSettings[modelId] ?? {}), ...extraModelSettings };
    const effectiveAspectRatio = (modelSettings.aspect_ratio as string | undefined) ?? aspectRatio;

    const estimatedMegapixels = model.costUsdPerMPixel
      ? (model.estimatedMegapixels ?? 1.0)
      : undefined;
    const perImageCost = calculateCost(model, 0, 0, estimatedMegapixels, undefined, modelSettings);

    const maxBatch = model.maxVirtualBatch ?? 1;
    const isVirtualBatchEligible = maxBatch > 1 && (model.nativeBatchMax ?? 1) === 1;
    const requestedN = Number(modelSettings.num_images ?? 1);
    const numImages = isVirtualBatchEligible
      ? Math.max(1, Math.min(maxBatch, Number.isFinite(requestedN) ? Math.floor(requestedN) : 1))
      : 1;

    return {
      cost: perImageCost * numImages,
      perImageCost,
      numImages,
      effectiveAspectRatio,
      effectiveModelSettings: modelSettings,
    };
  },

  async previewVideo(params: SubmitVideoParams): Promise<VideoCostPreview> {
    const { userId, modelId, prompt, aspectRatio, duration, extraModelSettings } = params;
    const model = AI_MODELS[modelId];
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const allModelSettings = await userStateService.getModelSettings(userId);
    const modelSettings = { ...(allModelSettings[modelId] ?? {}), ...extraModelSettings };
    const effectiveAspectRatio = (modelSettings.aspect_ratio as string | undefined) ?? aspectRatio;
    // `getModelDefaultDuration` приоритизирует `settings[duration].default` (то
    // значение что рисуется в UI до взаимодействия), затем supportedDurations[0]
    // / durationRange.min. До фикса юзеры kling'а с пустым userState видели «5»
    // в слайдере, но бот падал на durationRange.min=3 и слал «3» в KIE.
    let effectiveDuration =
      (modelSettings.duration as number | undefined) ??
      duration ??
      getModelDefaultDuration(model) ??
      5;
    let pricingMode: VideoPricingMode = "total";

    // Multi-shot (Kling): итоговая длительность = сумма длительностей шотов
    // (клампится в 3–15). Биллинг по той же per-second ставке + costVariants
    // (`generate_audio`), что и single-shot.
    if (modelSettings.multishot === true) {
      const shots = parseVideoShots(modelSettings.shots);
      if (shots.length > 0) {
        effectiveDuration = sumShotDuration(shots);
      }
    }

    if (modelId === "heygen") {
      // HeyGen биллится посекундно, длина видео = длине аудио. Если аудио есть —
      // probe'аем и показываем точную предварительную цену. Если аудио нет
      // (текстовый TTS-путь) либо probe сорвался — длительность заранее
      // неизвестна (раньше угадывали по prompt.length/14 и получали ложные
      // 11.25 ✦ при реальном списании 389.25 ✦). Переключаемся на per-second
      // режим: показываем юзеру цену 1 секунды, итог считается по факту.
      //
      // Если `audioDurationSecHint` уже задан (HeyGen TTS endpoint вернул
      // точную длительность из ответа) — используем его и пропускаем
      // повторный fetch+ffprobe того же mp3.
      const hint = params.audioDurationSecHint;
      const audioSec =
        typeof hint === "number" && isFinite(hint) && hint > 0
          ? hint
          : await probeHeygenAudioDuration(modelSettings, params.mediaInputs);
      if (audioSec !== null) {
        effectiveDuration = Math.ceil(audioSec);
        logger.info(
          { modelId, audioSec, effectiveDuration },
          "HeyGen pre-flight: using probed audio duration for cost estimate",
        );
      } else {
        pricingMode = "per_second";
        effectiveDuration = 1;
        logger.info(
          { modelId, hasPrompt: !!prompt },
          "HeyGen pre-flight: per-second pricing (no input audio to probe)",
        );
      }
    }

    // Готовый сценарий «Копировать движение»: длительность результата =
    // длительность референс-видео (юзер не настраивает), заранее неизвестна.
    // Без этой ветки веб-пресет показывал бы цену за дефолтные 5с — а реальное
    // списание считается по фактической длительности из mp4-probe в воркере
    // (см. video.processor.ts:682-816). Per-second режим даёт фронту флаг,
    // чтобы он отрисовал «X.XX ✦ / сек» вместо «X.XX ✦ за запрос».
    if (modelId === "copy-motion") {
      pricingMode = "per_second";
      effectiveDuration = 1;
    }

    // Kling Motion (Standard/Pro): длительность результата = длине референс-
    // видео (motion_video), юзером не настраивается и нет `duration` в settings,
    // поэтому previewVideo иначе берёт fallback 5с и занижает цену вдвое (юзер
    // видел ~25 ✦, списывалось ~52 ✦ за 10с ролик — биллинг по фактической
    // длине выхода в video.processor.ts). Probe'аем загруженное видео той же
    // mp4-метрикой, что воркер юзает для wan/seedance, и округляем ВВЕРХ —
    // превью никогда не ниже реального списания. supportsWeb:false → это
    // бот-only confirm-гейт, probe срабатывает один раз, не в hot-path
    // веб-превью. Если probe сорвался / видео ещё нет — уходим в per_second
    // (как copy-motion): показываем цену секунды, не выдавая ложный total.
    if (modelId === "kling-motion" || modelId === "kling-motion-pro") {
      const motionVideoUrl = params.mediaInputs?.motion_video?.[0];
      let probedDuration: number | null = null;
      if (motionVideoUrl) {
        try {
          probedDuration = (await probeVideoMetadata(motionVideoUrl)).durationSec;
        } catch (err) {
          logger.warn({ err, modelId }, "Kling Motion preview: reference video probe failed");
        }
      }
      if (probedDuration && probedDuration > 0) {
        effectiveDuration = Math.ceil(probedDuration);
        // +1с буфер ТОЛЬКО в цене: probe меряет ВХОД (motion_video), а воркер
        // биллит ВЫХОД (actualDuration без ceil). Если Kling вернёт ролик на
        // доли секунды длиннее входа — буфер гарантирует preview ≥ списания.
        // Возвращаемый effectiveDuration остаётся честным: провайдеру duration
        // не уходит (kie kling-motion-control его не принимает).
        const cost = calculateCost(
          model,
          0,
          0,
          undefined,
          undefined,
          modelSettings,
          effectiveDuration + 1,
        );
        return {
          cost,
          pricingMode,
          effectiveDuration,
          effectiveAspectRatio,
          effectiveModelSettings: modelSettings,
          estimatedVideoTokens: undefined,
        };
      }
      pricingMode = "per_second";
      effectiveDuration = 1;
    }

    // Grok Imagine extend: FAL склеивает исходник + продление, реальный output =
    // source + extension (fal.adapter.ts), воркер биллит всю склейку по
    // actualDuration. Настройка `duration` (здесь = effectiveDuration, 6-10с)
    // задаёт длину ТОЛЬКО продления — именно её получает провайдер
    // (fal.adapter.ts берёт job.duration как длину extension'а). Поэтому цену
    // считаем по (ceil(source) + extension + 1с буфер), но ВОЗВРАЩАЕМ
    // effectiveDuration = длина продления, чтобы в очередь/адаптер ушло
    // провайдер-корректное значение, а не раздутая склейка. +1с буфер —
    // на seam/padding склейки. supportsWeb:false → бот-only confirm-гейт, probe
    // один раз. Probe сорвался / нет видео → per_second (цена секунды).
    if (modelId === "grok-imagine-extend") {
      const extensionDuration = effectiveDuration;
      const sourceUrl = params.mediaInputs?.source_video?.[0];
      let sourceDuration: number | null = null;
      if (sourceUrl) {
        try {
          sourceDuration = (await probeVideoMetadata(sourceUrl)).durationSec;
        } catch (err) {
          logger.warn({ err, modelId }, "Grok extend preview: source video probe failed");
        }
      }
      if (sourceDuration && sourceDuration > 0) {
        const cost = calculateCost(
          model,
          0,
          0,
          undefined,
          undefined,
          modelSettings,
          Math.ceil(sourceDuration) + extensionDuration + 1,
        );
        return {
          cost,
          pricingMode,
          effectiveDuration: extensionDuration,
          effectiveAspectRatio,
          effectiveModelSettings: modelSettings,
          estimatedVideoTokens: undefined,
        };
      }
      pricingMode = "per_second";
      effectiveDuration = 1;
    }

    // Runway gen4.5 принимает только 5/10s; в userState у части юзеров остались
    // значения 2-4, 6-9 со старого слайдера 2..10. Снэпаем здесь, чтобы списание
    // совпало с тем, что адаптер фактически отправит провайдеру. Для остальных
    // моделей с supportedDurations не трогаем — у них исторически встречаются
    // stale-значения (см. 21b144a по veo: 5/7), которые провайдер принимает,
    // и тихая правка укоротила бы юзерам видео.
    if (modelId === "runway" && model.supportedDurations && model.supportedDurations.length > 0) {
      const allowed = model.supportedDurations;
      effectiveDuration = allowed.reduce(
        (best, d) =>
          Math.abs(d - effectiveDuration) < Math.abs(best - effectiveDuration) ? d : best,
        allowed[0]!,
      );
    }

    // Wan first_clip mode: формула биллинга — `output + min(input_clip, 5)`
    // (см. video.processor.ts:683-690). В previewVideo точная длительность
    // клипа без HTTP-probe'а неизвестна, поэтому добавляем worst-case +5s.
    // Превью чуть завышает на коротких клипах (<5s), зато никогда не занижает
    // → юзер не получит surprise списание выше превью. Probe в hot-path
    // нерентабелен (полная загрузка MP4 на каждый ререндер UI).
    if (modelId === "wan" && params.mediaInputs?.first_clip?.[0]) {
      effectiveDuration += 5;
    }

    // Seedance 2.0 / 2.0 Fast (evolink) в r2v-режиме (есть ref_videos): провайдер
    // биллит по ПОНИЖЕННОЙ ставке, но billable = output + max(Σinput, output)
    // ≥ 2×output (computeSeedance2BillableUsd, та же формула что в
    // video.processor.ts). Обычный calculateCost ниже считает по no-video ставке
    // × output и занижает (пониженная ставка не компенсирует удвоение секунд).
    // Probe'аем ref_videos и считаем точную цену той же формулой, что списывает
    // воркер. Probe части видео сорвался → берём 0 для него: max(Σinput, output)
    // завысит, но не занизит. supportsWeb:false → previewVideo для seedance-2
    // зовётся только в боте (confirm-гейт + submit), не в hot-path веб-превью.
    // +1с буфер в outputDuration (только цена): воркер биллит по фактической
    // длине выхода (actualDuration), которая может быть на доли секунды длиннее
    // запрошенной настройки; буфер гарантирует preview ≥ списания. Возвращаемый
    // effectiveDuration остаётся честным (= настройка, уходит провайдеру).
    if (
      (modelId === "seedance-2" || modelId === "seedance-2-fast") &&
      model.provider === "evolink"
    ) {
      const refVideos = params.mediaInputs?.ref_videos ?? [];
      if (refVideos.length > 0) {
        const resolution = (modelSettings.resolution as string | undefined) ?? "720p";
        const inputDurations = await Promise.all(
          refVideos.map((u) =>
            probeVideoMetadata(u)
              .then((m) => m.durationSec ?? 0)
              .catch(() => 0),
          ),
        );
        const usd = computeSeedance2BillableUsd({
          modelId,
          resolution,
          outputDuration: effectiveDuration + 1,
          inputVideoDurations: inputDurations,
        });
        if (usd !== null) {
          return {
            cost: usdToTokens(usd) * getModelMultiplier(modelId),
            pricingMode,
            effectiveDuration,
            effectiveAspectRatio,
            effectiveModelSettings: modelSettings,
            estimatedVideoTokens: undefined,
          };
        }
      }
    }

    const estimatedVideoTokens = model.costUsdPerMVideoToken
      ? computeVideoTokens(
          model,
          effectiveAspectRatio,
          effectiveDuration,
          undefined,
          undefined,
          undefined,
          modelSettings.resolution as string | undefined,
        )
      : undefined;

    const cost = calculateCost(
      model,
      0,
      0,
      undefined,
      estimatedVideoTokens,
      modelSettings,
      effectiveDuration,
    );

    return {
      cost,
      pricingMode,
      effectiveDuration,
      effectiveAspectRatio,
      effectiveModelSettings: modelSettings,
      estimatedVideoTokens,
    };
  },

  async previewAudio(params: SubmitAudioParams): Promise<AudioCostPreview> {
    const { userId, modelId, prompt, extraModelSettings } = params;
    const model = AI_MODELS[modelId];
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const allModelSettings = await userStateService.getModelSettings(userId);
    let modelSettings = { ...(allModelSettings[modelId] ?? {}), ...extraModelSettings };

    // Посекундный биллинг аудио (sounds-el / music-el): нормализуем
    // duration_seconds перед расчётом стоимости. Без этого:
    //  - отсутствует / лежит строкой → computeMediaBaseUsd падает в
    //    fallback-ветку и списывает $0;
    //  - stale-значение вне границ (старый слайдер sounds-el был до 30) →
    //    юзеру списали бы за 30с, а адаптер отправит в kie максимум 22с.
    // Зажимаем в границы каталога и кладём число обратно в
    // effectiveModelSettings — оно уходит и в очередь, и в inputData джобы, так
    // что превью, воркер и адаптер считают по одному числу.
    if (model.costUsdPerSecond !== undefined) {
      const durSetting = model.settings?.find((s) => s.key === "duration_seconds");
      const fallback = typeof durSetting?.default === "number" ? durSetting.default : 10;
      const min = typeof durSetting?.min === "number" ? durSetting.min : 0.5;
      const max = typeof durSetting?.max === "number" ? durSetting.max : 22;
      const raw = modelSettings.duration_seconds;
      const n = typeof raw === "number" ? raw : Number(raw);
      const normalized = Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
      modelSettings = { ...modelSettings, duration_seconds: normalized };
    }

    const cost = calculateCost(
      model,
      0,
      0,
      undefined,
      undefined,
      modelSettings,
      undefined,
      prompt.length,
    );

    return { cost, effectiveModelSettings: modelSettings };
  },
};
