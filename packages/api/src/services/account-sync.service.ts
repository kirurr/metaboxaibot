/**
 * Account-sync для ai.metabox.global flow.
 *
 * Задача — поддерживать соответствие 1:1 между Metabox User и AI Box User.
 *
 * До этого AI Box User создавался ТОЛЬКО когда юзер делал /start linkweb_<state>
 * в боте — без привязки TG юзер регистрировался на сайте, но в AI Box DB
 * записи не было, и `webTelegramLinkedPreHandler` блокировал ему все web-роуты
 * (чат, токены, галерея, тарифы) c 403 TELEGRAM_NOT_LINKED.
 *
 * Теперь:
 *  - на web-логине проверяем, есть ли AI Box User по metaboxUserId;
 *  - если нет — создаём (telegramId=null, language="ru") и синхронизируем
 *    подписку + token-pack ордера, которые могли быть куплены через
 *    metabox-сторону до того, как юзер вообще зашёл в AI Box;
 *  - в результате `aibUserId` в JWT всегда есть, и
 *    `webTelegramLinkedPreHandler` пропускает.
 */

import { db } from "../db.js";
import { logger } from "../logger.js";
import {
  followMetaboxMergeChain,
  getPendingTokenGrantsByMetabox,
  getSubscriptionStatusByMetabox,
  markOrderGrantedOnMetabox,
  markTokensGrantedOnMetabox,
  reconcileByAibox,
  setAiboxId,
} from "./metabox-bridge.service.js";

interface EnsureUserParams {
  metaboxUserId: string;
  firstName?: string | null;
  lastName?: string | null;
  language?: string;
  /** Metabox referralCode — пишется в `User.metaboxReferralCode` при первом
   *  create. Если у existing User уже выставлен другой — не перетираем
   *  (referralCode не меняется на metabox-стороне, drift'а ожидать не стоит). */
  metaboxReferralCode?: string | null;
}

interface EnsuredUser {
  id: bigint;
  telegramId: bigint | null;
  metaboxUserId: string | null;
  created: boolean;
}

/**
 * Гарантирует, что AI Box User для данного metaboxUserId существует.
 * Возвращает пользователя; если только что создал — синкает подписку и
 * pending-token-grants с metabox-стороны (best-effort, ошибки логируются
 * и не блокируют логин).
 *
 * NB: если на metabox есть несколько AI Box User'ов с одинаковым metaboxUserId
 * (теоретически возможно, т.к. поле НЕ @unique — может произойти при
 * редком race с bot /start linkweb_), берётся первый найденный. Long-term
 * — merge-логика в linkweb-flow + unique constraint.
 */
