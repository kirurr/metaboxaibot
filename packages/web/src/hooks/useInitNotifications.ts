import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ws } from "@/utils/ws";
import { useNotificationsStore } from "@/stores/notificationsStore";
import { useUIStore } from "@/stores/uiStore";

/**
 * Подписывается на server-push'и уведомлений:
 *   - `notification:snapshot` — полный список при коннекте (заменяет store)
 *   - `notification:new`      — точечное добавление
 *
 * Сами действия `markAsSeen` / `remove` уезжают на сервер через `ws.emit` из
 * стора — здесь только приёмная сторона.
 */
export function useInitNotifications() {
  const setSnapshot = useNotificationsStore((s) => s.setSnapshot);
  const upsert = useNotificationsStore((s) => s.upsert);
  const pushToast = useUIStore((s) => s.pushToast);
  const navigate = useNavigate();

  useEffect(() => {
    // Сначала регистрируем листенеры, потом коннектимся: иначе server-emit
    // `notification:snapshot` (срабатывает на `connection`) может опередить
    // регистрацию и пропасть.
    ws.on("notification:snapshot", (rows) => {
      setSnapshot(rows);
    });
    ws.on("notification:new", (row) => {
      upsert(row);
      const isSuccess = row.type.includes("success");
      pushToast({
        type: isSuccess ? "success" : "error",
        message: row.title,
        // На мобилке нет gen-history-pane — без шортката юзер уходит в /gallery
        // вручную через нижний нав. На десктопе тоже полезный шорткат.
        onClick: () => navigate("/gallery"),
      });
    });
    ws.connect();

    return () => {
      ws.off("notification:snapshot");
      ws.off("notification:new");
    };
  }, [setSnapshot, upsert, pushToast, navigate]);
}
