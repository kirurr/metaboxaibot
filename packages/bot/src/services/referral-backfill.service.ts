import { db } from "@metabox/api/db";
import { fetchDirectReferralsWithTelegram } from "@metabox/api/services";
import { logger } from "../logger.js";

/**
 * Backfill локального `User.referredById` для рефералов наставника, когда
 * он сам наконец запускает бота.
 *
 * Сценарий: реферал зарегистрировался в боте РАНЬШЕ наставника. В тот
 * момент строки наставника в `db.user` ещё не было, поэтому ref-ссылка
 * не сработала и его `referredById` остался null. На сайте при этом
 * связка существует (там ментор устанавливается без участия бота).
 * Когда наставник запускает бота — мы тянем его прямых рефералов с
 * Metabox и расставляем им `referredById` на стороне бота.
 *
 * Условие "только null": не перетираем уже установленный referredById.
 * Это защита от случая, когда юзера перенесли в другую ветку (на сайте
 * сменили наставника) и в боте уже стоит верное новое значение —
 * перезатирать его старым по ошибке нельзя.
 *
 * Идемпотентно: повторный запуск /start не сделает дополнительных
 * update'ов (updateMany отфильтрует по `referredById: null`).
 */
export async function backfillBotReferrals(
  mentorUserId: bigint,
  mentorMetaboxUserId: string,
): Promise<void> {
  const referrals = await fetchDirectReferralsWithTelegram(mentorMetaboxUserId);
  if (referrals.length === 0) return;

  // Metabox возвращает tgid рефералов; после decoupling-миграции
  // `referredById` — это FK к внутреннему `User.id`, а матчить пользователей
  // надо по `telegramId`. Поэтому ищем по `telegramId` IN (...) и проставляем
  // mentor'у внутренний id.
  const telegramIds = referrals.map((r) => BigInt(r.telegramId));

  const result = await db.user.updateMany({
    where: {
      telegramId: { in: telegramIds },
      referredById: null,
    },
    data: { referredById: mentorUserId },
  });

  if (result.count > 0) {
    logger.info(
      {
        mentorUserId: mentorUserId.toString(),
        mentorMetaboxUserId,
        candidates: telegramIds.length,
        linked: result.count,
      },
      "[referral-backfill] linked direct referrals on bot side",
    );
  }
}
