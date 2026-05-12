import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@metabox/shared-browser";

export const ws: Socket<ServerToClientEvents, ClientToServerEvents> = io("http://localhost:3001");
