import { create } from "zustand";
import type { WebUser } from "@/api/types";
import * as authApi from "@/api/auth";
import { useNotificationsStore } from "@/stores/notificationsStore";

interface AuthState {
  user: WebUser | null;
  accessToken: string | null;
  csrfToken: string | null;
  accessTokenExpiresAt: number | null;
  isAuthenticated: boolean;
  isInitializing: boolean;

  /** Вызывается при старте приложения — тянет /auth/me через refresh-cookie */
  init: () => Promise<void>;

  /** Сохранить сессию после успешного login/signup */
  setSession: (session: {
    user: WebUser;
    accessToken: string;
    csrfToken: string;
    accessTokenExpiresAt: number;
  }) => void;

  /** Обновить user без замены токенов */
  setUser: (user: WebUser) => void;

  /** Попытка рефреша access token. Возвращает true, если удалось. */
  tryRefresh: () => Promise<boolean>;

  /** Стереть сессию (logout / 401) */
  clear: () => void;

  /** Явный logout с вызовом API */
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: null,
  csrfToken: null,
  accessTokenExpiresAt: null,
  isAuthenticated: false,
  isInitializing: true,

  init: async () => {
    try {
      // Пробуем получить новый access через refresh-cookie
      const ok = await get().tryRefresh();
      if (!ok) {
        set({ isInitializing: false, isAuthenticated: false });
        return;
      }
      const { user, csrfToken } = await authApi.me();
      set({
        user,
        csrfToken,
        isAuthenticated: true,
        isInitializing: false,
      });
    } catch {
      set({
        user: null,
        accessToken: null,
        csrfToken: null,
        accessTokenExpiresAt: null,
        isAuthenticated: false,
        isInitializing: false,
      });
    }
  },

  setSession: (session) =>
    set({
      user: session.user,
      accessToken: session.accessToken,
      csrfToken: session.csrfToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      isAuthenticated: true,
      isInitializing: false,
    }),

  setUser: (user) => set({ user }),

  tryRefresh: async () => {
    try {
      const { accessToken, accessTokenExpiresAt, csrfToken } = await authApi.refresh();
      set({ accessToken, accessTokenExpiresAt, csrfToken });
      return true;
    } catch {
      return false;
    }
  },

  clear: () => {
    set({
      user: null,
      accessToken: null,
      csrfToken: null,
      accessTokenExpiresAt: null,
      isAuthenticated: false,
    });
    // Сбрасываем уведомления, чтобы при logout/смене юзера в той же вкладке
    // не светились записи предыдущего юзера до прихода свежего snapshot'а.
    useNotificationsStore.getState().clear();
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      /* даже если не получилось — чистим локально */
    }
    get().clear();
  },
}));
