import type {
  UserProfile,
  Dialog,
  Message,
  UserState,
  Model,
  AdminUsersResponse,
  BannerSlide,
  GalleryResponse,
  GalleryFolder,
  CatalogResponse,
  HeyGenVoice,
  HeyGenAvatar,
  HiggsFieldMotion,
  SoulStyle,
  DIDVoice,
  UserAvatar,
  ElevenLabsVoice,
  CartesiaVoice,
  UserVoice,
} from "../types.js";

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

let _initDataRaw: string | null = null;
let _webToken: string | null = null;

export function setInitDataRaw(raw: string): void {
  _initDataRaw = raw;
}

export function setWebToken(token: string): void {
  _webToken = token;
}

export function clearWebToken(): void {
  _webToken = null;
}

/**
 * Возвращает Authorization header для текущей сессии — Telegram initData
 * (mini-app) или web JWT. Расшарено между `request()` и `uploadRequest()`
 * чтобы schema auth не дрейфовала между ними.
 */
function buildAuthHeader(): { Authorization: string } | Record<string, never> {
  if (_initDataRaw) return { Authorization: `tma ${_initDataRaw}` };
  if (_webToken) return { Authorization: `wtoken ${_webToken}` };
  return {};
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(options.headers as Record<string, string>),
    ...buildAuthHeader(),
  };

  const method = options.method ?? "GET";
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      cache: "no-store",
    });
  } catch (networkErr) {
    console.error(`[api] network error ${method} ${path}`, networkErr);
    throw networkErr;
  }

  // Rolling-refresh wtoken: сервер кладёт свежий токен, когда наш приближается
  // к hard-expiry. Подхватываем сразу, до проверки res.ok — даже на 4xx ответе
  // токен мог обновиться (например, при ошибке домена, но валидной auth).
  const refreshed = res.headers.get("X-Refresh-Wtoken");
  if (refreshed) setWebToken(refreshed);

  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: res.statusText }))) as Record<
      string,
      unknown
    >;
    const error = new Error((err.error as string) ?? `HTTP ${res.status}`) as Error &
      Record<string, unknown>;
    if (err.code) error.code = err.code;
    if (err.linkedTo) error.linkedTo = err.linkedTo;
    if (err.siteMentor) error.siteMentor = err.siteMentor;
    if (err.botMentor) error.botMentor = err.botMentor;
    if (err.linkedEmail) error.linkedEmail = err.linkedEmail;
    if (err.linkedUsername) error.linkedUsername = err.linkedUsername;
    // MENTOR_CONFLICT прокидывает token (+ userIds) для последующего
    // confirm-merge'а через модалку выбора в LinkMetaboxPage.
    if (err.token) error.token = err.token;
    if (err.siteUserId) error.siteUserId = err.siteUserId;
    if (err.botUserId) error.botUserId = err.botUserId;
    console.error(`[api] ${method} ${path} → ${res.status}`, err);
    throw error;
  }

  return res.json() as Promise<T>;
}

