import { create } from "zustand";
import { ws } from "@/utils/ws";
import type { WebNotificationDTO } from "@metabox/shared-browser/ws";
import { useQueryClient } from "@tanstack/react-query";
import { galleryKeys } from "@/api/gallery";

interface NotificationsState {
  /** Дедупликация по id. Источник правды — server snapshot + push'и. */
  byId: Map<string, WebNotificationDTO>;

  /**
   * Отсортированный по createdAt desc список — newest first.
   * Синхронизируется со `byId` в каждом действии. UI рендерит отсюда,
   * чтобы свежеприбывший `upsert` не уезжал в конец Map-итерации.
   */
  list: WebNotificationDTO[];

  /** WS `notification:snapshot` — полностью заменяет содержимое. */
  setSnapshot: (rows: WebNotificationDTO[]) => void;

  /** WS `notification:new` — добавляет/перезаписывает одну запись. */
  upsert: (row: WebNotificationDTO) => void;

  /** Помечает локально прочитанными и отправляет на сервер одним батчем. */
  markAsSeen: (ids: string[]) => void;

  /** Удаляет локально и отправляет на сервер. */
  remove: (id: string) => void;

  /** Сброс при logout / смене юзера. */
  clear: () => void;
}

// ISO 8601 строки лексикографически сортируются хронологически.
function sortDesc(byId: Map<string, WebNotificationDTO>): WebNotificationDTO[] {
  return Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  byId: new Map(),
  list: [],

  setSnapshot: (rows) => {
    const next = new Map<string, WebNotificationDTO>();
    for (const row of rows) next.set(row.id, row);
    set({ byId: next, list: sortDesc(next) });
  },

  upsert: (row) => {
		// invalidate gallery queries
    const qc = useQueryClient();
    qc.invalidateQueries({ queryKey: galleryKeys.all });

    const next = new Map(get().byId);
    next.set(row.id, row);
    set({ byId: next, list: sortDesc(next) });
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
    set({ byId: next, list: sortDesc(next) });
    ws.emit("notification:mark-seen", { ids: toMark });
  },

  remove: (id) => {
    const current = get().byId;
    if (!current.has(id)) return;
    const next = new Map(current);
    next.delete(id);
    set({ byId: next, list: sortDesc(next) });
    ws.emit("notification:delete", { id });
  },

  clear: () => set({ byId: new Map(), list: [] }),
}));
