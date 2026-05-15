import { useEffect } from "react";
import { ws } from "@/utils/ws";
import { useNotificationsStore } from "@/stores/notificationsStore";

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

  useEffect(() => {
    ws.connect();

    ws.on("notification:snapshot", setSnapshot);
    ws.on("notification:new", upsert);

    return () => {
      ws.off("notification:snapshot");
      ws.off("notification:new");
    };
  }, [setSnapshot, upsert]);
}
