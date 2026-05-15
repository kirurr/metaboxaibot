/**
 * /web/user-avatars/* — управление пользовательскими аватарами через web-приложение.
 *
 * Поддерживаемые провайдеры:
 *  - heygen: синхронный flow — фронт загружает фото через /web/chat-uploads,
 *    шлёт s3Key сюда → мы качаем буфер, идём в HeyGen `/v3/assets` (там аплоад
 *    синхронный), возвращаем готовый avatar (`status="ready"`, externalId=asset_id).
 *  - higgsfield_soul: ЗАГЛУШКА — фронт шлёт массив s3Keys, мы создаём запись
 *    в `status="creating"` с сохранёнными `sourceS3Keys`. Worker-джоба
 *    (обучение Soul-персонажа + поллинг) будет реализована отдельным разработчиком;
 *    он подхватит pending-записи через `sourceS3Keys` и отправит в Higgsfield API.
 *
 * Все routes — под `webTelegramLinkedPreHandler` (нужна и авторизация и
 * привязанный Telegram, потому что HeyGen-ключ берётся из общего пула).
 */

import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { webTelegramLinkedPreHandler } from "../middlewares/web-auth.js";
import { userAvatarService } from "../services/user-avatar.service.js";
import { acquireKey } from "../services/key-pool.service.js";
import { PoolExhaustedError } from "../utils/pool-exhausted-error.js";
import {
  getFileUrl,
  downloadBuffer,
  uploadBuffer,
  generateThumbnail,
} from "../services/s3.service.js";
import { HeyGenAvatarAdapter } from "../ai/avatar/heygen.avatar.adapter.js";
import { getAvatarQueue } from "../queues/avatar.queue.js";
import { logger } from "../logger.js";
import { badRequestResponse, constructOpenAPIonRouteHook } from "../utils/openapi.js";

/** Минимум фото для обучения Higgsfield Soul-персонажа. Зеркалит бот-логику
 *  (см. `packages/bot/src/scenes/video.ts` SOUL_MIN_PHOTOS). */
const SOUL_MIN_PHOTOS = 10;
const SOUL_MAX_PHOTOS = 30;

type AvatarDto = {
  id: string;
  provider: string;
  name: string;
  externalId: string | null;
  previewUrl: string | null;
  status: string;
  createdAt: string;
};

async function buildAvatarDto(a: {
  id: string;
  provider: string;
  name: string;
  externalId: string | null;
  previewUrl: string | null;
  status: string;
  createdAt: Date;
}): Promise<AvatarDto> {
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
}

/** Гейт: s3Key должен лежать в собственной папке юзера, иначе разрешим воровать
 *  чужие файлы через подмену ключа в запросе. */
function isOwnedKey(s3Key: string, aibUserId: bigint): boolean {
  return s3Key.startsWith(`chat-uploads/${aibUserId.toString()}/`);
}

