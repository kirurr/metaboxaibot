import { apiClient } from "./client";

/**
 * Каталоги для пикеров image/video секций. Зеркалят `/web/avatars/heygen`,
 * `/web/motions`, `/web/soul-styles`. Все элементы имеют preview-URL (картинка
 * для аватаров/стилей, видео для motions), который ходит напрямую без auth.
 */

export type AvatarItem = {
  id: string;
  name: string;
  gender: string | null;
  previewUrl: string | null;
};

export type MotionItem = {
  id: string;
  name: string;
  description: string | null;
  previewUrl: string | null;
  category: string | null;
};

export type SoulStyleItem = {
  id: string;
  name: string;
  description: string | null;
  previewUrl: string;
};

export function listHeyGenAvatars() {
  return apiClient<AvatarItem[]>("/web/avatars/heygen");
}

export function listMotions() {
  return apiClient<MotionItem[]>("/web/motions");
}

export function listSoulStyles() {
  return apiClient<SoulStyleItem[]>("/web/soul-styles");
}