export async function ensureAibUserForMetabox(params: EnsureUserParams): Promise<EnsuredUser> {
  // Resolve live metaboxUserId через merge-chain. Если metabox-сторона
  // мёржнула R в другого юзера (R стал secondary), мы ходим за primary'м —
  // иначе AI Box User остался бы привязан к мёртвому id и любые subsequent
  // вызовы (invoice, subscription) уходили бы в никуда.
  //
  // Fail-open: ошибка metabox-bridge не должна валить login. Используем
  // исходный id и логируем; при следующем рефреше попробуем снова.
  let liveMetaboxUserId = params.metaboxUserId;
  try {
    liveMetaboxUserId = await followMetaboxMergeChain(params.metaboxUserId);
  } catch (err) {
    logger.warn(
      { err, metaboxUserId: params.metaboxUserId },
      "[ensureAibUser] followMergeChain failed — using original id",
    );
  }

  // Ищем по live id (после-merge primary).
  let existing = await db.user.findFirst({
    where: { metaboxUserId: liveMetaboxUserId },
    select: { id: true, telegramId: true, metaboxUserId: true, metaboxReferralCode: true },
  });

  // Stale-cache case: AI Box User существует, но привязан к старому (frozen
  // secondary) metaboxUserId — обновляем поле на live primary.
  if (!existing && liveMetaboxUserId !== params.metaboxUserId) {
    const stale = await db.user.findFirst({
      where: { metaboxUserId: params.metaboxUserId },
      select: { id: true, telegramId: true, metaboxUserId: true, metaboxReferralCode: true },
    });
    if (stale) {
      await db.user.update({
        where: { id: stale.id },
        data: { metaboxUserId: liveMetaboxUserId },
      });
      logger.info(
        {
          userId: stale.id.toString(),
          from: params.metaboxUserId,
          to: liveMetaboxUserId,
        },
        "[ensureAibUser] updated AI Box User to live metaboxUserId after metabox-side merge",
      );
      existing = { ...stale, metaboxUserId: liveMetaboxUserId };
    }
  }

  if (existing) {
    // Backfill metaboxReferralCode для legacy юзеров: до текущего фикса
    // ensureAibUser не писал поле, и юзеры созданные ранее имеют null.
    // Обновляем только если у нас сейчас есть свежее значение от
    // webValidateCredentials и у юзера в БД пусто.
    if (params.metaboxReferralCode && !existing.metaboxReferralCode) {
      await db.user.update({
        where: { id: existing.id },
        data: { metaboxReferralCode: params.metaboxReferralCode },
      });
    }

    // Existing User: всё равно дёргаем setAiboxId + reconcileByAibox.
    // Это catch-up для legacy юзеров, которые создавались ДО фикса A1 и
    // потому на metabox-стороне у них может ещё не быть aiboxUserId или в
    // pendingBot* лежать админ-гранты, недоставленные из-за прежнего гейта
    // на telegramId. Обе bridge-функции best-effort + идемпотентны
    // (`setAiboxId` → `alreadySet:true`, `reconcileByAibox` → `case:'none'`),
    // так что повторные вызовы не делают вреда.
    await setAiboxId({ metaboxUserId: liveMetaboxUserId, aiboxUserId: existing.id });
    await reconcileByAibox({ metaboxUserId: liveMetaboxUserId, aiboxUserId: existing.id });
    return { ...existing, created: false };
  }

  const created = await db.user.create({
    data: {
      // telegramId оставляем null — web-only юзер. Все Telegram-операции
      // (chat-уведомления, ctx.from lookup в боте) у такого юзера не
      // работают, но web-API роуты не требуют tgid после фикса.
      telegramId: null,
      firstName: params.firstName ?? null,
      lastName: params.lastName ?? null,
      language: params.language ?? "ru",
      metaboxUserId: liveMetaboxUserId,
      // referralCode пишем сразу — иначе web-фронт после web-login видит
      // null в `Profile.referralCode` и не может показать партнёрский код.
      metaboxReferralCode: params.metaboxReferralCode ?? null,
      // isNew=true оставляем дефолтом — welcome-flow в боте триггерится через
      // первый /start (не наш случай); на вебе никаких welcome-сообщений нет.
    },
    select: { id: true, telegramId: true, metaboxUserId: true },
  });

  logger.info(
    { userId: created.id.toString(), metaboxUserId: liveMetaboxUserId },
    "[ensureAibUser] created web-only AI Box User",
  );

  // Двусторонняя связь: пушим наш id обратно на metabox, чтобы admin grants/
  // subscriptions могли дойти к web-only юзеру (без telegramId).
  // Errors swallowed by bridge — best-effort, ретрай произойдёт на следующем
  // refresh/login.
  try {
    await setAiboxId({ metaboxUserId: liveMetaboxUserId, aiboxUserId: created.id });
  } catch (err) {
    logger.warn(
      { err, userId: created.id.toString(), metaboxUserId: liveMetaboxUserId },
      "[ensureAibUser] setAiboxId failed (will retry on next refresh)",
    );
  }

  // Catch-up: если у этого metabox-юзера есть pendingBot* (накопились до
  // фикса A1, когда admin grants не доставлялись web-only юзерам), просим
  // metabox flush'нуть их в бот через reconcileSubscription по нашему
  // aiboxUserId. Для свежих signup-юзеров pendingBot* пустые — endpoint
  // отрабатывает мгновенно без эффектов. Bridge сам swallow'ит ошибки.
  await reconcileByAibox({
    metaboxUserId: liveMetaboxUserId,
    aiboxUserId: created.id,
  });

  // Sync — best effort. Любая ошибка тут не блокирует логин, юзер залогинится
  // и ребёнок UI; следующий рефреш/логин ретрайнет.
  try {
    await syncTokenGrantsForWebUser(created.id, liveMetaboxUserId);
  } catch (err) {
    logger.error(
      { err, userId: created.id.toString(), metaboxUserId: liveMetaboxUserId },
      "[ensureAibUser] token-grants sync failed",
    );
  }
  try {
    await syncSubscriptionForWebUser(created.id, liveMetaboxUserId);
  } catch (err) {
    logger.error(
      { err, userId: created.id.toString(), metaboxUserId: liveMetaboxUserId },
      "[ensureAibUser] subscription sync failed",
    );
  }

  return { ...created, created: true };
}

