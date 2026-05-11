import { db } from "../db.js";
import { WELCOME_BONUS_TOKENS } from "@metabox/shared";
import type { UserDto, Language } from "@metabox/shared";
import type { User } from "@prisma/client";

function mapUser(user: User): UserDto {
  return {
    id: user.id,
    username: user.username ?? undefined,
    firstName: user.firstName ?? undefined,
    lastName: user.lastName ?? undefined,
    language: user.language as Language,
    tokenBalance: Number(user.tokenBalance),
    isNew: user.isNew,
    isBlocked: user.isBlocked,
    createdAt: user.createdAt,
    referredById: user.referredById ?? null,
    metaboxUserId: user.metaboxUserId ?? null,
  };
}

export const userService = {
  async findById(id: bigint): Promise<UserDto | null> {
    const user = await db.user.findUnique({ where: { id } });
    return user ? mapUser(user) : null;
  },

  async updateProfile(
    id: bigint,
    params: { username?: string; firstName?: string; lastName?: string },
  ): Promise<void> {
    await db.user.update({
      where: { id },
      data: {
        username: params.username,
        firstName: params.firstName,
        lastName: params.lastName,
      },
    });
  },

  async upsert(params: {
    id: bigint;
    username?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<UserDto> {
    const { id, username, firstName, lastName } = params;
    const user = await db.user.upsert({
      where: { id },
      create: { id, username, firstName, lastName },
      update: { username, firstName, lastName },
    });
    return mapUser(user);
  },

  async setLanguage(userId: bigint, language: Language): Promise<UserDto> {
    const user = await db.user.update({
      where: { id: userId },
      data: { language },
    });
    return mapUser(user);
  },

  /**
   * Начисляет welcome-бонус, если ещё не начислялся (проверка через
   * `welcome_bonus_receipts`). Возвращает `true` если токены реально
   * зачислены в этом вызове, `false` если был пропуск (дубль). Caller
   * использует возвращаемое значение, чтобы не показывать сообщение
   * «вот ваши N приветственных токенов», когда фактически начисления не было.
   */
  async creditWelcomeBonus(userId: bigint): Promise<boolean> {
    // Дедуп через welcome_bonus_receipts (без FK, переживает удаление User).
    // Кейс: юзер /start → бонус → удаление аккаунта → /start заново. Без
    // receipt'а isNew=true у новой User-строки → бонус выдавался повторно.
    const existingReceipt = await db.welcomeBonusReceipt.findUnique({
      where: { telegramId: userId },
    });
    if (existingReceipt) {
      // Выставляем isNew=false — иначе /start продолжит идти по new-ветке
      // (показывать "tokensGranted", онбординг и т.д.) на каждом запуске.
      await db.user.update({
        where: { id: userId },
        data: { isNew: false },
      });
      return false;
    }

    // End of day MSK (23:59:59.999 Moscow time) for trial period
    const rawEnd = new Date();
    rawEnd.setDate(rawEnd.getDate() + 3);
    const mskDateStr = rawEnd.toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" });
    const trialEndDate = new Date(mskDateStr + "T23:59:59.999+03:00");

    // Receipt создаём ВНУТРИ той же транзакции, что и начисление: при
    // конкурентном /start unique-violation на telegramId откатит весь батч
    // и не задвоит начисление; на следующем /start ранний return сработает.
    await db.$transaction([
      db.user.update({
        where: { id: userId },
        data: {
          isNew: false,
          subscriptionTokenBalance: { increment: WELCOME_BONUS_TOKENS },
        },
      }),
      db.tokenTransaction.create({
        data: {
          userId,
          amount: WELCOME_BONUS_TOKENS,
          type: "credit",
          reason: "welcome_bonus",
        },
      }),
      db.welcomeBonusReceipt.create({
        data: {
          telegramId: userId,
          amount: WELCOME_BONUS_TOKENS,
        },
      }),
    ]);

    // Create Trial subscription ТОЛЬКО если у юзера ещё нет LocalSubscription.
    //
    // Кейс который чиним: юзер сначала купил бандл с бонус-подпиской на сайте,
    // потом перешёл по ссылке в бота. handleStart успел дёрнуть verifyLinkToken,
    // metabox через reconcileSubscription Case 2 создал LocalSubscription с
    // planName="PRO" в боте. После этого юзер выбирает язык — и здесь раньше
    // upsert.update перезаписывал planName на "Trial", из-за чего в профиле
    // отображалась триал-подписка вместо подарочной.
    //
    // Welcome-бонус токены [WELCOME_BONUS_TOKENS] всё равно начисляем — это
    // отдельный приветственный подарок, не связанный с подпиской.
    const existing = await db.localSubscription.findUnique({ where: { userId } });
    if (!existing) {
      await db.localSubscription.create({
        data: {
          userId,
          planName: "Trial",
          period: "M1",
          tokensGranted: WELCOME_BONUS_TOKENS,
          startDate: new Date(),
          endDate: trialEndDate,
          isActive: true,
        },
      });
    }

    return true;
  },
};
