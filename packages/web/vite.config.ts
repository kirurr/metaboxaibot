import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

/**
 * Два режима локального запуска (выбираются `--mode`):
 *   - `pnpm dev`         → mode=development → проксирует /api на http://localhost:3001
 *   - `pnpm dev:stage`   → mode=stage       → проксирует /api на STAGE_API_URL ниже
 *
 * Переопределить URL точечно можно через переменную окружения
 * `VITE_DEV_API_PROXY` (например, `.env.local` в `packages/web/`).
 *
 * При проксировании на stage браузер должен получить refresh-token cookie,
 * которую api ставит httpOnly + Domain=stage. Без правки атрибутов браузер
 * её отбрасывает (Domain не совпадает с localhost; Secure не пройдёт на http;
 * SameSite=Strict блокирует кросс-сайтовую отправку). См. `rewriteSetCookie`.
 */
const STAGE_API_URL = "https://stage.aibox.metabox.global";

/**
 * Переписывает `Set-Cookie`-заголовки от stage api так, чтобы браузер на
 * `http://localhost:5174` их принял:
 *   - убираем `Domain=...` (станет host-only для localhost)
 *   - убираем `Secure` (localhost — http)
 *   - `SameSite=Strict|None` → `SameSite=Lax` (Lax работает same-site, чего
 *     достаточно для navigate/XHR с того же origin'а после прокси).
 *
 * Применяется ТОЛЬКО когда target — внешний домен. Для localhost'а ничего
 * не делаем — нативные настройки api корректные.
 */
function rewriteSetCookie(setCookieHeader: string[] | undefined): string[] | undefined {
  if (!setCookieHeader || setCookieHeader.length === 0) return setCookieHeader;
  return setCookieHeader.map((cookie) =>
    cookie
      .replace(/;\s*Domain=[^;]+/i, "")
      .replace(/;\s*Secure/i, "")
      .replace(/;\s*SameSite=(Strict|None)/i, "; SameSite=Lax"),
  );
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget =
    env.VITE_DEV_API_PROXY || (mode === "stage" ? STAGE_API_URL : "http://localhost:3001");
  const isCrossOriginTarget = !apiTarget.startsWith("http://localhost");

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src"),
      },
    },
    server: {
      port: 5174,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
          // Без `secure: false` https-stage с self-signed серт'ом не пройдёт.
          // Для валидных серт'ов опция безвредна (только отключает verify
          // на нашей dev-машине, в браузер edge-stream не транслируется).
          secure: false,
          // SSE поддержка: отключаем буферизацию прокси
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              proxyReq.setHeader("Accept", "text/event-stream, application/json");
            });
            // Cross-origin only: рерайт cookie-атрибутов, чтобы auth работал.
            if (isCrossOriginTarget) {
              proxy.on("proxyRes", (proxyRes) => {
                const cookies = proxyRes.headers["set-cookie"];
                const rewritten = rewriteSetCookie(cookies);
                if (rewritten) proxyRes.headers["set-cookie"] = rewritten;
              });
            }
          },
        },
      },
    },
    build: {
      target: "es2022",
      outDir: "dist",
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ["react", "react-dom", "react-router-dom"],
            ui: ["framer-motion", "lucide-react"],
            forms: ["react-hook-form", "@hookform/resolvers", "zod"],
            i18n: ["i18next", "i18next-browser-languagedetector", "react-i18next"],
            md: ["marked", "dompurify"],
          },
        },
      },
    },
  };
});
