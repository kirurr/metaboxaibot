import { Keyboard } from "grammy";
import type { Translations } from "@metabox/shared";
import { config, generateWebToken } from "@metabox/shared";

/**
 * `telegramId` — tgid юзера для встраивания в wtoken (бот→webapp re-auth).
 * Не путать с внутренним `User.id`: wtoken идёт в telegram-auth.ts middleware,
 * который ищет юзера по `telegramId`.
 */
export function buildMainMenuKeyboard(t: Translations, telegramId?: bigint | null): Keyboard {
  const webappUrl = config.bot.webappUrl;
  const kb = new Keyboard();

  if (webappUrl && telegramId) {
    const token = generateWebToken(telegramId, config.bot.token);
    kb.webApp(t.menu.profile, `${webappUrl}?page=profile&wtoken=${token}`);
  } else if (webappUrl) {
    kb.webApp(t.menu.profile, `${webappUrl}?page=profile`);
  } else {
    kb.text(t.menu.profile);
  }

  kb.row().text(t.menu.gpt).text(t.menu.design).row().text(t.menu.audio).text(t.menu.video).row();

  if (webappUrl && telegramId) {
    const token = generateWebToken(telegramId, config.bot.token);
    kb.webApp(t.menu.storage, `${webappUrl}?page=profile&section=gallery&wtoken=${token}`).row();
  } else if (webappUrl) {
    kb.webApp(t.menu.storage, `${webappUrl}?page=gallery`).row();
  } else {
    kb.text(t.menu.storage).row();
  }

  return kb.text(t.menu.help).text(t.menu.language).resized().persistent();
}
