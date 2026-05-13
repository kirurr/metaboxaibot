import { useEffect } from "react";
import { RouterProvider } from "react-router-dom";
import { router } from "@/router";
import { useAuthStore } from "@/stores/authStore";
import { useModelsStore } from "@/stores/modelsStore";

export function App() {
  const init = useAuthStore((s) => s.init);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const loadModels = useModelsStore((s) => s.load);
  const clearModels = useModelsStore((s) => s.clear);

  useEffect(() => {
    init();
  }, [init]);

  // Подгружаем каталог моделей после авторизации. На logout очищаем кэш —
  // следующий login заберёт свежий список (если каталог поменялся).
  useEffect(() => {
    if (isAuthenticated) {
      loadModels();
    } else {
      clearModels();
    }
  }, [isAuthenticated, loadModels, clearModels]);

  return <RouterProvider router={router} />;
}
