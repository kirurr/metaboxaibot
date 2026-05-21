import {
  modelSettingsRootSchema,
  type ModelSettingsRoot,
  type ModelSettingsSuccessResponse,
  type PatchDialogModelSettingsBody,
  type PatchModelSettingsBody,
} from "@metabox/shared-browser/dto";
import { apiClient } from "./client";

/**
 * Эндпоинты `/web/model-settings/*` — web-зеркало TG-роута `/model-settings`
 * (тот используется только мини-аппой и ботом). Авторизация — JWT Bearer
 * (`webTelegramLinkedPreHandler`): юзер без привязанного Telegram получает
 * 403 `TELEGRAM_NOT_LINKED` — `apiClient` сам открывает модалку.
 *
 * Хранилище плоское: `{ [modelId]: { [key]: value } }`, а dialog-overrides
 * лежат под ключом `dialog:<dialogId>`. Эффективные настройки диалога =
 * `{...modelLevel, ...dialogLevel}` — мерджим клиент-сайдом через
 * `resolveEffectiveSettings`, как делает `userStateService.getEffectiveDialogSettings`
 * (см. packages/api/src/services/user-state.service.ts:321).
 */

import type { ModelSettingDto } from "./models";

// Реэкспорт типа для потребителей (Chat.tsx импортирует отсюда).
export type { ModelSettingsRoot };

/** GET /web/model-settings → весь корень (user-level + `dialog:<id>` overrides). */
export async function getAllModelSettings(): Promise<ModelSettingsRoot> {
  const data = await apiClient("/web/model-settings");
  return modelSettingsRootSchema.parse(data);
}

/** PATCH /web/model-settings — мердж/replace для конкретного modelId. */
export function setUserModelSettings(
  modelId: string,
  settings: Record<string, unknown>,
  replace?: boolean,
) {
  return apiClient<ModelSettingsSuccessResponse, PatchModelSettingsBody>("/web/model-settings", {
    method: "PATCH",
    body: { modelId, settings, ...(replace ? { replace: true } : {}) },
  });
}

/** PATCH /web/model-settings/dialog/:dialogId — мердж dialog-level override'ов. */
export function setDialogModelSettings(dialogId: string, settings: Record<string, unknown>) {
  return apiClient<ModelSettingsSuccessResponse, PatchDialogModelSettingsBody>(
    `/web/model-settings/dialog/${encodeURIComponent(dialogId)}`,
    { method: "PATCH", body: { settings } },
  );
}

/**
 * Резолвит эффективные значения настроек для модели/диалога. Зеркалит
 * `userStateService.getEffectiveDialogSettings` (packages/api/src/services/user-state.service.ts:321):
 *   defaults < user-level overrides < dialog-level overrides.
 *
 * `dialogId === null` → юзер ещё не создал диалог (черновик в empty view),
 * берём только defaults + user-level.
 */
export function resolveEffectiveSettings(
  root: ModelSettingsRoot,
  modelId: string,
  dialogId: string | null,
  settings: readonly ModelSettingDto[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of settings) {
    if (s.default !== null) out[s.key] = s.default;
  }
  const userLevel = root[modelId];
  if (userLevel) Object.assign(out, userLevel);
  if (dialogId) {
    const dialogLevel = root[`dialog:${dialogId}`];
    if (dialogLevel) Object.assign(out, dialogLevel);
  }
  return out;
}
