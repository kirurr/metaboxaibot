import type { FastifyPluginAsync } from "fastify";
import type { Server as SocketIOServer, Socket as SocketIOSocket } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@metabox/shared-browser";
import socketioPlugin from "fastify-socket.io";
import { logger } from "../logger.js";

type Server = SocketIOServer<ClientToServerEvents, ServerToClientEvents>;
type Socket = SocketIOSocket<ClientToServerEvents, ServerToClientEvents>;

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

  fastify.io.on("connection", (socket: Socket) => {
    logger.info("connection established");

    socket.on("example:send", (msg) => {
      logger.info("we recieved message from client: " + msg.text);
      socket.emit("example:recieve", { text: "server recieved message from client" });
    });
  });

  fastify.get("/ws/hello", { schema: { hide: true } }, async (_request, reply) => {
    fastify.io.emit("example:recieve", { text: "callback message from server" });
    return reply.status(200).send({ ok: true });
  });
};
