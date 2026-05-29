import { i18n } from "@/i18n";
import { useModelsStore } from "@/stores/modelsStore";

/**
 * Резолв сырых `job.modelSettings` (Record<string, unknown>) в человекочитаемые
 * строки label/value для инфо-блока модалки превью. Лейблы и option-лейблы
 * берём из каталога моделей (`WebModelDto.settings`), значения select/dropdown
 * мапим на их `option.label`.
 *
 * Пропускаем настройки, у которых нет определения в каталоге, пустые значения и
 * объекты/массивы (например `shots` мультишота — он рендерится отдельной секцией).
 */

export type SettingRow = { label: string; value: string; advanced: boolean };

export function buildSettingsRows(
  modelId: string,
  modelSettings: Record<string, unknown> | null | undefined,
): SettingRow[] {
  if (!modelSettings) return [];
  const model = useModelsStore.getState().models.find((m) => m.id === modelId);
  if (!model) return [];

  const rows: SettingRow[] = [];
  // Порядок — как в каталоге (`model.settings`), а не как в объекте джобы.
  for (const def of model.settings) {
    if (!(def.key in modelSettings)) continue;
    const raw = modelSettings[def.key];
    if (raw === null || raw === undefined || raw === "") continue;
    if (typeof raw === "object") continue; // массивы/объекты (shots и т.п.) — не строка

    let value: string;
    if (def.type === "select" || def.type === "dropdown") {
      const opt = def.options?.find((o) => String(o.value) === String(raw));
      value = opt?.label ?? String(raw);
    } else if (def.type === "toggle") {
      value = raw ? i18n.t("common.on") : i18n.t("common.off");
    } else {
      value = String(raw);
    }

    rows.push({ label: def.label, value, advanced: !!def.advanced });
  }
  return rows;
}