/**
 * Merge web-only AI Box User в bot-side User. Вызывается в bot.ts linkweb_-
 * flow когда мы обнаруживаем, что для приходящего metaboxUserId уже
 * существует другой User (web-only, создан через web-логин).
 *
 * Стратегия:
 *  - source (web-only): создан через ensureAibUserForMetabox при web-login.
 *    `telegramId=null`, есть `metaboxUserId`, могут быть dialogs/tokens/
 *    подписка после sync.
 *  - target (bot): создан через /start в боте. `telegramId` есть,
 *    `metaboxUserId` ещё null. Сейчас линкуем.
 *
 * После merge остаётся только target (с tgid+metaboxUserId и
 * суммированными балансами/перенесёнными relations). source удаляется.
 *
 * Идемпотентность: source может не существовать (если merge уже отработал
 * раньше или web-юзера никогда не было) — в этом случае no-op.
 */
export async function mergeWebUserIntoBotUser(
  sourceUserId: bigint,
  targetUserId: bigint,
): Promise<void> {
  if (sourceUserId === targetUserId) return;

  await db.$transaction(async (tx) => {
    const source = await tx.user.findUnique({
      where: { id: sourceUserId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        tokenBalance: true,
        subscriptionTokenBalance: true,
      },
    });
    if (!source) return; // already merged or never existed

    const target = await tx.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!target) {
      throw new Error(`mergeWebUserIntoBotUser: target user ${targetUserId} not found`);
    }

    // ── 1. Накапливаем балансы и подтягиваем профиль ────────────────────────
    // firstName/lastName из source перенимаем только если target не имеет.
    // Bot-side userState/onboarding/language оставляем target'у — он более
    // "активный" контекст для юзера в этот момент.
    await tx.user.update({
      where: { id: targetUserId },
      data: {
        tokenBalance: { increment: source.tokenBalance },
        subscriptionTokenBalance: { increment: source.subscriptionTokenBalance },
        ...(target.firstName || !source.firstName ? {} : { firstName: source.firstName }),
        ...(target.lastName || !source.lastName ? {} : { lastName: source.lastName }),
      },
    });

    // ── 2. Многозаписные relations: переключаем userId ──────────────────────
    // Cascade-delete нас не достанет — после updateMany записи указывают
    // на target, source становится пустым.
    await tx.dialog.updateMany({
      where: { userId: sourceUserId },
      data: { userId: targetUserId },
    });
    await tx.tokenTransaction.updateMany({
      where: { userId: sourceUserId },
      data: { userId: targetUserId },
    });
    await tx.userUpload.updateMany({
      where: { userId: sourceUserId },
      data: { userId: targetUserId },
    });
    await tx.userAvatar.updateMany({
      where: { userId: sourceUserId },
      data: { userId: targetUserId },
    });
    await tx.userVoice.updateMany({
      where: { userId: sourceUserId },
      data: { userId: targetUserId },
    });
    await tx.galleryFolder.updateMany({
      where: { userId: sourceUserId },
      data: { userId: targetUserId },
    });
    await tx.generationJob.updateMany({
      where: { userId: sourceUserId },
      data: { userId: targetUserId },
    });
    await tx.webNotification.updateMany({
      where: { userId: sourceUserId },
      data: { userId: targetUserId },
    });

    // ── 3. Рефералы: если кто-то был referredById = source, теперь target ───
    await tx.user.updateMany({
      where: { referredById: sourceUserId },
      data: { referredById: targetUserId },
    });

    // ── 4. Singletons ──────────────────────────────────────────────────────
    // LocalSubscription: source может иметь metabox-paid подписку
    // (засинкана при web-login), target — Trial из /start. Если source
    // содержит metaboxSubscriptionId — это «настоящая» подписка, она
    // важнее триала. Иначе оставляем target'у его триал.
    const sourceSub = await tx.localSubscription.findUnique({
      where: { userId: sourceUserId },
      select: { id: true, metaboxSubscriptionId: true },
    });
    const targetSub = await tx.localSubscription.findUnique({
      where: { userId: targetUserId },
      select: { id: true, metaboxSubscriptionId: true },
    });
    if (sourceSub) {
      const sourceIsReal = !!sourceSub.metaboxSubscriptionId;
      const targetIsReal = !!(targetSub && targetSub.metaboxSubscriptionId);
      if (!targetSub) {
        // У target нет подписки — забираем source's
        await tx.localSubscription.update({
          where: { userId: sourceUserId },
          data: { userId: targetUserId },
        });
      } else if (sourceIsReal && !targetIsReal) {
        // source — paid, target — Trial. Заменяем target'овую.
        await tx.localSubscription.delete({ where: { userId: targetUserId } });
        await tx.localSubscription.update({
          where: { userId: sourceUserId },
          data: { userId: targetUserId },
        });
      } else {
        // Иначе keep target's, удаляем source's.
        await tx.localSubscription.delete({ where: { userId: sourceUserId } });
      }
    }

    // UserState и PendingGeneration — bot-side контекст; web-юзер обычно
    // ничего туда не пишет (создаются только через бот-фичи). Если случайно
    // были — удаляем source's, у target всё своё.
    await tx.userState.deleteMany({ where: { userId: sourceUserId } });
    await tx.pendingGeneration.deleteMany({ where: { userId: sourceUserId } });

    // ── 5. Удаляем source. Cascade-delete не сработает ни на одну запись —
    // мы всё перенесли (relations теперь у target), референсов на source нет.
    await tx.user.delete({ where: { id: sourceUserId } });

    logger.info(
      {
        sourceUserId: sourceUserId.toString(),
        targetUserId: targetUserId.toString(),
        accumulatedTokens: source.tokenBalance.toString(),
        accumulatedSubTokens: source.subscriptionTokenBalance.toString(),
      },
      "[mergeWebUserIntoBotUser] merge complete",
    );
  });
}

