import type { FastifyPluginAsync } from "fastify";
import type { Server, Socket } from "../utils/ws.js";
import socketioPlugin from "fastify-socket.io";
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

    // Юзеры без aibUserId (зарегистрированы на вебе, но не привязали TG) в room
    // не попадают — у них нет генераций. Если понадобится — отдельный
    // metaboxUserRoom().
    if (aibUserId !== null) {
      void socket.join(userRoom(aibUserId));

      void webNotificationService
        .listByUser(aibUserId)
        .then((rows) => {
          socket.emit("notification:snapshot", rows.map(toWebNotificationDTO));
        })
        .catch((err) => {
          logger.warn(
            { err, aibUserId: aibUserId.toString() },
            "ws: notification snapshot failed",
          );
        });
    }

    socket.on("example:send", (msg) => {
      logger.info("we recieved message from client: " + msg.text);
      socket.emit("example:recieve", { text: "server recieved message from client" });
    });

    socket.on("notification:mark-seen", (msg) => {
      if (aibUserId === null) return;
      void webNotificationService.markAsSeen(msg.ids, aibUserId).catch((err) => {
        logger.warn({ err, ids: msg.ids }, "ws: notification:mark-seen failed");
      });
    });

    socket.on("notification:delete", (msg) => {
      if (aibUserId === null) return;
      void webNotificationService.delete(msg.id, aibUserId).catch((err) => {
        logger.warn({ err, id: msg.id }, "ws: notification:delete failed");
      });
    });
  });

  // just example of how to emit message to client
  fastify.get("/ws/hello", { schema: { hide: true } }, async (_request, reply) => {
    fastify.io.emit("example:recieve", { text: "callback message from server" });
    return reply.status(200).send({ ok: true });
  });
};
