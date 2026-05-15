import { create } from "zustand";
import { ws } from "@/utils/ws";
import type { WebNotificationDTO } from "@metabox/shared-browser/ws";

interface NotificationsState {
  /** Дедупликация по id. Источник правды — server snapshot + push'и. */
  byId: Map<string, WebNotificationDTO>;

  /** WS `notification:snapshot` — полностью заменяет содержимое. */
  setSnapshot: (rows: WebNotificationDTO[]) => void;

  /** WS `notification:new` — добавляет/перезаписывает одну запись. */
  upsert: (row: WebNotificationDTO) => void;

  /** Помечает локально прочитанными и отправляет на сервер одним батчем. */
  markAsSeen: (ids: string[]) => void;

  /** Удаляет локально и отправляет на сервер. */
  remove: (id: string) => void;
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  byId: new Map(),

  setSnapshot: (rows) => {
    const next = new Map<string, WebNotificationDTO>();
    for (const row of rows) next.set(row.id, row);
    set({ byId: next });
  },

  upsert: (row) => {
    const next = new Map(get().byId);
    next.set(row.id, row);
    set({ byId: next });
  },

  markAsSeen: (ids) => {
    if (ids.length === 0) return;
    const current = get().byId;
    const toMark = ids.filter((id) => {
      const row = current.get(id);
      return row !== undefined && !row.isSeen;
    });
    if (toMark.length === 0) return;

    const next = new Map(current);
    for (const id of toMark) {
      const row = next.get(id);
      if (row) next.set(id, { ...row, isSeen: true });
    }
    set({ byId: next });
    ws.emit("notification:mark-seen", { ids: toMark });
  },

  remove: (id) => {
    const current = get().byId;
    if (!current.has(id)) return;
    const next = new Map(current);
    next.delete(id);
    set({ byId: next });
    ws.emit("notification:delete", { id });
  },
}));
