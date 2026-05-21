import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import {
  patchDialogModelSettingsBodySchema,
  patchModelSettingsBodySchema,
} from "@metabox/shared-browser/dto";
import { webTelegramLinkedPreHandler } from "../middlewares/web-auth.js";
import { userStateService } from "../services/user-state.service.js";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";

/**
 * Web-зеркало `model-settings.ts`: те же три ресурса, но под JWT-auth
 * (`webTelegramLinkedPreHandler`) и префиксом `/web/`. Хранилище и бизнес-логика
 * переиспользуют `userStateService` — `user_states.modelSettings` ключуется
 * `User.id` (= `aibUserId` в web-сессии), поэтому веб и Telegram мини-аппа
 * пишут в одни и те же записи.
 *
 * Без `aibUserId` сохранять некуда → `webTelegramLinkedPreHandler` гейтит
 * web-юзеров без привязанного Telegram (403 TELEGRAM_NOT_LINKED).
 */

function aibUserIdOf(request: FastifyRequest): bigint {
  // Гарантировано после `webTelegramLinkedPreHandler` — здесь только narrowing.
  return request.webUser!.aibUserId!;
}

export const webModelSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", webTelegramLinkedPreHandler);
  fastify.addHook("onRoute", (params) =>
    constructOpenAPIonRouteHook(params, ["web-model-settings"]),
  );

  /** GET /web/model-settings — returns `{ [modelId | "dialog:<id>"]: { [key]: value } }`. */
  fastify.get(
    "/web/model-settings",
    {
      schema: {
        description: "Get user's model settings (web JWT)",
        response: { 200: { type: "object", additionalProperties: true } },
      },
    },
    async (request) => userStateService.getModelSettings(aibUserIdOf(request)),
  );

  /**
   * PATCH /web/model-settings — persist settings for a specific model.
   * Default: deep jsonb-merge. `replace: true` → весь объект `modelId` заменяется
   * содержимым `settings` (используется flow «Apply settings» из галереи).
   */
  fastify.patch(
    "/web/model-settings",
    {
      schema: {
        description: "Update or replace model settings (web JWT)",
        body: {
          type: "object",
          properties: {
            modelId: { type: "string", description: "Model ID" },
            settings: { type: "object", description: "Settings object" },
            replace: { type: "boolean", description: "Replace all settings instead of merge" },
          },
          required: ["modelId", "settings"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { success: { type: "boolean" } },
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const parsed = patchModelSettingsBodySchema.safeParse(request.body);
      if (!parsed.success) {
        await reply.status(400).send({ error: parsed.error.message });
        return;
      }
      const { modelId, settings, replace } = parsed.data;
      const userId = aibUserIdOf(request);
      request.log.info(
        { userId: userId.toString(), modelId, settings, replace: !!replace },
        "[web-model-settings] PATCH",
      );
      await userStateService.setModelSettings(userId, modelId, settings, { replace: !!replace });
      return { success: true };
    },
  );

  /** GET /web/model-settings/dialog/:dialogId — returns dialog-level overrides. */
  fastify.get<{ Params: { dialogId: string } }>(
    "/web/model-settings/dialog/:dialogId",
    {
      schema: {
        description: "Get dialog-level model settings (web JWT)",
        params: {
          type: "object",
          properties: { dialogId: { type: "string", description: "Dialog ID" } },
          required: ["dialogId"],
        },
        response: { 200: { type: "object", additionalProperties: true } },
      },
    },
    async (request) =>
      userStateService.getDialogSettings(aibUserIdOf(request), request.params.dialogId),
  );

  /** PATCH /web/model-settings/dialog/:dialogId — merge dialog-level settings. */
  fastify.patch<{ Params: { dialogId: string } }>(
    "/web/model-settings/dialog/:dialogId",
    {
      schema: {
        description: "Update dialog-level model settings (web JWT)",
        params: {
          type: "object",
          properties: { dialogId: { type: "string", description: "Dialog ID" } },
          required: ["dialogId"],
        },
        body: {
          type: "object",
          properties: { settings: { type: "object", description: "Settings object" } },
          required: ["settings"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { success: { type: "boolean" } },
          },
          400: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const parsed = patchDialogModelSettingsBodySchema.safeParse(request.body);
      if (!parsed.success) {
        await reply.status(400).send({ error: parsed.error.message });
        return;
      }
      await userStateService.setDialogSettings(
        aibUserIdOf(request),
        request.params.dialogId,
        parsed.data.settings,
      );
      return { success: true };
    },
  );
};
