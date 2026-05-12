import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { userStateService } from "../services/user-state.service.js";

type AuthRequest = FastifyRequest & { userId: bigint };

export const modelSettingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);

  /** GET /model-settings — returns { [modelId]: { [key]: value } } */
  fastify.get("/model-settings", async (request) => {
    const { userId } = request as AuthRequest;
    return userStateService.getModelSettings(userId);
  });

  /**
   * PATCH /model-settings — persist settings for a specific model.
   *
   * Default: deep jsonb-merge (existing keys survive; only listed keys update).
   * When `replace: true`: the stored object for this modelId is entirely
   * replaced by `settings`. Used by the gallery's "Apply settings" flow so
   * the user's saved config matches the viewed generation exactly — without
   * stale per-key overrides leaking through the merge.
   */
  fastify.patch<{
    Body: { modelId: string; settings: Record<string, unknown>; replace?: boolean };
  }>("/model-settings", async (request) => {
    const { userId } = request as AuthRequest;
    const { modelId, settings, replace } = request.body;
    if (!modelId || typeof settings !== "object" || settings === null) {
      throw { statusCode: 400, message: "modelId and settings object are required" };
    }
    request.log.info(
      { userId: userId.toString(), modelId, settings, replace: !!replace },
      "[model-settings] PATCH",
    );
    await userStateService.setModelSettings(userId, modelId, settings, { replace: !!replace });
    return { success: true };
  });

  /** GET /model-settings/dialog/:dialogId — returns dialog-level overrides */
  fastify.get<{ Params: { dialogId: string } }>(
    "/model-settings/dialog/:dialogId",
    async (request) => {
      const { userId } = request as AuthRequest;
      const { dialogId } = request.params;
      return userStateService.getDialogSettings(userId, dialogId);
    },
  );

  /** PATCH /model-settings/dialog/:dialogId — merge dialog-level settings */
  fastify.patch<{ Params: { dialogId: string }; Body: { settings: Record<string, unknown> } }>(
    "/model-settings/dialog/:dialogId",
    async (request) => {
      const { userId } = request as AuthRequest;
      const { dialogId } = request.params;
      const { settings } = request.body;
      if (typeof settings !== "object" || settings === null) {
        throw { statusCode: 400, message: "settings object is required" };
      }
      await userStateService.setDialogSettings(userId, dialogId, settings);
      return { success: true };
    },
  );
};
