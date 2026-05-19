import { apiClient } from "./client";

/**
 * Эндпоинты `/model-settings/*` — те же, что юзает мини-аппа и бот.
 *
 * Хранилище плоское: `{ [modelId]: { [key]: value } }`, а dialog-overrides
 * лежат под ключом `dialog:<dialogId>`. Эффективные настройки диалога =
 * `{...modelLevel, ...dialogLevel}` — мерджим клиент-сайдом через
 * `resolveEffectiveSettings`, как делает `userStateService.getEffectiveDialogSettings`
 * (см. packages/api/src/services/user-state.service.ts:321).
 */

import type { ModelSettingDto } from "./models";

export type ModelSettingsRoot = Record<string, Record<string, unknown>>;

/** GET /model-settings → весь корень (user-level + `dialog:<id>` overrides). */
export function getAllModelSettings() {
  return apiClient<ModelSettingsRoot>("/model-settings");
}

/** PATCH /model-settings — мердж/replace для конкретного modelId или ключа `dialog:<id>`. */
export function setUserModelSettings(
  modelId: string,
  settings: Record<string, unknown>,
  replace?: boolean,
) {
  return apiClient<
    { success: true },
    { modelId: string; settings: Record<string, unknown>; replace?: boolean }
  >("/model-settings", {
    method: "PATCH",
    body: { modelId, settings, ...(replace ? { replace: true } : {}) },
  });
}

/** PATCH /model-settings/dialog/:dialogId — мердж dialog-level override'ов. */
export function setDialogModelSettings(dialogId: string, settings: Record<string, unknown>) {
  return apiClient<{ success: true }, { settings: Record<string, unknown> }>(
    `/model-settings/dialog/${encodeURIComponent(dialogId)}`,
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
