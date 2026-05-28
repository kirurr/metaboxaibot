import { create } from "zustand";

/**
 * Локальный список id ошибочных генераций, которые юзер скрыл через
 * dismiss-кнопку на FailedTile в Gallery. Персистится в localStorage —
 * после рефреша скрытая ошибка не возвращается.
 *
 * Чистки старых id нет: UI фильтрует failed-выдачу по `createdAt >= сегодня`,
 * вчерашние id в массиве — мертвый груз, не влияющий на рендер. Если массив
 * когда-нибудь распухнет до проблемного размера, добавим TTL-чистку.
 */
const STORAGE_KEY = "dismissed-error-ids";

function loadIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface DismissedErrorsState {
  ids: string[];
  dismiss: (id: string) => void;
}

export const useDismissedErrorsStore = create<DismissedErrorsState>((set) => ({
  ids: loadIds(),
  dismiss: (id) =>
    set((s) => {
      if (s.ids.includes(id)) return s;
      const next = [...s.ids, id];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // quota/private-mode — UI всё равно работает в рамках сессии
      }
      return { ids: next };
    }),
}));
