import { create } from "zustand";

export interface Toast {
  id: string;
  type: "success" | "error" | "info" | "warning";
  message: string;
  durationMs?: number;
}

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
    const toast: Toast = { id, durationMs: 4000, ...t };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    if (toast.durationMs && toast.durationMs > 0) {
      setTimeout(() => get().dismissToast(id), toast.durationMs);
    }
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));
