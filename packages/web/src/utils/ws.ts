import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@metabox/shared-browser/ws";

export const ws: Socket<ServerToClientEvents, ClientToServerEvents> = io("http://localhost:3001");

ws.on("connect_error", (err) => {
  console.error("WS connection error:\n", err);
});
