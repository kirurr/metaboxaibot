import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { telegramAuthHook } from "../middlewares/telegram-auth.js";
import { dialogService } from "../services/dialog.service.js";
import { userStateService } from "../services/user-state.service.js";
import { getFileUrl } from "../services/s3.service.js";
import { db } from "../db.js";
import {
  getT,
  buildDialogHint,
  AI_MODELS,
  config,
  generateWebToken,
  type Section,
} from "@metabox/shared";
import type { Language } from "@metabox/shared";

type AuthRequest = FastifyRequest & { userId: bigint };

export const dialogsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", telegramAuthHook);

  /** GET /dialogs?section=gpt — list active dialogs */
  fastify.get<{ Querystring: { section?: string } }>("/dialogs", async (request) => {
    const { userId } = request as AuthRequest;
    const section = request.query.section as Section | undefined;

    const dialogs = await dialogService.listByUser(userId, section);
    return dialogs.map((d) => ({
      id: d.id,
      section: d.section,
      modelId: d.modelId,
      title: d.title ?? null,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    }));
  });

  /** POST /dialogs — create new dialog */
  fastify.post<{ Body: { section: string; modelId: string; title?: string } }>(
    "/dialogs",
    async (request, reply) => {
      const { userId } = request as AuthRequest;
      const { section, modelId, title } = request.body;

      if (!section || !modelId) {
        return reply.code(400).send({ error: "section and modelId are required" });
      }

      const dialog = await dialogService.create({
        userId,
        section: section as Section,
        modelId,
        title,
      });

      return {
        id: dialog.id,
        section: dialog.section,
        modelId: dialog.modelId,
        title: dialog.title ?? null,
        createdAt: dialog.createdAt.toISOString(),
        updatedAt: dialog.updatedAt.toISOString(),
      };
    },
  );

  /** PATCH /dialogs/:id — rename */
  fastify.patch<{ Params: { id: string }; Body: { title: string } }>(
    "/dialogs/:id",
    async (request, reply) => {
      const { userId } = request as AuthRequest;
      const { id } = request.params;
      const { title } = request.body;

      if (!title) return reply.code(400).send({ error: "title is required" });

      // Verify ownership
      const dialog = await dialogService.findById(id);
      if (!dialog) return reply.code(404).send({ error: "Dialog not found" });
      if (dialog.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

      const updated = await dialogService.rename(id, title);
      return { id: updated.id, title: updated.title };
    },
  );

  /** DELETE /dialogs/:id — soft delete */
  fastify.delete<{ Params: { id: string } }>("/dialogs/:id", async (request, reply) => {
    const { userId } = request as AuthRequest;
    const { id } = request.params;

    const dialog = await dialogService.findById(id);
    if (!dialog) return reply.code(404).send({ error: "Dialog not found" });
    if (dialog.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

    await dialogService.softDelete(id, userId);

    return { success: true };
  });

  /** POST /dialogs/:id/activate — set as active dialog */
  fastify.post<{ Params: { id: string } }>("/dialogs/:id/activate", async (request, reply) => {
    const { userId } = request as AuthRequest;
    const { id } = request.params;

    const dialog = await dialogService.findById(id);
    if (!dialog) return reply.code(404).send({ error: "Dialog not found" });
    if (dialog.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

    const state = await userStateService.get(userId);

    if (state?.gptDialogId === dialog.id && state.state === "GPT_ACTIVE") {
      return { success: true };
    }

    await userStateService.setDialogForSection(userId, dialog.section as Section, id);

    // Notify user in chat (fire-and-forget)
    sendDialogSelectedNotification(userId, dialog.title, dialog.modelId).catch(() => void 0);

    return { success: true };
  });

  /** GET /dialogs/:id/messages — message history */
  fastify.get<{ Params: { id: string } }>("/dialogs/:id/messages", async (request, reply) => {
    const { userId } = request as AuthRequest;
    const { id } = request.params;

    const dialog = await dialogService.findById(id);
    if (!dialog) return reply.code(404).send({ error: "Dialog not found" });
    if (dialog.userId !== userId) return reply.code(403).send({ error: "Forbidden" });

    const messages = await dialogService.getMessages(id);

    // Resolve S3 keys to presigned URLs (S3 keys don't start with "http")
    const resolvedMessages = await Promise.all(
      messages.map(async (m) => {
        let mediaUrl = m.mediaUrl ?? null;
        if (mediaUrl && !mediaUrl.startsWith("http")) {
          mediaUrl = (await getFileUrl(mediaUrl)) ?? mediaUrl;
        }
        const rawAttachments = Array.isArray(m.attachments)
          ? (m.attachments as unknown as Array<{
              s3Key: string;
              mimeType: string;
              name: string;
              size?: number;
            }>)
          : [];
        const attachments = await Promise.all(
          rawAttachments.map(async (a) => ({
            ...a,
            previewUrl: (await getFileUrl(a.s3Key)) ?? undefined,
          })),
        );
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          mediaUrl,
          mediaType: m.mediaType ?? null,
          attachments: attachments.length ? attachments : undefined,
          createdAt: m.createdAt.toISOString(),
        };
      }),
    );

    return resolvedMessages;
  });
};

async function sendDialogSelectedNotification(
  userId: bigint,
  title: string | null,
  modelId: string,
): Promise<void> {
  if (!config.bot.token) return;

  const [user, botState] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { language: true } }),
    userStateService.get(userId),
  ]);
  const t = getT((user?.language ?? "en") as Language);
  const modelFull = AI_MODELS[modelId]?.name ?? modelId;
  const spaceIdx = modelFull.indexOf(" ");
  const modelIcon = spaceIdx > 0 ? modelFull.slice(0, spaceIdx + 1) : "";
  const modelNameOnly = spaceIdx > 0 ? modelFull.slice(spaceIdx + 1) : modelFull;
  const dialogLabel = title ?? modelId;

  const alreadyInGpt = botState?.section === "gpt";

  // Activate GPT section in bot state if not already there
  if (!alreadyInGpt) {
    await Promise.all([
      userStateService.setState(userId, "GPT_ACTIVE", "gpt"),
      userStateService.setGptModel(userId, modelId),
    ]);

    const webappUrl = config.bot.webappUrl;
    const token = webappUrl ? generateWebToken(userId, config.bot.token) : "";
    const newDialogBtn = webappUrl
      ? {
          text: t.gpt.newDialog,
          web_app: { url: `${webappUrl}?page=management&section=gpt&action=new&wtoken=${token}` },
        }
      : { text: t.gpt.newDialog };
    const managementBtn = webappUrl
      ? {
          text: t.gpt.management,
          web_app: { url: `${webappUrl}?page=management&section=gpt&wtoken=${token}` },
        }
      : { text: t.gpt.management };

    const model = AI_MODELS[modelId];
    const confirmText = t.gpt.dialogSelected
      .replace("{title}", dialogLabel)
      .replace("{modelIcon}", modelIcon)
      .replace("{modelName}", modelNameOnly);

    const hint = buildDialogHint(t, model);
    const fullText = hint
      ? `${t.gpt.sectionTitle}\n\n${confirmText}\n\n${hint}`
      : `${t.gpt.sectionTitle}\n\n${confirmText}`;

    await fetch(`https://api.telegram.org/bot${config.bot.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(userId),
        text: fullText,
        parse_mode: "HTML",
        reply_markup: {
          keyboard: [[newDialogBtn], [managementBtn], [{ text: t.common.backToMain }]],
          resize_keyboard: true,
          is_persistent: true,
        },
      }),
    });
    return;
  }

  // Always send dialog-selected confirmation + capability hints
  const model = AI_MODELS[modelId];
  const confirmText = t.gpt.dialogSelected
    .replace("{title}", dialogLabel)
    .replace("{modelIcon}", modelIcon)
    .replace("{modelName}", modelNameOnly);

  const hint = buildDialogHint(t, model);
  const fullText = hint ? `${confirmText}\n\n${hint}` : confirmText;

  await fetch(`https://api.telegram.org/bot${config.bot.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: String(userId), text: fullText, parse_mode: "HTML" }),
  });
}
