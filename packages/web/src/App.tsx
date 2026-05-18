import { useEffect } from "react";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router } from "@/router";
import { ApiError } from "@/api/client";
import { useAuthStore } from "@/stores/authStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useDialogsStore } from "@/stores/dialogsStore";

const queryClient = new QueryClient({
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

export function App() {
  const init = useAuthStore((s) => s.init);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const loadModels = useModelsStore((s) => s.load);
  const clearModels = useModelsStore((s) => s.clear);
  const clearDialogs = useDialogsStore((s) => s.clear);

  useEffect(() => {
    init();
  }, [init]);

  // Подгружаем каталог моделей после авторизации. На logout очищаем кэши —
  // следующий login заберёт свежий список. Диалоги тянет уже Chat-page по
  // нужной секции (не имеет смысла грузить их превентивно для всех юзеров).
  useEffect(() => {
    if (isAuthenticated) {
      loadModels();
    } else {
      clearModels();
      clearDialogs();
    }
  }, [isAuthenticated, loadModels, clearModels, clearDialogs]);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
