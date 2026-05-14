import type { ServerToClientEvents } from "@metabox/shared-browser/ws";
import type { Server } from "../utils/ws.js";
import { logger } from "../logger.js";

let io: Server | null = null;

/** Вызывается один раз при регистрации wsRoutes — сохраняет ссылку на io. */
export function setWsServer(server: Server): void {
  if (io) {
    logger.warn("ws-bus: setWsServer called twice — overwriting");
  }
  io = server;
}

/** Escape hatch — для тонких сценариев (fetchSockets, namespaces). Может вернуть null до init. */
export function getWsServer(): Server | null {
  return io;
}

/** Имя комнаты для пользователя. Принимает aibUserId (BigInt | string). */
export function userRoom(aibUserId: string | bigint): string {
  return `user:${typeof aibUserId === "bigint" ? aibUserId.toString() : aibUserId}`;
}

/** Типизированная отправка событий конкретному пользователю. Возвращает false если io ещё не инициализирован. */
export function emitToUser<Ev extends keyof ServerToClientEvents>(
  aibUserId: string | bigint,
  event: Ev,
  ...args: Parameters<ServerToClientEvents[Ev]>
): boolean {
  if (!io) {
    logger.warn({ event }, "ws-bus: emitToUser before init, dropped");
    return false;
  }
  io.to(userRoom(aibUserId)).emit(event, ...args);
  return true;
}

/** Типизированный broadcast всем подключенным клиентам. */
export function emitToAll<Ev extends keyof ServerToClientEvents>(
  event: Ev,
  ...args: Parameters<ServerToClientEvents[Ev]>
): boolean {
  if (!io) {
    logger.warn({ event }, "ws-bus: emitToAll before init, dropped");
    return false;
  }
  io.emit(event, ...args);
  return true;
}
