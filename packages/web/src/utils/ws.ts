import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@metabox/shared-browser/ws";
import { useAuthStore } from "@/stores/authStore";

/**
 * Резолв URL для socket.io:
 *  - `VITE_WS_URL` — явный override (например, при тестах против отдельного
 *    backend'а без vite-прокси).
 *  - иначе — undefined: socket.io подключается к `window.location.origin`.
 *    На dev/stage Vite-прокси из `vite.config.ts` форвардит `/socket.io/` на
 *    тот же upstream что и `/api`. В prod nginx должен проксировать
 *    `/socket.io/` с `Upgrade`/`Connection` заголовками на api-контейнер.
 *
 * Хардкод `http://localhost:3001` уехал — он ломал `pnpm dev:stage`
 * (WS пытался стучаться в локальный 3001 вместо проксированного stage).
 */
const WS_URL = import.meta.env.VITE_WS_URL || undefined;

// autoConnect: false — иначе сокет начнёт хендшейк на импорт модуля и
// `notification:snapshot` улетит мимо ещё не зарегистрированных листенеров.
// Подключение явно дёргает хук-инициализатор после `ws.on(...)`.
//
// auth — динамический callback: socket.io вызывает его на каждый коннект
// (включая reconnect), поэтому свежий access token подхватится после
// authStore.tryRefresh без переинициализации сокета.
export const ws: Socket<ServerToClientEvents, ClientToServerEvents> = io(WS_URL, {
  autoConnect: false,
  withCredentials: true,
  auth: (cb) => {
    cb({ token: useAuthStore.getState().accessToken ?? "" });
  },
});

ws.on("connect", () => {
  console.log("WS connected");
});

ws.on("connect_error", (err) => {
  // err.message содержит текст от middleware (например "Unauthorized" из
  // wsAuthMiddleware). err.data — опциональный structured payload.
  // У socket.io-client типы `Error` без data — кастуем для логирования.
  const e = err as Error & { data?: unknown };
  console.error("WS connect_error:", {
    message: e.message,
    name: e.name,
    data: e.data,
  });
});
