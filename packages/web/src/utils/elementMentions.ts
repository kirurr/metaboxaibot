import type { Element } from "@/api/elements";

/**
 * @-меншены элементов в промпте генерации (MVP — фронтовая трансляция).
 *
 * Юзер пишет `@имя_элемента` в промпте (через кнопку @Elements или inline-`@`).
 * Перед отправкой мы транслируем эти имена в каноническую позиционную форму
 * `@Element1/@Element2/...`, которую уже понимает бэкенд (validatePromptRefs,
 * kie.adapter, translatePromptRefs), а выбранные картинки кладём в слоты
 * `ref_element_1/2/...`. Бэкенд при этом не меняется.
 *
 * ⚠️ MVP-ограничение: в генерацию (и значит в историю/«Повторить») уходит уже
 * транслированный промпт `@Element1`, а не дружелюбный `@имя`. Будущая итерация —
 * нативные именованные рефы на бэкенде.
 */

/**
 * Токены `@word`, НЕ предварённые word-символом (чтобы не цеплять email).
 * Зеркало `AT_TOKEN_RE` из `@metabox/shared` (packages/shared/src/prompt-refs/
 * canonical.ts) — продублировано, т.к. web зависит только от shared-browser.
 * Имя начинается с буквы/подчёркивания: элементы с именем, начинающимся с
 * цифры, токеном не распознаются (как и на бэке) и активными не станут.
 */
const AT_TOKEN_RE = /(?<!\w)@([A-Za-z_]\w*)/g;

/** Активный элемент = распознанный в промпте @-меншен, привязанный к слоту. */
export type ActiveMention = {
  element: Element;
  /** 1-based индекс слота `ref_element_{slotIndex}` / `@Element{slotIndex}`. */
  slotIndex: number;
};

/**
 * Распознаёт все РАЗНЫЕ элементы, упомянутые в промпте через `@имя`, в порядке
 * первого появления. slotIndex назначается последовательно (1, 2, 3...).
 *
 * Возвращает полный список без обрезки по лимиту — caller сам решает, что делать
 * с переполнением (см. `max` в модели): обычно показать ошибку и заблокировать
 * Generate. Это позволяет UI отличить «ровно max» от «больше max».
 */
export function parseActiveMentions(prompt: string, elements: Element[]): ActiveMention[] {
  const byName = new Map(elements.map((el) => [el.name, el]));
  const seen = new Set<string>();
  const out: ActiveMention[] = [];
  const re = new RegExp(AT_TOKEN_RE.source, AT_TOKEN_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const name = m[1];
    const el = byName.get(name);
    if (!el || seen.has(el.id)) continue;
    seen.add(el.id);
    out.push({ element: el, slotIndex: out.length + 1 });
  }
  return out;
}

/** Экранирует строку для безопасной вставки в RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Заменяет дружелюбные `@имя` на каноническую форму `@Element{slotIndex}`,
 * понятную бэкенду. Заменяем только токены, не предварённые word-символом
 * (та же семантика, что у AT_TOKEN_RE), чтобы не задеть email/части слов.
 */
export function translateMentionsToCanonical(
  prompt: string,
  mentions: ActiveMention[],
): string {
  let result = prompt;
  for (const { element, slotIndex } of mentions) {
    const re = new RegExp(`(?<!\\w)@${escapeRegExp(element.name)}(?!\\w)`, "g");
    result = result.replace(re, `@Element${slotIndex}`);
  }
  return result;
}

/**
 * Строит `{ ref_element_N: s3Key[] }` из активных меншенов и выбора картинок.
 *
 * `selections` — мапа elementId → выбранные s3Key. Если для элемента выбора нет
 * (или выбранные s3Key больше не существуют в media) — фоллбэк на первые
 * `maxImages` картинок элемента. Элементы без единой картинки пропускаются.
 */
export function buildElementMediaInputs(
  mentions: ActiveMention[],
  selections: Record<string, string[]>,
  maxImages: number,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { element, slotIndex } of mentions) {
    const available = new Set(element.media.map((mm) => mm.s3Key));
    const picked = (selections[element.id] ?? []).filter((k) => available.has(k));
    const keys =
      picked.length > 0 ? picked.slice(0, maxImages) : element.media.slice(0, maxImages).map((mm) => mm.s3Key);
    if (keys.length > 0) out[`ref_element_${slotIndex}`] = keys;
  }
  return out;
}