/**
 * Применяет pending token-pack ордера с metabox-стороны. Аналог
 * `syncMetaboxGrants` в боте, но ключуется по metaboxUserId (для web-only
 * юзеров без telegramId). Идемпотентность — через GrantedMetaboxOrder
 * (orderId — PK), telegramId в записи остаётся null.
 */
async function syncTokenGrantsForWebUser(userId: bigint, metaboxUserId: string): Promise<void> {
  const pendingOrders = await getPendingTokenGrantsByMetabox(metaboxUserId);
  for (const order of pendingOrders) {
    try {
      const alreadyGranted = await db.grantedMetaboxOrder.findUnique({
        where: { orderId: order.orderId },
      });
      if (alreadyGranted) {
        await markOrderGrantedOnMetabox(order.orderId);
        continue;
      }

      await db.$transaction([
        db.user.update({
          where: { id: userId },
          data: { tokenBalance: { increment: order.tokens } },
        }),
        db.tokenTransaction.create({
          data: {
            userId,
            amount: order.tokens,
            type: "credit",
            reason: "metabox_purchase",
            description: order.description,
          },
        }),
        db.grantedMetaboxOrder.create({
          data: {
            orderId: order.orderId,
            telegramId: null,
            tokens: order.tokens,
            description: order.description,
          },
        }),
      ]);
      await markOrderGrantedOnMetabox(order.orderId);
    } catch (err) {
      logger.error(
        { err, orderId: order.orderId, userId: userId.toString() },
        "[syncTokenGrantsForWebUser] grant failed",
      );
    }
  }
}

/**
 * Синхронизирует активную подписку с metabox-стороны: апсёртит LocalSubscription
 * и, если `tokensGrantedToBot=false`, начисляет `tokensGranted` в
 * `User.subscriptionTokenBalance` (и помечает на metabox-стороне как выданные).
 *
 * Идемпотентность по подписочным токенам — через LocalSubscription с
 * `metaboxSubscriptionId`: если уже linked + active — пропускаем повторное
 * зачисление (параллель с `grantMetaboxSubscription`/`/internal/sync-subscription`).
 */
async function syncSubscriptionForWebUser(userId: bigint, metaboxUserId: string): Promise<void> {
  const status = await getSubscriptionStatusByMetabox(metaboxUserId);
  const sub = status.subscription;
  if (!sub) return;

  const endDate = new Date(sub.endDate);
  // startDate выводится из totalDays: эндпоинт возвращает только endDate,
  // но totalDays = (endDate − startDate) в днях.
  const startDate = new Date(endDate.getTime() - sub.totalDays * 86400000);
  const isActive = endDate > new Date();

  // 1. Credit подписочных токенов (только если ещё не начисляли).
  if (!sub.tokensGrantedToBot && sub.tokensGranted > 0) {
    const linked = await db.localSubscription.findUnique({
      where: { metaboxSubscriptionId: sub.subscriptionId },
    });
    const shouldCredit = !linked || !linked.isActive;
    if (shouldCredit) {
      await db.user.update({
        where: { id: userId },
        data: { subscriptionTokenBalance: { increment: sub.tokensGranted } },
      });
      await markTokensGrantedOnMetabox(sub.subscriptionId);
    }
  }

  // 2. Upsert LocalSubscription. У web-only юзера LocalSubscription'а ещё нет
  // (только что создали User), поэтому сработает create-ветка. Структура
  // соответствует `/internal/sync-subscription`.
  await db.localSubscription.upsert({
    where: { userId },
    create: {
      userId,
      planName: sub.planName,
      period: sub.period,
      tokensGranted: sub.tokensGranted,
      startDate,
      endDate,
      isActive,
      metaboxSubscriptionId: sub.subscriptionId,
    },
    update: {
      planName: sub.planName,
      period: sub.period,
      tokensGranted: sub.tokensGranted,
      startDate,
      endDate,
      isActive,
      metaboxSubscriptionId: sub.subscriptionId,
    },
  });
}
