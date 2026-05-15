import type { FastifyPluginAsync } from "fastify";
import type { Server, Socket } from "../utils/ws.js";
import socketioPlugin from "fastify-socket.io";
import { notificationMarkSeenEvent, notificationDeleteEvent } from "@metabox/shared-browser/ws";
import { logger } from "../logger.js";
import { wsAuthMiddleware } from "../middlewares/ws-auth.js";
import { setWsServer, userRoom } from "../services/ws-bus.service.js";
import {
  webNotificationService,
  toWebNotificationDTO,
} from "../services/web-notification.service.js";

// Module redeclarations for websocket type safety
declare module "fastify" {
  interface FastifyInstance {
    io: Server;
  }
}

export const wsRoutes: FastifyPluginAsync = async (fastify) => {
  // fastify-socket.io is a CJS module; cast required under NodeNext module resolution
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await fastify.register(socketioPlugin as any, {
    cors: { origin: true, credentials: true },
  });

  fastify.io.use(wsAuthMiddleware);
  setWsServer(fastify.io);

  fastify.io.on("connection", (socket: Socket) => {
    const { metaboxUserId, aibUserId } = socket.data.webUser;
    logger.info({ metaboxUserId }, "ws connection established");

    // ── Регистрация client→server хендлеров (синхронно, до любого await) ──
    socket.on("notification:mark-seen", (raw) => {
      const parsed = notificationMarkSeenEvent.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ err: parsed.error.flatten(), raw }, "ws: bad notification:mark-seen payload");
        return;
      }
      if (aibUserId === null) return;
      void webNotificationService.markAsSeen(parsed.data.ids, aibUserId).catch((err) => {
        logger.warn({ err, ids: parsed.data.ids }, "ws: notification:mark-seen failed");
      });
    });

    socket.on("notification:delete", (raw) => {
      const parsed = notificationDeleteEvent.safeParse(raw);
      if (!parsed.success) {
        logger.warn({ err: parsed.error.flatten(), raw }, "ws: bad notification:delete payload");
        return;
      }
      if (aibUserId === null) return;
      void webNotificationService.delete(parsed.data.id, aibUserId).catch((err) => {
        logger.warn({ err, id: parsed.data.id }, "ws: notification:delete failed");
      });
    });

    // ── Снимок уведомлений ─────────────────────────────────────────────────
    // join обязательно AWAIT'ить ДО listByUser: между «вызвал join» и
    // «join завершился» с Redis-adapter'ом окно реальное, и notification:new,
    // прилетевший в это окно, не попал бы ни в snapshot (DB читали раньше),
    // ни в emit (комнаты с сокетом ещё нет). Юзеры без aibUserId не имеют
    // генераций — пропускаем целиком.
    if (aibUserId !== null) {
      void (async () => {
        try {
          await socket.join(userRoom(aibUserId));
          const rows = await webNotificationService.listByUser(aibUserId);
          socket.emit("notification:snapshot", rows.map(toWebNotificationDTO));
        } catch (err) {
          logger.warn({ err, aibUserId: aibUserId.toString() }, "ws: notification snapshot failed");
        }
      })();
    }
  });
};
