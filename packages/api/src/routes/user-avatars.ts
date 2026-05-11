import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { userAvatarService } from "../services/user-avatar.service.js";
import { userStateService } from "../services/user-state.service.js";
import { getFileUrl } from "../services/s3.service.js";
import { config, getT } from "@metabox/shared";
import type { Language } from "@metabox/shared";
import { db } from "../db.js";
import { usdToTokens } from "../services/token.service.js";

/** Должна совпадать со значениями в bot/scenes/video.ts и worker/processors/avatar.processor.ts. */
const SOUL_COST_USD = 2.5;

type AuthRequest = FastifyRequest & { userId: bigint };

export const userAvatarsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);

  /** GET /user-avatars?provider=heygen — list user avatars */
  fastify.get<{ Querystring: { provider?: string } }>("/user-avatars", async (request) => {
    const { userId } = request as AuthRequest;
    const { provider } = request.query;
    const avatars = await userAvatarService.list(userId, provider);
    return Promise.all(
      avatars.map(async (a) => {
        let previewUrl = a.previewUrl;
        if (previewUrl && !previewUrl.startsWith("http")) {
          previewUrl = await getFileUrl(previewUrl).catch(() => null);
        }
        return {
          id: a.id,
          provider: a.provider,
          name: a.name,
          externalId: a.externalId,
          previewUrl,
          status: a.status,
          createdAt: a.createdAt.toISOString(),
        };
      }),
    );
  });

  /**
   * POST /user-avatars/start-creation
   * Sets the bot FSM state to HEYGEN_AVATAR_PHOTO and sends a Telegram prompt.
   */
  fastify.post<{ Body: { provider: string } }>(
    "/user-avatars/start-creation",
    async (request, reply) => {
      const { userId } = request as AuthRequest;
      const { provider } = request.body ?? {};

      if (!provider) return reply.status(400).send({ error: "provider is required" });

      if (provider !== "heygen" && provider !== "higgsfield_soul") {
        return reply.status(400).send({ error: `Unsupported provider: ${provider}` });
      }

      const telegramChatId = Number(userId);

      if (provider === "higgsfield_soul") {
        await userStateService.setState(userId, "HIGGSFIELD_SOUL_PHOTO", "design");

        // Get user language for i18n
        const user = await db.user.findUnique({
          where: { id: userId },
          select: { language: true },
        });
        const t = getT((user?.language ?? "en") as Language);

        const soulCost = usdToTokens(SOUL_COST_USD).toFixed(0);
        await fetch(`https://api.telegram.org/bot${config.bot.token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: telegramChatId,
            text: t.video.soulCreatePrompt.replace("{cost}", soulCost),
            reply_markup: {
              inline_keyboard: [
                [{ text: t.video.soulCancelButton, callback_data: "soul_create_cancel" }],
              ],
            },
          }),
        });

        return { ok: true };
      }

      // HeyGen: set FSM state so the next photo triggers avatar creation
      await userStateService.setState(userId, "HEYGEN_AVATAR_PHOTO", "video");

      await fetch(`https://api.telegram.org/bot${config.bot.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: "📸 Отправьте фото, из которого хотите сделать аватар.",
          reply_markup: {
            inline_keyboard: [[{ text: "❌ Отмена", callback_data: "heygen_avatar_cancel" }]],
          },
        }),
      });

      return { ok: true };
    },
  );

  /** PATCH /user-avatars/:id — rename */
  fastify.patch<{ Params: { id: string }; Body: { name: string } }>(
    "/user-avatars/:id",
    async (request, reply) => {
      const { userId } = request as AuthRequest;
      const { id } = request.params;
      const { name } = request.body;
      if (!name?.trim()) return reply.status(400).send({ error: "name is required" });
      const updated = await userAvatarService.rename(id, userId, name.trim());
      if (!updated) return reply.status(404).send({ error: "Avatar not found" });
      return { ok: true };
    },
  );

  /** DELETE /user-avatars/:id */
  fastify.delete<{ Params: { id: string } }>("/user-avatars/:id", async (request, reply) => {
    const { userId } = request as AuthRequest;
    const { id } = request.params;
    const ok = await userAvatarService.delete(id, userId);
    if (!ok) return reply.status(404).send({ error: "Avatar not found" });
    return { ok: true };
  });
};
