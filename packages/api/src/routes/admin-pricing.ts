/**
 * Admin REST endpoints для runtime price overrides.
 *
 * Auth: ADMIN-роль или legacy x-admin-secret (тот же шаблон, что admin-keys.ts).
 *
 * Cache invalidation: после любой write-операции вызываем broadcastInvalidation()
 * чтобы все API/worker инстансы перезагрузили кеш в течение ~ms (Redis pubsub).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AI_MODELS, config } from "@metabox/shared";
import { db } from "../db.js";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { extractWebUserFromRequest } from "../middlewares/web-auth.js";
import {
  broadcastInvalidation,
  getAllOverrides,
  getModelMultiplier,
} from "../services/pricing-config.service.js";
import { calculateCost } from "../services/token.service.js";
import { constructOpenAPIonRouteHook, badRequestResponse } from "../utils/openapi.js";

type AuthRequest = { userId: bigint };

type SetMultiplierBody = { multiplier?: number; note?: string | null };

const TYPICAL_INPUT_TOKENS = 500;
const TYPICAL_OUTPUT_TOKENS = 500;

function validateMultiplier(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0 || value > 10) return null;
  return value;
}

interface ModelPricingDto {
  id: string;
  name: string;
  section: string;
  provider: string;
  isLLM: boolean;
  baseTokens: number; // tokens без применения multiplier (multiplier=1)
  effectiveTokens: number; // tokens с применённым multiplier
  multiplier: number; // 1.0 если override отсутствует
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

function modelToDto(modelId: string): ModelPricingDto | null {
  const m = AI_MODELS[modelId];
  if (!m) return null;
  const isLLM = m.inputCostUsdPerMToken > 0;
  const effective = isLLM
    ? calculateCost(m, TYPICAL_INPUT_TOKENS, TYPICAL_OUTPUT_TOKENS)
    : calculateCost(m);
  // calculateCost умножает на текущий multiplier и делает Math.ceil. Чтобы показать
  // «базу», делим обратно. Если multiplier=1, base = effective.
  const multiplier = getModelMultiplier(m.id);
  const baseTokens = multiplier === 1 ? effective : Math.round(effective / multiplier);

  const overrides = getAllOverrides();
  const entry = overrides.models[m.id] ?? null;

  return {
    id: m.id,
    name: m.name,
    section: m.section,
    provider: m.provider,
    isLLM,
    baseTokens,
    effectiveTokens: effective,
    multiplier,
    note: entry?.note ?? null,
    updatedBy: entry?.updatedBy ?? null,
    updatedAt: entry?.updatedAt ?? null,
  };
}

export async function adminPricingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook("onRoute", (routeOptions) =>
    constructOpenAPIonRouteHook(routeOptions, ["admin-pricing"]),
  );

  // ── Auth preHandler — копия из admin-keys.ts, чтобы не вводить общий хелпер
  //    ради двух мест (см. там же для деталей).
  fastify.addHook("preHandler", async (request, reply) => {
    const secret = config.api.adminSecret;
    const provided = request.headers["x-admin-secret"];
    if (secret && provided === secret) return;

    const authHeader = request.headers.authorization ?? "";
    let userId: bigint | null = null;

    if (authHeader.startsWith("Bearer ")) {
      const webUser = await extractWebUserFromRequest(request);
      if (!webUser || webUser.aibUserId === null) {
        await reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      userId = webUser.aibUserId;
    } else if (authHeader.startsWith("tma ") || authHeader.startsWith("wtoken ")) {
      try {
        await telegramAuthHook(request, reply);
      } catch {
        await reply.status(403).send({ error: "Forbidden" });
        return;
      }
      userId = (request as unknown as AuthRequest).userId ?? null;
      if (userId === null) return;
    } else {
      await reply.status(401).send({ error: "Unauthorized" });
      return;
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user || user.role !== "ADMIN") {
      await reply.status(403).send({ error: "Forbidden" });
    }
  });

  // ── Helpers для определения updatedBy ────────────────────────────────────
  async function resolveUpdatedBy(request: FastifyRequest): Promise<string | null> {
    const provided = request.headers["x-admin-secret"];
    if (provided && provided === config.api.adminSecret) return "x-admin-secret";
    const authHeader = request.headers.authorization ?? "";
    if (authHeader.startsWith("Bearer ")) {
      const webUser = await extractWebUserFromRequest(request);
      return webUser?.metaboxUserId ?? webUser?.aibUserId?.toString() ?? null;
    }
    const userId = (request as unknown as AuthRequest).userId;
    return userId !== undefined ? userId.toString() : null;
  }

  // ── GET /admin/pricing — full snapshot ───────────────────────────────────
  /**
   * GET /admin/pricing
   * Returns full pricing configuration snapshot with all model overrides.
   */
  fastify.get(
    "/admin/pricing",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              configDefault: { type: "number", description: "Default target margin" },
              global: {
                type: "object",
                nullable: true,
                properties: {
                  multiplier: { type: "number" },
                  note: { type: "string", nullable: true },
                  updatedBy: { type: "string", nullable: true },
                  updatedAt: { type: "string", nullable: true },
                },
              },
              models: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Model ID" },
                    name: { type: "string", description: "Model name" },
                    section: { type: "string", description: "Section (image, video, audio)" },
                    provider: { type: "string", description: "Provider name" },
                    isLLM: { type: "boolean", description: "Whether model is LLM" },
                    baseTokens: { type: "number", description: "Base tokens without multiplier" },
                    effectiveTokens: { type: "number", description: "Tokens with current multiplier" },
                    multiplier: { type: "number", description: "Current multiplier (1.0 = no override)" },
                    note: { type: "string", nullable: true, description: "Admin note" },
                    updatedBy: { type: "string", nullable: true, description: "Who updated" },
                    updatedAt: { type: "string", nullable: true, description: "Update timestamp" },
                  },
                  required: ["id", "name", "section", "provider", "isLLM", "baseTokens", "effectiveTokens", "multiplier", "note", "updatedBy", "updatedAt"],
                },
              },
            },
            required: ["configDefault", "global", "models"],
          },
        },
      },
    },
    async () => {
    const overrides = getAllOverrides();
    const models = Object.keys(AI_MODELS)
      .map(modelToDto)
      .filter((m): m is ModelPricingDto => m !== null);
    return {
      configDefault: config.billing.targetMargin,
      global: overrides.global,
      models,
    };
  });

  // ── PUT /admin/pricing/model/:id ─────────────────────────────────────────
  /**
   * PUT /admin/pricing/model/:id
   * Set or update multiplier for a specific model.
   */
  fastify.put<{ Params: { id: string }; Body: SetMultiplierBody }>(
    "/admin/pricing/model/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", description: "Model ID" },
          },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            multiplier: { type: "number", description: "Multiplier value (must be > 0 and <= 10)" },
            note: { type: "string", nullable: true, description: "Admin note" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              model: { type: "object" },
            },
            required: ["model"],
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!AI_MODELS[id]) {
        await reply.status(400).send({ error: `unknown modelId: ${id}` });
        return;
      }
      const value = validateMultiplier(request.body?.multiplier);
      if (value === null) {
        await reply.status(400).send({ error: "multiplier must be a number > 0 and <= 10" });
        return;
      }
      const updatedBy = await resolveUpdatedBy(request);
      await db.pricingOverride.upsert({
        where: { scope_key: { scope: "model", key: id } },
        create: {
          scope: "model",
          key: id,
          multiplier: value,
          note: request.body?.note ?? null,
          updatedBy,
        },
        update: {
          multiplier: value,
          note: request.body?.note ?? null,
          updatedBy,
        },
      });
      await broadcastInvalidation();
      return { model: modelToDto(id) };
    },
  );

  // ── DELETE /admin/pricing/model/:id ──────────────────────────────────────
  /**
   * DELETE /admin/pricing/model/:id
   * Remove multiplier override for a model.
   */
  fastify.delete<{ Params: { id: string } }>(
    "/admin/pricing/model/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            id: { type: "string", description: "Model ID" },
          },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              model: { type: "object" },
            },
            required: ["success", "model"],
          },
        },
      },
    },
    async (request) => {
    const { id } = request.params;
    // deleteMany — idempotent, не падает если записи нет.
    await db.pricingOverride.deleteMany({ where: { scope: "model", key: id } });
    await broadcastInvalidation();
    return { success: true, model: modelToDto(id) };
  });

  // ── PUT /admin/pricing/global — override targetMargin ────────────────────
  /**
   * PUT /admin/pricing/global
   * Set or update global targetMargin multiplier.
   */
  fastify.put<{ Body: SetMultiplierBody }>(
    "/admin/pricing/global",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            multiplier: { type: "number", description: "Multiplier value (must be > 0 and <= 10)" },
            note: { type: "string", nullable: true, description: "Admin note" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              global: { type: "object" },
              configDefault: { type: "number" },
            },
            required: ["global", "configDefault"],
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
    const value = validateMultiplier(request.body?.multiplier);
    if (value === null) {
      await reply.status(400).send({ error: "multiplier must be a number > 0 and <= 10" });
      return;
    }
    const updatedBy = await resolveUpdatedBy(request);
    await db.pricingOverride.upsert({
      where: { scope_key: { scope: "global", key: "targetMargin" } },
      create: {
        scope: "global",
        key: "targetMargin",
        multiplier: value,
        note: request.body?.note ?? null,
        updatedBy,
      },
      update: {
        multiplier: value,
        note: request.body?.note ?? null,
        updatedBy,
      },
    });
    await broadcastInvalidation();
    return { global: getAllOverrides().global, configDefault: config.billing.targetMargin };
  });

  // ── DELETE /admin/pricing/global ─────────────────────────────────────────
  /**
   * DELETE /admin/pricing/global
   * Remove global targetMargin override.
   */
  fastify.delete(
    "/admin/pricing/global",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              configDefault: { type: "number" },
            },
            required: ["success", "configDefault"],
          },
        },
      },
    },
    async () => {
    await db.pricingOverride.deleteMany({
      where: { scope: "global", key: "targetMargin" },
    });
    await broadcastInvalidation();
    return { success: true, configDefault: config.billing.targetMargin };
  });
}
