import type { ModelSettingDto } from "@/api/models";

/** Грубо: видна ли настройка с учётом `dependsOn` (другая настройка == value). */
export function isSettingVisible(s: ModelSettingDto, values: Record<string, unknown>): boolean {
  if (!s.dependsOn) return true;
  return values[s.dependsOn.key] === s.dependsOn.value;
}

/** Типы пикеров, которые web пока не реализует — прячем их. */
export const UNSUPPORTED_TYPES = new Set<string>([
  // Generic voice-picker (без конкретного провайдера) и d-id-voice-picker —
  // пока не подключены.
  "voice-picker",
  "did-voice-picker",
]);
