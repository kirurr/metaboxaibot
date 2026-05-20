/**
 * Защита от утечки Telegram bot токена в исходящих сообщениях / логах.
 *
 * Контекст: Telegram bot file API имеет URL'ы вида
 * `https://api.telegram.org/file/bot<ID>:<SECRET>/...`. Эти URL'ы мы передаём
 * провайдерам (KIE / fal / evolink) когда юзер прислал фото или видео.
 * Провайдер может 4xx/5xx-нуть и эхнуть URL в error body → токен попадает в
 * `err.message` и далее по цепочке.
 *
 * Эта функция — pure-string scrub без зависимостей. Применяется:
 *  - В `notify-error.ts:serializeError` (первая линия: ops-алёрты и DB.error).
 *  - В `installBotTokenScrub` (вторая линия: grammY transformer на API
 *    instance'ах, см. соответствующие файлы в worker'е и боте; они дублируют
 *    install-логику, т.к. `api`-пакет не зависит от grammy).
 *
 * Идемпотентно: повторный scrub уже вычищенной строки — no-op.
 */

/**
 * Заменяет `bot<ID>:<SECRET>` → `bot<ID>:***`, оставляя ID для дебага
 * (полезно различать main vs test bot'а в логах) и скрывая секрет.
 *
 * Паттерн ID — цифры; секрет — base64-url-safe-ish (`A-Z`, `a-z`, `0-9`, `_`,
 * `-`), типичная длина ~35 символов.
 */
export function scrubBotTokens(s: string): string {
  return s.replace(/(bot\d+):[A-Za-z0-9_-]+/g, "$1:***");
}
