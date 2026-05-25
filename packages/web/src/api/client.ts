/**
 * HTTP-клиент для общения с `packages/api` (AI Box API).
 *
 * Особенности:
 * - Access token живёт в памяти (Zustand) — не в localStorage, чтобы не быть уязвимым к XSS.
 * - Refresh token — в httpOnly cookie, которую ставит бэкенд; фронт её не видит.
 * - При 401 пытаемся один раз обновить access через /auth/refresh и повторить запрос.
 * - CSRF-токен передаётся в заголовке X-CSRF-Token для мутирующих запросов.
 *
 * Usage:
 *   const me = await apiClient<User>("/auth/me");
 *   const res = await apiClient<LoginResp, LoginBody>("/auth/login", { method: "POST", body });
 */

import { useAuthStore } from "@/stores/authStore";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiOptions<TBody> {
  method?: Method;
  body?: TBody;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Не пытаться автоматически обновить access token при 401 */
  skipAuthRefresh?: boolean;
  /** Не добавлять Authorization header (например, для /auth/login) */
  skipAuth?: boolean;
  /** Таймаут в мс (по умолчанию 30 сек) */
  timeoutMs?: number;
}

function buildUrl(path: string, query?: ApiOptions<unknown>["query"]): string {
  const url = new URL(
    path.startsWith("http") ? path : API_BASE.replace(/\/$/, "") + path,
    window.location.origin,
  );
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function parseError(res: Response): Promise<ApiError> {
  let body: { code?: string; error?: string; message?: string } | null = null;
  try {
    body = (await res.json()) as { code?: string; error?: string; message?: string };
  } catch {
    /* ignore */
  }
  return new ApiError(
    res.status,
    body?.code,
    body?.error || body?.message || res.statusText || "Request failed",
    body,
  );
}

export async function apiClient<TResponse = unknown, TBody = unknown>(
  path: string,
  opts: ApiOptions<TBody> = {},
): Promise<TResponse> {
  const {
    method = "GET",
    body,
    query,
    signal,
    skipAuthRefresh,
    skipAuth,
    timeoutMs = 30_000,
  } = opts;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (!skipAuth) {
    const token = useAuthStore.getState().accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;
    // CSRF — только для мутирующих запросов
    if (method !== "GET") {
      const csrf = useAuthStore.getState().csrfToken;
      if (csrf) headers["X-CSRF-Token"] = csrf;
    }
  }

  const controller = new AbortController();
  const externalSignal = signal;
  if (externalSignal) {
    externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "include",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if ((err as Error).name === "AbortError") {
      throw new ApiError(0, "TIMEOUT", "Запрос прерван по таймауту");
    }
    throw new ApiError(0, "NETWORK", "Нет соединения");
  }
  clearTimeout(timeoutId);

  // Обработка 401 — пробуем один раз освежить access token
  if (res.status === 401 && !skipAuthRefresh && !skipAuth) {
    const refreshed = await useAuthStore.getState().tryRefresh();
    if (refreshed) {
      return apiClient<TResponse, TBody>(path, { ...opts, skipAuthRefresh: true });
    }
    // refresh не удался — деавторизуем
    useAuthStore.getState().clear();
    throw await parseError(res);
  }

  if (!res.ok) {
    throw await parseError(res);
  }

  // 204 No Content
  if (res.status === 204) return undefined as TResponse;

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return (await res.json()) as TResponse;
  }
  return (await res.text()) as unknown as TResponse;
}

/**
 * POST одного файла как `multipart/form-data` на `path`. Тот же auth/refresh
 * flow, что у `apiClient`: освежает access перед запросом, на 401 один раз
 * ретраит через tryRefresh. Возвращает сырой Response — вызывающий парсит свою
 * схему; на !ok бросает ApiError.
 *
 * НЕ через apiClient — нужен FormData без Content-Type (браузер сам ставит
 * multipart boundary). Используется загрузками чата и Element'ов.
 */
export async function postMultipartFile(path: string, file: File): Promise<Response> {
  const auth = useAuthStore.getState();
  if (auth.accessTokenExpiresAt && auth.accessTokenExpiresAt - Date.now() < 5_000) {
    await auth.tryRefresh();
  }

  const form = new FormData();
  form.append("file", file, file.name);

  const doFetch = async () => {
    const token = useAuthStore.getState().accessToken;
    const csrf = useAuthStore.getState().csrfToken;
    return fetch(API_BASE.replace(/\/$/, "") + path, {
      method: "POST",
      credentials: "include",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: form,
    });
  };

  let res = await doFetch();
  if (res.status === 401) {
    const refreshed = await useAuthStore.getState().tryRefresh();
    if (refreshed) res = await doFetch();
  }
  if (!res.ok) {
    let body: { code?: string; error?: string } = {};
    try {
      body = (await res.json()) as { code?: string; error?: string };
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, body.code, body.error || `upload failed: ${res.status}`, body);
  }
  return res;
}

export { API_BASE };
