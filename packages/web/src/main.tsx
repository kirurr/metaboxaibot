import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./i18n";
import "./index.css";
import { setupModelsI18nSync } from "@/stores/modelsStore";

// Бэк отдаёт `modes[].label` / `mediaInputs[].label` уже локализованными —
// при смене UI-языка надо ре-фетчить каталог моделей, иначе старые подписи
// останутся в кэше до перезагрузки страницы.
setupModelsI18nSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
