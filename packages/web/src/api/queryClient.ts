import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./client";

/**
 * Singleton `QueryClient` — один на всё приложение.
 *
 * Вынесен из `App.tsx`, чтобы можно было дёргать `invalidateQueries` из
 * не-React контекста (zustand action'ов, socket.io listener'ов и т.п.) без
 * вызова `useQueryClient()` вне render phase — иначе React #321.
 *
 * Тот же инстанс прокидывается в `<QueryClientProvider>`, поэтому invalidate
 * отсюда видит все хуки приложения.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // 4xx ретраить бессмысленно; плюс это бы задвоило TELEGRAM_NOT_LINKED
      // модалку, которую client.ts открывает прямо из parseError.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
