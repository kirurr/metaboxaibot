import { apiClient, ApiError, API_BASE } from "./client";
import { useAuthStore } from "@/stores/authStore";

/**
 * Каталог голосов для TTS-моделей. Один шейп для cartesia/elevenlabs/openai.
 *
 *  - cartesia: `previewUrl=null` в листинге; играем через
 *    `fetchCartesiaPreviewBlobUrl(id)` который тянет байты через наш authed
 *    endpoint, оборачивает в `blob:` и возвращает строку, годную для `<audio src>`.
 *  - elevenlabs: `previewUrl` — публичный CDN, играется напрямую в `<audio>`.
 *  - openai: статика `/voice-samples/openai/{id}.wav` (раздаёт SPA-сервер).
 */

export type VoiceProvider = "cartesia" | "elevenlabs" | "openai";

export type VoiceItem = {
  id: string;
  name: string;
  description: string | null;
  gender: string | null;
  language: string | null;
  hasPreview: boolean;
  previewUrl: string | null;
};

export function listVoices(provider: VoiceProvider) {
  return apiClient<VoiceItem[]>(`/web/voices/${provider}`);
}

/**
 * Скачать Cartesia preview как `blob:` URL для `<audio>`. Подписанный URL
 * Cartesia требует Bearer-заголовка, а HTML `<audio>` его не передаст —
 * проксируем через наш endpoint и оборачиваем в blob.
 */
export async function fetchCartesiaPreviewBlobUrl(voiceId: string): Promise<string> {
  const auth = useAuthStore.getState();
  if (auth.accessTokenExpiresAt && auth.accessTokenExpiresAt - Date.now() < 5_000) {
    await auth.tryRefresh();
  }
  const doFetch = async () => {
    const token = useAuthStore.getState().accessToken;
    return fetch(
      API_BASE.replace(/\/$/, "") + `/web/voices/cartesia/${encodeURIComponent(voiceId)}/preview`,
      {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      },
    );
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
    throw new ApiError(res.status, body.code, body.error || `preview failed: ${res.status}`, body);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
