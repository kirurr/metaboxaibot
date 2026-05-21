import { ApiError, API_BASE } from "./client";
import { useAuthStore } from "@/stores/authStore";
import type {
  AdminUploadKind,
  AdminUploadSection,
  AdminUploadResponse,
} from "@metabox/shared-browser/dto";

/**
 * Загружает один файл в `/admin/uploads` (multipart). Бэк кладёт его в S3
 * под `prompts/{section}/{uuid}.{ext}` и возвращает s3Key + presigned URL.
 *
 * Auth-flow совпадает с `uploadChatFile`: освежает access перед запросом,
 * на 401 один раз ретраит через tryRefresh. preHandler на бэке принимает
 * web-JWT и проверяет role ∈ {ADMIN, MODERATOR}.
 */

export type { AdminUploadKind, AdminUploadSection, AdminUploadResponse };

const ENDPOINT = "/admin/prompts/uploads";

export async function uploadAdminFile(
  file: File,
  section: AdminUploadSection,
  kind: AdminUploadKind,
): Promise<AdminUploadResponse> {
  const auth = useAuthStore.getState();
  if (auth.accessTokenExpiresAt && auth.accessTokenExpiresAt - Date.now() < 5_000) {
    await auth.tryRefresh();
  }

  const form = new FormData();
  form.append("file", file, file.name);
  form.append("section", section);
  form.append("kind", kind);

  const doFetch = async () => {
    const token = useAuthStore.getState().accessToken;
    const csrf = useAuthStore.getState().csrfToken;
    return fetch(API_BASE.replace(/\/$/, "") + ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: {
        // Content-Type не выставляем — браузер сам добавит multipart boundary.
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
    throw new ApiError(
      res.status,
      body.code,
      body.error || `admin upload failed: ${res.status}`,
      body,
    );
  }
  return (await res.json()) as AdminUploadResponse;
}
