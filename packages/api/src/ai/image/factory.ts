import { AI_MODELS } from "@metabox/shared";
import type { AIModel } from "@metabox/shared";
import type { ImageAdapter } from "./base.adapter.js";
export type { ImageResult } from "./base.adapter.js";
import { DalleAdapter } from "./dalle.adapter.js";
import { FalAdapter } from "./fal.adapter.js";
import { ReplicateAdapter } from "./replicate.adapter.js";
import { RecraftAdapter } from "./recraft.adapter.js";
import { GptImageAdapter } from "./gpt-image.adapter.js";
import { HiggsFieldSoulImageAdapter } from "./higgsfield.soul.adapter.js";
import { KieImageAdapter } from "./kie.adapter.js";
import { EvolinkImageAdapter } from "./evolink.adapter.js";
import type { AdapterContext } from "../with-pool.js";
import { buildProxyFetch } from "../transport/proxy-fetch.js";

/**
 * Если `ctx` передан — используем выбранный из пула ключ + (опционально) прокси.
 * FAL SDK конфигурируется глобально и не поддерживает per-instance fetch —
 * прокси для FAL на MVP игнорируется.
 *
 * Принимает либо строку (modelId, lookup в AI_MODELS), либо готовый AIModel
 * объект. Второй вариант нужен для fallback: у fallback-модели тот же `id`,
 * что и у primary, но другой `provider` — лookup по id вернул бы не ту запись.
 */
export function createImageAdapter(
  modelOrId: string | AIModel,
  ctx?: AdapterContext,
): ImageAdapter {
  const model = typeof modelOrId === "string" ? AI_MODELS[modelOrId] : modelOrId;
  if (!model) throw new Error(`Unknown model: ${String(modelOrId)}`);
  const modelId = model.id;

  const apiKey = ctx?.apiKey;
  const fetchFn = ctx ? (buildProxyFetch(ctx.proxy) ?? undefined) : undefined;

  switch (model.provider) {
    case "openai":
      // gpt-image-1.5 + gpt-image-2 (последний — fallback на прямую OpenAI Images API
      // когда KIE и evolink недоступны; primary для gpt-image-2 — KIE через case "kie").
      if (modelId === "gpt-image-1.5" || modelId === "gpt-image-2") {
        return new GptImageAdapter(modelId, apiKey, fetchFn);
      }
      return new DalleAdapter(apiKey, fetchFn);
    case "fal":
      return new FalAdapter(modelId, apiKey, fetchFn, model.providerModelId);
    case "recraft":
      return new RecraftAdapter(modelId, apiKey, fetchFn);
    case "replicate":
      return new ReplicateAdapter(modelId, apiKey, fetchFn, model.providerModelId);
    case "google":
      // Imagen 4 — use Replicate mirror until direct API is available
      return new ReplicateAdapter(modelId, apiKey, fetchFn, model.providerModelId);
    case "higgsfield":
      // higgsfield использует пару apiKey + apiSecret. Из пула приходит один
      // apiKey — apiSecret берётся из env (отдельный секрет, не часть пула).
      return new HiggsFieldSoulImageAdapter(apiKey, undefined, fetchFn);
    case "kie":
      return new KieImageAdapter(modelId, apiKey, fetchFn);
    case "evolink":
      return new EvolinkImageAdapter(modelId, apiKey, fetchFn);
    default:
      throw new Error(`No image adapter for provider: ${model.provider} (model: ${modelId})`);
  }
}
