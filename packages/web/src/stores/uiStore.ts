import { create } from "zustand";

export interface Toast {
  id: string;
  type: "success" | "error" | "info" | "warning" | "loading";
  message: string;
  description?: string;
  durationMs?: number;
  exiting?: boolean;
  /** Если задан — тело тоста становится кликабельным; X-кнопка остаётся
   *  отдельной (закрывает без вызова onClick). */
  onClick?: () => void;
}

const TOAST_EXIT_MS = 200;

interface UIState {
  sidebarOpen: boolean;
  toasts: Toast[];

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;

  pushToast: (t: Omit<Toast, "id">) => string;
  dismissToast: (id: string) => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  sidebarOpen: true,
  toasts: [],

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  pushToast: (t) => {
    const id = Math.random().toString(36).slice(2);
    const toast: Toast = { id, durationMs: 6000, ...t };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    if (toast.durationMs && toast.durationMs > 0) {
      setTimeout(() => get().dismissToast(id), toast.durationMs);
    }
    return id;
  },
  dismissToast: (id) => {
    set((s) => ({
      toasts: s.toasts.map((x) => (x.id === id ? { ...x, exiting: true } : x)),
    }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
    }, TOAST_EXIT_MS);
  },
}));
