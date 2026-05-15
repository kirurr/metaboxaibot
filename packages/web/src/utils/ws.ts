import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@metabox/shared-browser/ws";
import { useAuthStore } from "@/stores/authStore";

// autoConnect: false — иначе сокет начнёт хендшейк на импорт модуля и
// `notification:snapshot` улетит мимо ещё не зарегистрированных листенеров.
// Подключение явно дёргает хук-инициализатор после `ws.on(...)`.
//
// auth — динамический callback: socket.io вызывает его на каждый коннект
// (включая reconnect), поэтому свежий access token подхватится после
// authStore.tryRefresh без переинициализации сокета.
export const ws: Socket<ServerToClientEvents, ClientToServerEvents> = io("http://localhost:3001", {
  autoConnect: false,
  auth: (cb) => {
    cb({ token: useAuthStore.getState().accessToken ?? "" });
  },
});

ws.on("connect", () => {
  console.log("WS connected");
});

ws.on("connect_error", (err) => {
  console.error("WS connection error:\n", err);
});
