/**
 * DTO для persisted user-state модельных настроек: тело PATCH-эндпоинтов
 * `/web/model-settings*` и shape ответа GET. Шарится между бэком
 * (`packages/api/src/routes/web-model-settings.ts`) и фронтом
 * (`packages/web/src/api/modelSettings.ts`).
 *
 * Не путать с `model-setting.ts` — там описания контролов (`ModelSettingDef`).
 */

import z from "zod";

const settingsValueSchema = z.record(z.string(), z.unknown());

/**
 * Корень storage. Ключ — либо `modelId`, либо `dialog:<dialogId>` (overrides
 * на уровне конкретного диалога). Значение — плоский bag настроек.
 */
export const modelSettingsRootSchema = z.record(z.string(), settingsValueSchema);

export const patchModelSettingsBodySchema = z.object({
  modelId: z.string().min(1),
  settings: settingsValueSchema,
  replace: z.boolean().optional(),
});

export const patchDialogModelSettingsBodySchema = z.object({
  settings: settingsValueSchema,
});

export const modelSettingsSuccessResponseSchema = z.object({
  success: z.literal(true),
});

export type ModelSettingsRoot = z.infer<typeof modelSettingsRootSchema>;
export type PatchModelSettingsBody = z.infer<typeof patchModelSettingsBodySchema>;
export type PatchDialogModelSettingsBody = z.infer<typeof patchDialogModelSettingsBodySchema>;
export type ModelSettingsSuccessResponse = z.infer<typeof modelSettingsSuccessResponseSchema>;