async function uploadRequest<T>(path: string, body: FormData): Promise<T> {
  const headers: Record<string, string> = { ...buildAuthHeader() };

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers,
      body,
    });
  } catch (networkErr) {
    console.error(`[api] network error POST ${path}`, networkErr);
    throw networkErr;
  }

  const refreshed = res.headers.get("X-Refresh-Wtoken");
  if (refreshed) setWebToken(refreshed);

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    console.error(`[api] POST ${path} → ${res.status}`, err);
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export const api = {
  auth: {
    verify: (initData: string) =>
      request<{ id: string; tokenBalance: string }>("/auth/verify", {
        method: "POST",
        body: JSON.stringify({ initData }),
      }),
    verifyToken: (token: string) =>
      request<{ id: string; tokenBalance: string }>("/auth/webtoken", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
  },

  profile: {
    get: () => request<UserProfile>("/profile"),
    updatePreferences: (body: { confirmBeforeGenerate?: boolean; autoActivateModel?: boolean }) =>
      request<{ ok: boolean; confirmBeforeGenerate: boolean; autoActivateModel: boolean }>(
        "/profile/preferences",
        {
          method: "PATCH",
          body: JSON.stringify(body),
        },
      ),
    partnerBalance: () =>
      request<{
        balance: number;
        totalEarned: number;
        totalWithdrawn: number;
        userStatus: string;
        referralCode: string | null;
      }>("/profile/partner-balance"),
    metaboxSso: () =>
      request<
        | { ssoUrl: string; requiresVerification?: undefined }
        | { ssoUrl?: undefined; requiresVerification: true; email: string }
      >("/profile/metabox-sso"),
    metaboxStatus: () =>
      request<{ linked: false } | { linked: true; emailVerified: boolean; email: string }>(
        "/profile/metabox-status",
      ),
    metaboxResendVerification: () =>
      request<{
        ok: boolean;
        email: string;
        alreadyVerified?: boolean;
        attemptsLeft?: number;
        cooldownSec?: number;
      }>("/profile/metabox-resend-verification", { method: "POST" }),
    metaboxChangeEmail: (newEmail: string) =>
      request<{ ok: boolean; email: string; warning?: string }>("/profile/metabox-change-email", {
        method: "POST",
        body: JSON.stringify({ newEmail }),
      }),
    metaboxRegister: (
      email: string,
      password: string,
      firstName?: string,
      lastName?: string,
      username?: string,
    ) =>
      request<
        | { ssoUrl: string; requiresVerification?: undefined }
        | { ssoUrl?: undefined; requiresVerification: true; email: string }
      >("/profile/metabox-register", {
        method: "POST",
        body: JSON.stringify({ email, password, firstName, lastName, username }),
      }),
    metaboxLogin: (email: string, password: string) =>
      request<{ ssoUrl: string }>("/profile/metabox-login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    /**
     * Закрывает MENTOR_CONFLICT, который возник в metaboxLogin/metaboxRegister.
     * Принимает `token` из ответа (Metabox прокинул его наружу) + выбор юзера.
     * Бот-эндпоинт делает confirm-merge на Metabox и обновляет связь.
     */
    metaboxConfirmMerge: (token: string, chosenMentor: "site" | "bot") =>
      request<{ ssoUrl: string }>("/profile/metabox-confirm-merge", {
        method: "POST",
        body: JSON.stringify({ token, chosenMentor }),
      }),
  },

  dialogs: {
    list: (section?: string) =>
      request<Dialog[]>(section ? `/dialogs?section=${section}` : "/dialogs"),
    create: (section: string, modelId: string, title?: string) =>
      request<Dialog>("/dialogs", {
        method: "POST",
        body: JSON.stringify({ section, modelId, title }),
      }),
    rename: (id: string, title: string) =>
      request<{ id: string; title: string }>(`/dialogs/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      }),
    delete: (id: string) => request<{ success: boolean }>(`/dialogs/${id}`, { method: "DELETE" }),
    activate: (id: string) =>
      request<{ success: boolean }>(`/dialogs/${id}/activate`, { method: "POST" }),
    messages: (id: string) => request<Message[]>(`/dialogs/${id}/messages`),
  },

  state: {
    get: () => request<UserState>("/state"),
    patch: (body: {
      gptModelId?: string;
      section?: string;
      dialogId?: string | null;
      sectionModelId?: string;
    }) =>
      request<{ success: boolean }>("/state", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    activate: (section: string, modelId: string) =>
      request<{ success: boolean }>("/state/activate", {
        method: "POST",
        body: JSON.stringify({ section, modelId }),
      }),
    /**
     * Silent model select. `keepalive: true` критично: юзер может тапнуть
     * вариант и сразу закрыть мини-аппу (X в Telegram WebView) до того как
     * запрос дойдёт до сервера. Без keepalive WebView убивает in-flight
     * fetch'и при закрытии → модель не сохраняется. С keepalive браузер
     * добивает запрос даже после закрытия страницы.
     *
     * Notify (Telegram-сообщение «модель X активирована») здесь НЕ дёргается:
     * сервер сам шедулит trailing-debounce и отправляет финальный пинг после
     * 5с тишины — см. `/state/select-model` в `routes/state.ts`.
     */
    selectModel: (section: string, modelId: string) =>
      request<{ success: boolean }>("/state/select-model", {
        method: "POST",
        body: JSON.stringify({ section, modelId }),
        keepalive: true,
      }),
    setSelectedMode: (modelId: string, modeId: string) =>
      request<{ success: boolean }>("/state/selected-mode", {
        method: "POST",
        body: JSON.stringify({ modelId, modeId }),
        // Симметрично с selectModel: юзер может тапнуть mode-чип и сразу X-close
        // webview до того как запрос дойдёт до сервера. Без keepalive WebView
        // убивает in-flight fetch → выбор mode'а теряется и bot работает по
        // старому mode. Auto-activate через 3с (handleModeChange) при быстром
        // X-close тоже отменится, поэтому keepalive здесь — единственная
        // гарантия что mode change долетит.
        keepalive: true,
      }),
  },

  models: {
    list: (section?: string) =>
      request<Model[]>(section ? `/models?section=${section}` : "/models"),
  },

  tariffs: {
    catalog: () => request<CatalogResponse>("/tariffs/catalog"),
  },

  payments: {
    createInvoice: (type: string, id: string, period?: string, name?: string) =>
      request<{ invoiceUrl: string }>("/payments/invoice", {
        method: "POST",
        body: JSON.stringify({ type, id, period, name }),
      }),
    createCardInvoice: (type: string, id: string, period?: string) =>
      request<{ paymentUrl: string }>("/payments/card-invoice", {
        method: "POST",
        body: JSON.stringify({ type, id, period }),
      }),
  },

  metaboxAibot: {
    products: () =>
      request<{ id: string; name: string; tokens: number; priceRub: string }[]>(
        "/metabox-aibot/products",
      ),
    buy: (productId: string) =>
      request<{ paymentUrl: string }>("/metabox-aibot/buy", {
        method: "POST",
        body: JSON.stringify({ productId }),
      }),
  },

  slides: {
    list: () => request<{ slides: BannerSlide[] }>("/slides"),
  },

  gallery: {
    list: (params: {
      section?: string;
      page?: number;
      limit?: number;
      modelId?: string;
      modelIds?: string;
      folderId?: string;
    }) => {
      const qs = new URLSearchParams();
      if (params.section) qs.set("section", params.section);
      if (params.page) qs.set("page", String(params.page));
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.modelIds) qs.set("modelIds", params.modelIds);
      else if (params.modelId) qs.set("modelId", params.modelId);
      if (params.folderId) qs.set("folderId", params.folderId);
      return request<GalleryResponse>(`/gallery?${qs.toString()}`);
    },
    sendJob: (jobId: string) =>
      request<{ success: boolean }>(`/gallery/jobs/${jobId}/send`, { method: "POST" }),
    previewUrl: (outputId: string) => request<{ url: string }>(`/gallery/${outputId}/preview-url`),
    originalUrl: (outputId: string) =>
      request<{ url: string }>(`/gallery/outputs/${outputId}/original-url`),
    deleteJob: (jobId: string) =>
      request<{ success: boolean }>(`/gallery/jobs/${jobId}`, { method: "DELETE" }),
    modelCounts: (section?: string) =>
      request<{ modelId: string; count: number }[]>(
        `/gallery/model-counts${section ? `?section=${encodeURIComponent(section)}` : ""}`,
      ),
    folders: {
      list: () => request<GalleryFolder[]>("/gallery/folders"),
      create: (name: string) =>
        request<GalleryFolder>("/gallery/folders", {
          method: "POST",
          body: JSON.stringify({ name }),
        }),
      update: (folderId: string, patch: { name?: string; isPinned?: boolean }) =>
        request<GalleryFolder>(`/gallery/folders/${folderId}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      delete: (folderId: string) =>
        request<{ success: boolean }>(`/gallery/folders/${folderId}`, { method: "DELETE" }),
      addItem: (folderId: string, jobId: string) =>
        request<{ success: boolean }>(`/gallery/folders/${folderId}/items`, {
          method: "POST",
          body: JSON.stringify({ jobId }),
        }),
      removeItem: (folderId: string, jobId: string) =>
        request<{ success: boolean }>(`/gallery/folders/${folderId}/items/${jobId}`, {
          method: "DELETE",
        }),
    },
    favorites: {
      add: (jobId: string) =>
        request<{ folderId: string }>("/gallery/favorites", {
          method: "POST",
          body: JSON.stringify({ jobId }),
        }),
      remove: (jobId: string) =>
        request<{ success: boolean }>(`/gallery/favorites/${jobId}`, { method: "DELETE" }),
    },
  },

  imageSettings: {
    get: () => request<Record<string, { aspectRatio: string }>>("/image-settings"),
    set: (modelId: string, aspectRatio: string) =>
      request<{ success: boolean }>("/image-settings", {
        method: "PATCH",
        body: JSON.stringify({ modelId, aspectRatio }),
      }),
  },

  videoSettings: {
    get: () =>
      request<Record<string, { aspectRatio?: string; duration?: number }>>("/video-settings"),
    set: (modelId: string, patch: { aspectRatio?: string; duration?: number }) =>
      request<{ success: boolean }>("/video-settings", {
        method: "PATCH",
        body: JSON.stringify({ modelId, ...patch }),
      }),
  },

  heygenVoices: {
    list: () => request<HeyGenVoice[]>("/heygen-voices"),
  },

  heygenAvatars: {
    list: (params: { token?: string; limit?: number; gender?: string; search?: string } = {}) => {
      const qs = new URLSearchParams();
      if (params.token) qs.set("token", params.token);
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.gender && params.gender !== "all") qs.set("gender", params.gender);
      if (params.search) qs.set("search", params.search);
      const query = qs.toString();
      return request<{ items: HeyGenAvatar[]; has_more: boolean; next_token: string | null }>(
        `/heygen-avatars${query ? `?${query}` : ""}`,
      );
    },
  },

  higgsfieldMotions: {
    list: () => request<HiggsFieldMotion[]>("/higgsfield-motions"),
  },

  soulStyles: {
    list: () => request<SoulStyle[]>("/soul-styles"),
  },

  didVoices: {
    list: () => request<DIDVoice[]>("/d-id-voices"),
  },

  elevenlabsVoices: {
    list: () => request<ElevenLabsVoice[]>("/elevenlabs-voices"),
  },

  cartesiaVoices: {
    list: () => request<CartesiaVoice[]>("/cartesia-voices"),
    /**
     * Cartesia preview-файл требует Bearer-заголовок, который <audio> не
     * передаёт. Берём байты через наш auth'ed endpoint и оборачиваем в
     * blob: URL для воспроизведения. URL остаётся валидным до перезагрузки
     * страницы или явного `URL.revokeObjectURL` (мелкая утечка на клик —
     * приемлемо).
     */
    previewBlobUrl: async (voiceId: string): Promise<string> => {
      const res = await fetch(
        `${API_BASE}/cartesia-voices/${encodeURIComponent(voiceId)}/preview`,
        { headers: buildAuthHeader(), cache: "no-store" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    },
  },

  userVoices: {
    list: (provider?: string) =>
      request<UserVoice[]>(provider ? `/user-voices?provider=${provider}` : "/user-voices"),
    startCreation: (returnTo?: "heygen") =>
      request<{ ok: boolean }>("/user-voices/start-creation", {
        method: "POST",
        body: JSON.stringify(returnTo ? { returnTo } : {}),
      }),
    rename: (id: string, name: string) =>
      request<UserVoice>(`/user-voices/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    delete: (id: string) =>
      request<{ success: boolean }>(`/user-voices/${id}`, { method: "DELETE" }),
    previewUrl: (id: string) => request<{ url: string }>(`/user-voices/${id}/preview-url`),
  },

  userAvatars: {
    list: (provider?: string) =>
      request<UserAvatar[]>(provider ? `/user-avatars?provider=${provider}` : "/user-avatars"),
    startCreation: (provider: string) =>
      request<{ ok: boolean }>("/user-avatars/start-creation", {
        method: "POST",
        body: JSON.stringify({ provider }),
      }),
    rename: (id: string, name: string) =>
      request<UserAvatar>(`/user-avatars/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    delete: (id: string) =>
      request<{ success: boolean }>(`/user-avatars/${id}`, { method: "DELETE" }),
  },

  account: {
    /**
     * Запускает flow удаления аккаунта: api генерит код, шлёт его пользователю
     * в чат бота, ставит state AWAITING_DELETE_CONFIRMATION. Дальнейшие шаги
     * (ввод кода, финальный confirm) — внутри бота.
     */
    initiateDelete: () => request<{ ok: true }>("/account/delete-initiate", { method: "POST" }),
  },

  modelSettings: {
    get: () => request<Record<string, Record<string, unknown>>>("/model-settings"),
    set: (modelId: string, settings: Record<string, unknown>, opts?: { replace?: boolean }) =>
      request<{ success: boolean }>("/model-settings", {
        method: "PATCH",
        body: JSON.stringify({ modelId, settings, ...(opts?.replace ? { replace: true } : {}) }),
      }),
    getForDialog: (dialogId: string) =>
      request<Record<string, unknown>>(`/model-settings/dialog/${dialogId}`),
    setForDialog: (dialogId: string, settings: Record<string, unknown>) =>
      request<{ success: boolean }>(`/model-settings/dialog/${dialogId}`, {
        method: "PATCH",
        body: JSON.stringify({ settings }),
      }),
  },

  admin: {
    users: (params: { page?: number; limit?: number; search?: string }) => {
      const qs = new URLSearchParams();
      if (params.page) qs.set("page", String(params.page));
      if (params.limit) qs.set("limit", String(params.limit));
      if (params.search) qs.set("search", params.search);
      return request<AdminUsersResponse>(`/admin/users?${qs.toString()}`);
    },
    grant: (userId: string, amount: number, reason?: string) =>
      request<{ success: boolean; newBalance: string }>("/admin/grant", {
        method: "POST",
        body: JSON.stringify({ userId, amount, reason }),
      }),
    block: (userId: string, blocked: boolean) =>
      request<{ success: boolean; isBlocked: boolean }>("/admin/block", {
        method: "POST",
        body: JSON.stringify({ userId, blocked }),
      }),
    setRole: (userId: string, role: string) =>
      request<{ success: boolean }>("/admin/role", {
        method: "POST",
        body: JSON.stringify({ userId, role }),
      }),
    slides: {
      list: () => request<{ slides: BannerSlide[] }>("/admin/slides"),
      create: (data: FormData) => uploadRequest<BannerSlide>("/admin/slides", data),
      update: (id: string, data: Record<string, unknown>) =>
        request<BannerSlide>(`/admin/slides/${id}`, {
          method: "PATCH",
          body: JSON.stringify(data),
        }),
      delete: (id: string) =>
        request<{ success: boolean }>(`/admin/slides/${id}`, { method: "DELETE" }),
      reorder: (slideIds: string[]) =>
        request<{ success: boolean }>("/admin/slides/reorder", {
          method: "POST",
          body: JSON.stringify({ slideIds }),
        }),
    },
  },
};
