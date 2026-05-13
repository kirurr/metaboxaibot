import { useEffect } from "react";
import { RouterProvider } from "react-router-dom";
import { router } from "@/router";
import { useAuthStore } from "@/stores/authStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useDialogsStore } from "@/stores/dialogsStore";

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

  return <RouterProvider router={router} />;
}