export const webUserAvatarsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("preHandler", webTelegramLinkedPreHandler);
  fastify.addHook("onRoute", (params) => constructOpenAPIonRouteHook(params, ["web-user-avatars"]));

  // ── GET /web/user-avatars?provider=heygen|higgsfield_soul ────────────────────
  fastify.get<{ Querystring: { provider?: string } }>(
    "/web/user-avatars",
    {
      schema: {
        description: "List current user's avatars, optionally filtered by provider",
        querystring: {
          type: "object",
          properties: {
            provider: { type: "string", enum: ["heygen", "higgsfield_soul"] },
          },
        },
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                id: { type: "string" },
                provider: { type: "string" },
                name: { type: "string" },
                externalId: { type: "string", nullable: true },
                previewUrl: { type: "string", nullable: true },
                status: { type: "string" },
                createdAt: { type: "string" },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { aibUserId } = request.webUser!;
      const list = await userAvatarService.list(aibUserId!, request.query.provider);
      return Promise.all(list.map(buildAvatarDto));
    },
  );

  // ── POST /web/user-avatars/heygen ─────────────────────────────────────────────
  // Body: { s3Key, name? }. Synchronous: 1) скачиваем фото из S3,
  // 2) acquireKey("heygen"), 3) adapter.create() → asset_id,
  // 4) thumbnail в S3, 5) UserAvatar в БД со status="ready".
  fastify.post<{ Body: { s3Key?: string; name?: string } }>(
    "/web/user-avatars/heygen",
    {
      schema: {
        description: "Create a HeyGen avatar from an already-uploaded photo (synchronous)",
        body: {
          type: "object",
          properties: {
            s3Key: { type: "string", description: "s3Key from /web/chat-uploads" },
            name: { type: "string" },
          },
          required: ["s3Key"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              id: { type: "string" },
              provider: { type: "string" },
              name: { type: "string" },
              externalId: { type: "string", nullable: true },
              previewUrl: { type: "string", nullable: true },
              status: { type: "string" },
              createdAt: { type: "string" },
            },
          },
          400: badRequestResponse,
          403: badRequestResponse,
          502: badRequestResponse,
          503: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { aibUserId } = request.webUser!;
      const { s3Key, name } = request.body ?? {};

      if (!s3Key) return reply.code(400).send({ error: "s3Key is required" });
      if (!isOwnedKey(s3Key, aibUserId!)) {
        return reply.code(403).send({ error: "s3Key does not belong to current user" });
      }

      // 1. Скачиваем буфер. Сюда же определим content-type (по расширению ключа —
      //    chat-uploads хранит файлы с правильным mime, но S3 GET не возвращает
      //    его обратно, поэтому мапим расширение → mime).
      const buffer = await downloadBuffer(s3Key);
      if (!buffer) {
        return reply.code(400).send({ error: "Failed to fetch source image from S3" });
      }
      const ext = s3Key.split(".").pop()?.toLowerCase() ?? "jpg";
      const contentType =
        ext === "png"
          ? "image/png"
          : ext === "webp"
            ? "image/webp"
            : ext === "gif"
              ? "image/gif"
              : "image/jpeg";

      // 2. Берём HeyGen-ключ из пула.
      let acquired;
      try {
        acquired = await acquireKey("heygen");
      } catch (err) {
        if (err instanceof PoolExhaustedError) {
          return reply.code(503).send({ error: "HeyGen pool exhausted, try again later" });
        }
        throw err;
      }

      // 3. Синхронный аплоад asset'а в HeyGen → externalId.
      let externalId: string;
      try {
        const adapter = new HeyGenAvatarAdapter(acquired.apiKey);
        const result = await adapter.create(buffer, contentType);
        externalId = result.externalId;
      } catch (err) {
        logger.warn({ err, s3Key }, "[web user-avatars heygen] create failed");
        return reply.code(502).send({
          error: err instanceof Error ? err.message : "HeyGen create failed",
        });
      }

      // 4. Превью (best-effort) — webp thumbnail в S3 под выделенным префиксом.
      let previewS3Key: string | undefined;
      const thumb = await generateThumbnail(buffer, contentType).catch(() => null);
      if (thumb) {
        const key = `avatar_photo/${aibUserId!.toString()}/${randomUUID()}_thumb.webp`;
        const uploaded = await uploadBuffer(key, thumb, "image/webp").catch(() => null);
        if (uploaded) previewS3Key = key;
      }

      // 5. Persist.
      const avatar = await userAvatarService.create(aibUserId!, {
        provider: "heygen",
        name: name?.trim() || "Мой аватар",
        externalId,
        status: "ready",
        previewUrl: previewS3Key,
        providerKeyId: acquired.keyId,
      });

      logger.info(
        {
          avatarId: avatar.id,
          externalId,
          keyId: acquired.keyId,
          aibUserId: aibUserId!.toString(),
        },
        "[web user-avatars heygen] created",
      );

      return buildAvatarDto(avatar);
    },
  );

  // ── POST /web/user-avatars/higgsfield-soul ────────────────────────────────────
  // ЗАГЛУШКА: создаём pending-запись с массивом исходных s3Keys.
  // Worker-джоба (отправка в Higgsfield Soul + поллинг + апдейт статуса в "ready")
  // будет реализована отдельным разработчиком. Он подхватит pending-записи
  // через `userAvatar.sourceS3Keys`.
  fastify.post<{ Body: { s3Keys?: string[]; name?: string } }>(
    "/web/user-avatars/higgsfield-soul",
    {
      schema: {
        description:
          "Create a Higgsfield Soul avatar pending-record (STUB — worker job is implemented separately)",
        body: {
          type: "object",
          properties: {
            s3Keys: {
              type: "array",
              items: { type: "string" },
              minItems: SOUL_MIN_PHOTOS,
              maxItems: SOUL_MAX_PHOTOS,
              description: `Source photo s3Keys from /web/chat-uploads (${SOUL_MIN_PHOTOS}-${SOUL_MAX_PHOTOS} items)`,
            },
            name: { type: "string" },
          },
          required: ["s3Keys"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              id: { type: "string" },
              provider: { type: "string" },
              name: { type: "string" },
              externalId: { type: "string", nullable: true },
              previewUrl: { type: "string", nullable: true },
              status: { type: "string" },
              createdAt: { type: "string" },
            },
          },
          400: badRequestResponse,
          403: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { aibUserId } = request.webUser!;
      const { s3Keys, name } = request.body ?? {};

      if (!Array.isArray(s3Keys) || s3Keys.length < SOUL_MIN_PHOTOS) {
        return reply.code(400).send({ error: `Need at least ${SOUL_MIN_PHOTOS} source photos` });
      }
      if (s3Keys.length > SOUL_MAX_PHOTOS) {
        return reply.code(400).send({ error: `No more than ${SOUL_MAX_PHOTOS} photos` });
      }
      for (const k of s3Keys) {
        if (!isOwnedKey(k, aibUserId!)) {
          return reply.code(403).send({ error: "One or more s3Keys do not belong to user" });
        }
      }

      // Превью — thumbnail из первого фото (best-effort).
      let previewS3Key: string | undefined;
      try {
        const firstBuf = await downloadBuffer(s3Keys[0]);
        if (firstBuf) {
          const firstExt = s3Keys[0].split(".").pop()?.toLowerCase() ?? "jpg";
          const ct =
            firstExt === "png" ? "image/png" : firstExt === "webp" ? "image/webp" : "image/jpeg";
          const thumb = await generateThumbnail(firstBuf, ct);
          if (thumb) {
            const key = `avatar_photo/${aibUserId!.toString()}/${randomUUID()}_thumb.webp`;
            const uploaded = await uploadBuffer(key, thumb, "image/webp").catch(() => null);
            if (uploaded) previewS3Key = key;
          }
        }
      } catch {
        // ignore preview failure — pending-запись всё равно создаём
      }

      const avatar = await userAvatarService.create(aibUserId!, {
        provider: "higgsfield_soul",
        name: name?.trim() || "Мой soul-персонаж",
        status: "creating",
        previewUrl: previewS3Key,
        sourceS3Keys: s3Keys,
      });

      // Enqueue Soul-creation. `telegramChatId: null` маркирует web-источник —
      // worker по этому флагу шлёт WS-уведомление через apiNotify вместо
      // telegram.sendMessage (см. packages/worker/src/processors/avatar.processor.ts).
      await getAvatarQueue().add("create", {
        userAvatarId: avatar.id,
        userId: aibUserId!.toString(),
        provider: "higgsfield_soul",
        action: "create",
        s3Keys,
        characterName: avatar.name,
        telegramChatId: null,
      });

      logger.info(
        {
          avatarId: avatar.id,
          photoCount: s3Keys.length,
          aibUserId: aibUserId!.toString(),
        },
        "[web user-avatars soul] pending record created + Soul-create enqueued",
      );

      return buildAvatarDto(avatar);
    },
  );

  // ── PATCH /web/user-avatars/:id ─────────────────────────────────────────────
  fastify.patch<{ Params: { id: string }; Body: { name?: string } }>(
    "/web/user-avatars/:id",
    {
      schema: {
        description: "Rename an avatar",
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { ok: { type: "boolean" } },
          },
          400: badRequestResponse,
          404: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { aibUserId } = request.webUser!;
      const { id } = request.params;
      const name = request.body?.name?.trim();
      if (!name) return reply.code(400).send({ error: "name is required" });
      const updated = await userAvatarService.rename(id, aibUserId!, name);
      if (!updated) return reply.code(404).send({ error: "Avatar not found" });
      return { ok: true };
    },
  );

  // ── DELETE /web/user-avatars/:id ────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    "/web/user-avatars/:id",
    {
      schema: {
        description: "Delete an avatar",
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: { ok: { type: "boolean" } },
          },
          404: badRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const { aibUserId } = request.webUser!;
      const ok = await userAvatarService.delete(request.params.id, aibUserId!);
      if (!ok) return reply.code(404).send({ error: "Avatar not found" });
      return { ok: true };
    },
  );
};
