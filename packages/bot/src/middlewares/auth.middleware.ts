import type { MiddlewareFn } from "grammy";
import type { BotContext } from "../types/context.js";
import { userService } from "../services/user.service.js";
import { getT } from "@metabox/shared";

/**
 * Только lookup — не создаёт юзера автоматически. Юзер регистрируется ТОЛЬКО
 * через `/start` (handleStart сам делает upsert).
 *
 * Зачем: до этой правки middleware делал `upsert` на каждое сообщение, и юзер,
 * удаливший аккаунт через mini-app, моментально воссоздавался при следующем
 * любом сообщении в боте — теряя смысл "удаления".
 *
 * Если юзера нет в БД — `ctx.user` остаётся undefined, дальнейший gate-middleware
 * в `bot.ts` ответит "use /start". Для существующих юзеров — lazy-обновляем
 * profile-поля (username/firstName/lastName), чтобы они не протухали со временем.
 */
export const authMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (!ctx.from) return next();

  const { id, username, first_name, last_name } = ctx.from;
  const user = await userService.findById(BigInt(id));
  if (!user) return next();

  if (user.isBlocked) {
    await ctx.reply(getT("en").errors.userBlocked);
    return;
  }

  // Lazy-update profile fields, если изменились. Не блокируем основной flow
  // на этой записи — fire-and-forget с лог-fail.
  if (
    user.username !== (username ?? undefined) ||
    user.firstName !== (first_name ?? undefined) ||
    user.lastName !== (last_name ?? undefined)
  ) {
    void userService
      .updateProfile(BigInt(id), { username, firstName: first_name, lastName: last_name })
      .catch(() => void 0);
  }

  ctx.user = user;
  return next();
};
