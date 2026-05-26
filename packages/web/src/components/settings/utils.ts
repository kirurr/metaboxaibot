import type { ModelSettingDto } from "@/api/models";

/** Грубо: видна ли настройка с учётом `dependsOn` (другая настройка == value).
 *
 * `allSettings` (опц.) нужен для inverse-зависимостей (`value: false`): пока
 * юзер не тронул контролирующий тогл, его значение в `values` отсутствует
 * (`undefined`), и сравнение `undefined === false` ошибочно прятало бы
 * настройку. Падаем на `default` контролирующей настройки, если значения нет. */
export function isSettingVisible(
  s: ModelSettingDto,
  values: Record<string, unknown>,
  allSettings?: readonly ModelSettingDto[],
): boolean {
  if (!s.dependsOn) return true;
  const { key, value } = s.dependsOn;
  const raw = values[key];
  const effective = raw !== undefined ? raw : allSettings?.find((x) => x.key === key)?.default;
  return effective === value;
}

/** Типы пикеров, которые web пока не реализует — прячем их. */
export const UNSUPPORTED_TYPES = new Set<string>([
  // Generic voice-picker (без конкретного провайдера) и d-id-voice-picker —
  // пока не подключены.
  "voice-picker",
  "did-voice-picker",
]);
