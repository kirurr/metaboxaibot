import type { Server as SocketIOServer, Socket as SocketIOSocket } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@metabox/shared-browser";

export interface SocketData {
  webUser: {
    metaboxUserId: string;
    aibUserId: bigint | null;
    sessionId: string;
  };
}

export type Server = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
export type Socket = SocketIOSocket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
