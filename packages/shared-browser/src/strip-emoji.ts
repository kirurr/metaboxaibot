/**
 * Убирает ведущий эмодзи-префикс из строки.
 *
 * Имена моделей/семейств в каталоге хранятся в формате `<эмодзи> <текст>`
 * (например `💬 GPT 5.5`, `✂️ Удаление фона`). Для веб-UI эмодзи не нужен —
 * там бренд рисуется отдельной SVG-иконкой. Бот по-прежнему использует
 * исходное имя с эмодзи.
 *
 * Срезаем ведущую последовательность из pictographic-символов, variation
 * selector'ов (U+FE0F), zero-width joiner'ов (U+200D) и пробелов. Строки без
 * эмодзи (напр. `Suno (apipass fallback)`) возвращаются без изменений.
 *
 * Browser-safe (без node-зависимостей) — поэтому живёт в `shared-browser`,
 * чтобы и `web`, и бэкенд (через re-export из `@metabox/shared`) могли его звать.
 */
export function stripLeadingEmoji(s: string): string {
  return s.replace(/^[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]+/u, "").trim();
}
