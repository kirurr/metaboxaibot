import { apiClient } from "./client";

/**
 * Пользовательские аватары — HeyGen (synchronous create) и Higgsfield Soul (async stub).
 *
 * Flow для обоих:
 *  1. Грузим фото(а) через `uploadChatFile` (/web/chat-uploads) — получаем s3Key.
 *  2. Шлём s3Key(s) в /web/user-avatars/{provider}.
 *  3. HeyGen возвращает avatar со status="ready" немедленно.
 *     Soul возвращает avatar со status="creating" — worker-джоба (отдельный
 *     разработчик) дойдёт до "ready" асинхронно.
 */

export type UserAvatarDto = {
  id: string;
  provider: "heygen" | "higgsfield_soul" | string;
  name: string;
  externalId: string | null;
  previewUrl: string | null;
  status: "creating" | "ready" | "failed" | "orphaned" | string;
  createdAt: string;
};

export function listUserAvatars(provider?: "heygen" | "higgsfield_soul") {
  return apiClient<UserAvatarDto[]>("/web/user-avatars", {
    query: provider ? { provider } : undefined,
  });
}

export function createHeyGenAvatar(params: { s3Key: string; name?: string }) {
  return apiClient<UserAvatarDto, typeof params>("/web/user-avatars/heygen", {
    method: "POST",
    body: params,
  });
}

export function createSoulAvatar(params: { s3Keys: string[]; name?: string }) {
  return apiClient<UserAvatarDto, typeof params>("/web/user-avatars/higgsfield-soul", {
    method: "POST",
    body: params,
  });
}

export function renameUserAvatar(id: string, name: string) {
  return apiClient<{ ok: true }, { name: string }>(`/web/user-avatars/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { name },
  });
}

export function deleteUserAvatar(id: string) {
  return apiClient<{ ok: true }>(`/web/user-avatars/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
