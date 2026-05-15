import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@metabox/shared-browser/ws";

// autoConnect: false — иначе сокет начнёт хендшейк на импорт модуля и
// `notification:snapshot` улетит мимо ещё не зарегистрированных листенеров.
// Подключение явно дёргает хук-инициализатор после `ws.on(...)`.
export const ws: Socket<ServerToClientEvents, ClientToServerEvents> = io(
  "http://localhost:3001",
  { autoConnect: false },
);

ws.on("connect_error", (err) => {
  console.error("WS connection error:\n", err);
});
