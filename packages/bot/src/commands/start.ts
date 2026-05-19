import { InlineKeyboard } from "grammy";
import type { BotContext } from "../types/context.js";
import { userService } from "../services/user.service.js";
import { backfillBotReferrals } from "../services/referral-backfill.service.js";
import { userStateService } from "@metabox/api/services";
import { db } from "@metabox/api/db";
import { buildLanguageKeyboard } from "../keyboards/language.keyboard.js";
import { buildMainMenuKeyboard } from "../keyboards/main-menu.keyboard.js";
import { SUPPORTED_LANGUAGES, getT, config } from "@metabox/shared";
import type { Language, Translations } from "@metabox/shared";
import {
  verifyLinkToken,
  getPendingTokenGrants,
  markOrderGrantedOnMetabox,
  consumeLinkTelegramState,
  markLinkTelegramLinked,
} from "@metabox/api/services";
import { logger } from "../logger.js";

/**
 * Sync pending token-pack orders from Metabox for a newly linked/started user.
 * Note: subscription sync is handled by site via /internal/sync-subscription on connect.
 *
 * Идемпотентность — таблица `granted_metabox_orders` на bot-стороне:
 *  - Перед зачислением проверяем, не выдавался ли уже этот orderId. Если да —
 *    скипаем зачисление, но всё равно дёргаем mark-order-granted на metabox'е
 *    (на случай, если в прошлый раз HTTP-вызов сорвался между записью на боте
 *    и flip'ом tokensGrantedToBot на сайте).
 *  - Зачисление + insert в GrantedMetaboxOrder идут одной db.$transaction —
 *    unique-violation на orderId откатит весь батч, токены не задвоятся.
 */
async function syncMetaboxGrants(userId: bigint, telegramId: bigint): Promise<void> {
  // Token-pack orders sync. `telegramId` идёт во внешние вызовы (Metabox lookup +
  // ключ GrantedMetaboxOrder), `userId` — внутренний FK для User.update / TokenTransaction.
  const pendingOrders = await getPendingTokenGrants(telegramId);
  for (const order of pendingOrders) {
    try {
      const alreadyGranted = await db.grantedMetaboxOrder.findUnique({
        where: { orderId: order.orderId },
      });
      if (alreadyGranted) {
        // Запись есть — токены уже зачислялись. Чистим metabox-state
        // (mark-order-granted идемпотентен) и идём дальше.
        await markOrderGrantedOnMetabox(order.orderId);
        logger.info(
          { orderId: order.orderId, userId: userId.toString(), telegramId: telegramId.toString() },
          "[syncMetaboxGrants] order already granted — skip credit, refresh metabox flag",
        );
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
            telegramId,
            tokens: order.tokens,
            description: order.description,
          },
        }),
      ]);
      await markOrderGrantedOnMetabox(order.orderId);
    } catch (err) {
      logger.error({ err, orderId: order.orderId }, "[syncMetaboxGrants] token order grant failed");
    }
  }
}

/**
 * Отправляет «полный пакет» приветственных сообщений (welcome с дисклеймером
 * и picker'ом языка → tokensGranted/balance → onboarding/main-menu) в указанном
 * языке. Используется в /start и при смене языка через picker — чтобы юзер
 * получил тот же набор сообщений на новом языке без редактирования старых
 * (они остаются в истории как есть).
 */
async function sendStartMessages(
  ctx: BotContext,
  lang: Language,
  opts: { isNew: boolean; tokenBalance: number },
): Promise<void> {
  const t = getT(lang);

  // Welcome — для RU юзеров шлём bilingual (RU + EN), для остальных только
  // в целевом языке. {landingUrl} встречается многократно (ссылка на каждый
  // юр. документ) — replaceAll обязателен.
  const landingUrl = config.metabox.landingUrl;
  let welcome: string;
  if (lang === "ru") {
    const divider = "________________________";
    const ruWelcome = getT("ru").start.welcome.replaceAll("{landingUrl}", landingUrl);
    const enWelcome = getT("en").start.welcome.replaceAll("{landingUrl}", landingUrl);
    welcome = `${ruWelcome}\n\n${divider}\n\n${enWelcome}`;
  } else {
    welcome = t.start.welcome.replaceAll("{landingUrl}", landingUrl);
  }
  await ctx.reply(welcome, {
    reply_markup: buildLanguageKeyboard("langset_"),
    parse_mode: "HTML",
  });

  // Inline-кнопка профиля в мини-аппе (если webappUrl настроен).
  const webappUrl = config.bot.webappUrl;
  const profileKb = webappUrl
    ? new InlineKeyboard().webApp(t.menu.profile, `${webappUrl}?page=profile`)
    : undefined;

  if (opts.isNew) {
    await ctx.reply(t.start.tokensGranted, profileKb ? { reply_markup: profileKb } : undefined);
  } else {
    const balance = opts.tokenBalance.toFixed(2);
    const balanceText = t.start.yourBalance.replace("{balance}", balance);
    await ctx.reply(balanceText, profileKb ? { reply_markup: profileKb } : undefined);
  }

  if (opts.isNew) {
    const onboardingKb = new InlineKeyboard().text(t.start.onboardingGotIt, "onboarding_ok");
    await ctx.reply(t.start.onboarding, {
      parse_mode: "HTML",
      reply_markup: onboardingKb,
    });
  } else {
    // Возвращающимся юзерам сразу персистентная reply-клавиатура — со свежими
    // wtoken'ами в webApp-кнопках, протухшие URL'ы заменяются.
    await ctx.reply(t.start.mainMenuTitle, {
      reply_markup: buildMainMenuKeyboard(t, ctx.user!.telegramId),
    });
  }
}

/**
 * /start — handles deep link params, resets FSM state, shows language selection.
 *
 * Supported deep link params:
 *   /start link_<TOKEN>  — Metabox→Bot account linking (TelegramAuthToken)
 *   /start ref_<TG_ID>   — referral link from another bot user
 */
export async function handleStart(ctx: BotContext): Promise<void> {
  const param = ctx.match as string | undefined;

  // ── User registration ────────────────────────────────────────────────────
  // authMiddleware больше не создаёт юзера автоматически (см. middleware doc),
  // поэтому при первом /start (или после удаления аккаунта) `ctx.user` пуст.
  // Создаём здесь — это единственная точка регистрации в боте. `id` присваивается
  // sequence'ой (автоинкремент); `telegramId` — уникальный tgid из ctx.from.
  if (ctx.from && !ctx.user) {
    ctx.user = await userService.upsertByTelegramId({
      telegramId: BigInt(ctx.from.id),
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
    });
  }

  // ── Refresh main menu (rolling-refresh deep link) ──────────────────────────
  // Webapp ловит TOKEN_EXPIRED/TOKEN_INVALID → редиректит юзера сюда. Мы
  // переотправляем персистентную reply-kb со свежим wtoken и выходим — никакого
  // welcome'а, никаких сайд-эффектов (язык, FSM-state, Metabox-sync). Юзер
  // тапнет «Профиль» в обновлённой клавиатуре и попадёт в webapp с рабочим
  // токеном.
  //
  // `!ctx.user.isNew` — гард на случай, когда кто-то расшарил deeplink и юзер
  // открыл его ДО регистрации: upsertByTelegramId выше создал свежую запись,
  // и без этого условия мы бы short-circuit'нули welcome-flow (бонусные токены,
  // Metabox-register, FSM=IDLE) и оставили бы юзера в полуоформленном состоянии.
  if (param === "refresh_menu" && ctx.user && !ctx.user.isNew) {
    const t = getT(ctx.user.language as Language);
    await ctx.reply(t.start.mainMenuTitle, {
      reply_markup: buildMainMenuKeyboard(t, ctx.user.telegramId),
    });
    return;
  }

  // ── Metabox→Bot account linking ────────────────────────────────────────────
  if (param?.startsWith("link_") && ctx.user) {
    const token = param.slice("link_".length);
    try {
      const botPurchase = await db.tokenTransaction.findFirst({
        where: { userId: ctx.user.id, type: "credit", reason: "purchase" },
        select: { id: true },
      });
      // referredById — внутренний `User.id`; Metabox ожидает tgid реферрера.
      let referrerTelegramId: bigint | null = null;
      if (ctx.user.referredById) {
        const referrer = await db.user.findUnique({
          where: { id: ctx.user.referredById },
          select: { telegramId: true },
        });
        referrerTelegramId = referrer?.telegramId ?? null;
      }
      const { metaboxUserId, referralCode, mergedFrom } = await verifyLinkToken(
        token,
        ctx.user.telegramId!,
        {
          telegramUsername: ctx.from?.username,
          firstName: ctx.from?.first_name,
          lastName: ctx.from?.last_name,
          referrerTelegramId,
          botHasPurchase: !!botPurchase,
          botCreatedAt: ctx.user.createdAt,
        },
      );
      await db.user.update({
        where: { id: ctx.user.id },
        data: { metaboxUserId, metaboxReferralCode: referralCode },
      });
      await ctx.reply(ctx.t.start.metaboxLinked ?? "✅ Аккаунт Metabox успешно привязан!");
      if (mergedFrom) {
        const siteUrl = config.metabox.apiUrl
          ? new URL(config.metabox.apiUrl).hostname
          : "meta-box.ru";
        await ctx.reply(ctx.t.start.accountsMerged.replace("{siteUrl}", siteUrl));
      }

      // Sync subscription and pending token grants from Metabox after linking
      void syncMetaboxGrants(ctx.user.id, ctx.user.telegramId!).catch((err) => {
        logger.error({ err }, "[start link] grant sync failed");
      });
    } catch (err) {
      const apiErr = err as { code?: string; data?: Record<string, unknown> };

      // ── Mentor conflict — ask user to choose ──
      if (apiErr.code === "MENTOR_CONFLICT" && apiErr.data) {
        const d = apiErr.data as {
          token: string;
          siteMentor: { name: string; contact: string };
          botMentor: { name: string; contact: string };
        };
        const siteName = d.siteMentor?.contact
          ? `${d.siteMentor.name} (${d.siteMentor.contact})`
          : d.siteMentor?.name || "Неизвестен";
        const botName = d.botMentor?.contact
          ? `${d.botMentor.name} (${d.botMentor.contact})`
          : d.botMentor?.name || "Неизвестен";

        await ctx.reply(
          `⚠️ *Обнаружен конфликт наставников*\n\n` +
            `На вашем аккаунте Metabox наставник:\n*${siteName}*\n\n` +
            `В AI Box боте ваш наставник:\n*${botName}*\n\n` +
            `При объединении аккаунтов необходимо выбрать одного наставника.`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: `Оставить ${d.siteMentor?.name || "Наставника с сайта"}`,
                    callback_data: `merge:site:${d.token}`,
                  },
                ],
                [
                  {
                    text: `Оставить ${d.botMentor?.name || "Наставника из бота"}`,
                    callback_data: `merge:bot:${d.token}`,
                  },
                ],
                [{ text: "❌ Отмена", callback_data: "merge:cancel" }],
              ],
            },
          },
        );
        return;
      }

      // ── MERGE_BLOCKED (row 13): both mentors + both have purchases ──
      if (apiErr.code === "MERGE_BLOCKED" && apiErr.data) {
        const d = apiErr.data as {
          siteMentor: { name: string; contact: string };
          botMentor: { name: string; contact: string };
        };
        const siteName = d.siteMentor?.contact
          ? `${d.siteMentor.name} (${d.siteMentor.contact})`
          : d.siteMentor?.name || "Неизвестен";
        const botName = d.botMentor?.contact
          ? `${d.botMentor.name} (${d.botMentor.contact})`
          : d.botMentor?.name || "Неизвестен";

        await ctx.reply(
          `⛔ *Невозможно объединить аккаунты*\n\n` +
            `У вас разные наставники и на обоих аккаунтах есть покупки.\n\n` +
            `Наставник на сайте: *${siteName}*\n` +
            `Наставник в боте: *${botName}*\n\n` +
            `Если у вас есть вопросы — обратитесь в поддержку: @${config.supportTg}`,
          { parse_mode: "Markdown" },
        );
        return;
      }

      let msg = "❌ Не удалось привязать аккаунт. Попробуйте ещё раз.";
      if (apiErr.code === "TELEGRAM_MISMATCH") {
        const linkedTg = apiErr.data?.linkedUsername ? ` (@${apiErr.data.linkedUsername})` : "";
        msg = `⚠️ Невозможно привязать AI Box.\n\nВаш аккаунт на сайте уже привязан к другому Telegram${linkedTg}.\n\nИспользуйте тот же Telegram-аккаунт для привязки.\n\nЕсли это ошибка — напишите в поддержку: @${config.supportTg}`;
      } else if (apiErr.code === "TELEGRAM_ALREADY_LINKED") {
        const email = apiErr.data?.linkedEmail ? String(apiErr.data.linkedEmail) : "";
        msg = `⚠️ Этот Telegram уже привязан к другому аккаунту на Metabox${email ? ` (${email})` : ""}.\n\nЕсли это ошибка — напишите в поддержку: @${config.supportTg}`;
      }
      await ctx.reply(msg);
      // Линковка не состоялась — НЕ продолжаем общий welcome-flow, иначе
      // пакет приветственных сообщений перекроет сверху это уведомление,
      // и юзер не заметит причину отказа. Юзер увидит ошибку в чате и
      // сможет сделать /start снова (без link-параметра) — на следующий
      // вызов получит обычный welcome.
      return;
    }
  } else if (param?.startsWith("linkweb_") && ctx.user) {
    // ── ai.metabox.global → Bot: привязка web-аккаунта ───────────────────────
    // Юзер залогинен на ai.metabox.global, нажал «Привязать Telegram»,
    // фронт получил state, сгенерил deep-link вида /start linkweb_<state>.
    // Здесь мы: (1) читаем state из Redis → metaboxUserId, (2) проставляем
    // его на AI Box юзера (по telegramId), (3) помечаем linkState как «linked»,
    // чтобы фронт увидел успех при очередном poll.
    const state = param.slice("linkweb_".length);
    try {
      const metaboxUserId = await consumeLinkTelegramState(state);
      if (!metaboxUserId) {
        await ctx.reply(
          "⚠️ Ссылка недействительна или истекла. Вернитесь на сайт и нажмите «Привязать Telegram» ещё раз.",
        );
        // Линковка не удалась — не показываем welcome-пакет поверх ошибки.
        return;
      } else {
        // Проверяем конфликт: если на AI Box юзере уже прописан ДРУГОЙ metaboxUserId
        if (ctx.user.metaboxUserId && ctx.user.metaboxUserId !== metaboxUserId) {
          await ctx.reply(
            `⚠️ Этот Telegram уже привязан к другому аккаунту на Metabox.\n\nЕсли это ошибка — напишите в поддержку: @${config.supportTg}`,
          );
          // Линковка не состоялась — не перекрываем уведомление welcome'ом.
          return;
        } else {
          await db.user.update({
            where: { id: ctx.user.id },
            data: { metaboxUserId },
          });
          await markLinkTelegramLinked(
            state,
            ctx.user.telegramId!.toString(),
            ctx.from?.username ?? null,
          );
          await ctx.reply(
            "✅ Аккаунт привязан. Возвращайтесь на ai.metabox.global — нейросети уже доступны.",
          );
          // Синхронизируем токены/подписки из metabox
          void syncMetaboxGrants(ctx.user.id, ctx.user.telegramId!).catch((err) => {
            logger.error({ err }, "[start linkweb] grant sync failed");
          });
        }
      }
    } catch (err) {
      logger.error({ err, state }, "[start linkweb] failed");
      await ctx.reply("❌ Не удалось привязать аккаунт. Попробуйте ещё раз.");
      // Линковка не удалась — не активируем бота, чтобы юзер увидел ошибку.
      return;
    }
  } else if (param?.startsWith("ref_") && ctx.user && ctx.user.referredById) {
    // ── Referral deep link ─────────────────────────────────────────────────────
    // User already has a referrer — notify with mentor name
    let mentorName = "";
    try {
      const mentor = await db.user.findUnique({
        where: { id: ctx.user.referredById },
        select: { firstName: true, lastName: true, username: true },
      });
      if (mentor) {
        const name = mentor.firstName
          ? `${mentor.firstName}${mentor.lastName ? ` ${mentor.lastName}` : ""}`
          : mentor.username || "";
        const contact = mentor.username ? ` (@${mentor.username})` : "";
        mentorName = name ? `: ${name}${contact}` : "";
      }
    } catch {
      /* ignore */
    }
    await ctx
      .reply(`ℹ️ У вас уже есть наставник${mentorName}. Реферальная ссылка не была применена.`)
      .catch(() => {});
  }
  // Store resolved referrer info for registerBotUser
  let resolvedReferrerUserId: string | null = null;

  if (param?.startsWith("ref_") && ctx.user && !ctx.user.referredById) {
    const refParam = param.slice("ref_".length);

    // Try as referralCode first (new format: ref_HU6PQYST)
    // Then fall back to telegramId (legacy format: ref_6186315229).
    // `referrerId` — внутренний `User.id` найденного реферрера (FK для
    // `referredById`); резолвится через lookup по `telegramId`, потому что
    // в URL приходит именно tgid (а в новой схеме User.id ≠ telegramId).
    let referrerId: bigint | null = null;

    if (/^\d+$/.test(refParam)) {
      // Legacy: numeric telegramId
      const legacyTgid = BigInt(refParam);
      if (legacyTgid !== ctx.user.telegramId) {
        const referrer = await db.user.findUnique({
          where: { telegramId: legacyTgid },
          select: { id: true },
        });
        if (referrer) referrerId = referrer.id;
      }
    }

    if (!referrerId) {
      // New: referralCode → resolve via Metabox API
      try {
        const { resolveReferralCode } = await import("@metabox/api/services");
        const resolved = await resolveReferralCode(refParam);
        if (resolved?.telegramId) {
          const resolvedTgid = BigInt(resolved.telegramId);
          if (resolvedTgid !== ctx.user.telegramId) {
            const referrer = await db.user.findUnique({
              where: { telegramId: resolvedTgid },
              select: { id: true },
            });
            if (referrer) {
              referrerId = referrer.id;
            }
          }
        }
        // Save userId even if telegramId is null (referrer has no bot)
        if (!referrerId && resolved?.userId) {
          resolvedReferrerUserId = resolved.userId;
        }
      } catch {
        // Metabox API unavailable — skip referral
      }
    }

    if (referrerId) {
      await db.user.update({
        where: { id: ctx.user.id },
        data: { referredById: referrerId },
      });
    }
  }

  if (!ctx.user) return;

  // Авто-определяем язык из Telegram-клиента (`from.language_code`) и сразу
  // сохраняем его в БД. Никакого AWAITING_LANGUAGE — пользователь должен
  // мочь работать с ботом сразу после /start. Сменить язык можно через
  // кнопку «Язык» в главном меню.
  const inferredLang = inferTelegramLanguage(ctx);
  const isNew = ctx.user.isNew;
  const updatedUser = await userService.setLanguage(ctx.user.id, inferredLang);
  await userStateService.setState(ctx.user.id, "IDLE");
  const t = getT(inferredLang);

  // Register stub account on Metabox (or link existing) — fire-and-forget
  if (config.metabox?.apiUrl) {
    (async () => {
      try {
        // Re-read user from DB to get updated referredById (set in ref_ handler above).
        // referredById — внутренний User.id ментора; Metabox ожидает tgid, поэтому
        // подтягиваем `referrer.telegramId` отдельным lookup'ом.
        const freshUser = await db.user.findUnique({
          where: { id: ctx.user!.id },
          select: {
            referredById: true,
            firstName: true,
            lastName: true,
            username: true,
            telegramId: true,
            referredBy: { select: { telegramId: true } },
          },
        });
        const referrerTelegramId = freshUser?.referredBy?.telegramId ?? null;
        const telegramId = ctx.user!.telegramId ?? freshUser?.telegramId;
        if (!telegramId) {
          logger.warn(
            { userId: ctx.user!.id.toString() },
            "[start registerBotUser] no telegramId on user — skip Metabox register",
          );
          return;
        }
        const { registerBotUser } = await import("@metabox/api/services");
        const result = await registerBotUser({
          telegramId,
          firstName: freshUser?.firstName ?? ctx.user!.firstName,
          lastName: freshUser?.lastName ?? ctx.user!.lastName,
          username: freshUser?.username ?? ctx.user!.username,
          referrerTelegramId,
          referrerUserId: resolvedReferrerUserId ?? undefined,
        });
        if (result?.ok) {
          // Drift detection: если на metabox-стороне произошёл merge, наш
          // закешированный `metaboxUserId` мог стать secondary'ем. registerBotUser
          // ищет по telegramId, который после merge сидит на primary, поэтому
          // `result.userId` = живой primary. Если он отличается от нашего
          // кеша — обновляем + логируем для аудита.
          const previousMetaboxUserId = ctx.user!.metaboxUserId;
          const driftDetected = !!previousMetaboxUserId && previousMetaboxUserId !== result.userId;

          await db.user.update({
            where: { id: ctx.user!.id },
            data: {
              metaboxReferralCode: result.referralCode,
              // metaboxUserId пишем только для real-аккаунта (isStub=false),
              // чтобы поле семантически означало «реально привязан к Metabox»,
              // а не «есть stub». Если в кеше уже был userId, а сейчас вернулся
              // stub — это inconsistency (frozen?), не перезаписываем, только лог.
              ...(!result.isStub ? { metaboxUserId: result.userId } : {}),
            },
          });

          if (driftDetected) {
            logger.warn(
              {
                telegramId: telegramId.toString(),
                userId: ctx.user!.id.toString(),
                from: previousMetaboxUserId,
                to: result.userId,
                isStub: result.isStub,
              },
              "[start registerBotUser] metaboxUserId drift — local cache pointed to a different user",
            );
          }

          if (!result.isStub) {
            // Notify user about auto-linking
            const mentorInfo = result.mentor
              ? `\nВаш наставник: ${result.mentor.name}${result.mentor.telegramUsername ? ` (@${result.mentor.telegramUsername})` : ""}`
              : "";
            await ctx
              .reply(`✅ Мы нашли ваш аккаунт на Metabox и привязали его к боту.${mentorInfo}`)
              .catch(() => {});

            // Sync subscription + pending token grants from Metabox
            void syncMetaboxGrants(ctx.user!.id, telegramId).catch((err) => {
              logger.error({ err }, "[start registerBotUser] grant sync failed");
            });

            // Backfill referredById для прямых рефералов этого юзера в боте.
            // Закрывает дыру: реферал мог зарегистрироваться в боте раньше
            // наставника — тогда его referredById остался null, потому что
            // строки наставника в db.user ещё не было. Идемпотентно.
            //
            // Первый параметр — внутренний `User.id` ментора (FK для referredById).
            void backfillBotReferrals(ctx.user!.id, result.userId).catch((err) => {
              logger.error({ err }, "[start registerBotUser] referral backfill failed");
            });
          }
        }
      } catch (registerErr) {
        logger.error({ err: registerErr }, "[start] registerBotUser failed");
      }
    })();
  }

  // creditedNow=true только если бонус реально начислен в этом вызове.
  // Когда `welcome_bonus_receipts` уже содержит запись (повторный /start
  // после удаления аккаунта) — фактического начисления не было, поэтому
  // сообщение «вот ваши N приветственных токенов» показывать нельзя;
  // воспринимаем юзера как возвращающегося (balance + main menu).
  const creditedNow =
    isNew && ctx.user.telegramId
      ? await userService.creditWelcomeBonus(ctx.user.id, ctx.user.telegramId)
      : false;

  await sendStartMessages(ctx, inferredLang, {
    isNew: creditedNow,
    tokenBalance: updatedUser.tokenBalance as number,
  });

  // Set per-chat bot commands in user's language
  if (ctx.chat?.id) {
    await ctx.api
      .setMyCommands(buildCommands(t), { scope: { type: "chat", chat_id: ctx.chat.id } })
      .catch(() => void 0);
  }

  ctx.user = { ...updatedUser, isNew: false };
}

/**
 * Достаём язык из Telegram-клиента (`from.language_code`, IETF tag).
 * Нормализуем по первой части до дефиса (`pt-br` → `pt`) и матчим
 * на `SUPPORTED_LANGUAGES`. Если язык не поддерживается или поле пустое —
 * fallback `"en"`.
 */
function inferTelegramLanguage(ctx: BotContext): Language {
  const raw = ctx.from?.language_code?.toLowerCase().split("-")[0] ?? "";
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(raw) ? (raw as Language) : "en";
}

/**
 * Callback handler for the onboarding "Got it" button (data: onboarding_ok).
 * Removes the onboarding message and shows the main menu with reply keyboard.
 */
export async function handleOnboardingOk(ctx: BotContext): Promise<void> {
  // answerCallbackQuery может бросить 400 "query is too old", если юзер тапнул
  // кнопку через >15 минут после получения onboarding-сообщения — Telegram уже
  // выкинул callback-query из своего state'а. Безвредно, swallow'им.
  await ctx.answerCallbackQuery().catch(() => void 0);
  await ctx.deleteMessage().catch(() => void 0);

  const t = ctx.t;
  await ctx.reply(t.start.mainMenuTitle, {
    reply_markup: buildMainMenuKeyboard(t, ctx.user?.telegramId),
  });
}

/**
 * Shows the inline language picker from the main menu.
 * Does NOT change user state — user remains in whatever state they were in.
 */
export async function handleLanguageMenu(ctx: BotContext): Promise<void> {
  await ctx.reply(ctx.t.menu.chooseLanguage, {
    reply_markup: buildLanguageKeyboard("langset_"),
  });
}

/**
 * Callback for in-menu language change (data: langset_<code>).
 * Updates the user's language and refreshes bot commands, but does NOT
 * touch user state, does NOT send welcome/balance, does NOT re-send main menu.
 */
export async function handleLanguageChangeSelect(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const lang = data.replace("langset_", "") as Language;

  if (!SUPPORTED_LANGUAGES.includes(lang) || !ctx.user) {
    await ctx.answerCallbackQuery();
    return;
  }

  // Short-circuit на повторный клик по той же кнопке: язык фактически не
  // изменился — переотправлять welcome/balance/menu не нужно, иначе будем
  // спамить пакетом /start-сообщений на каждый идентичный клик в picker'е.
  if (ctx.user.language === lang) {
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery();

  const updatedUser = await userService.setLanguage(ctx.user.id, lang);
  const t = getT(lang);

  // Перевыкатываем тот же набор сообщений, что и /start, в новом языке —
  // старые сообщения остаются в чате нетронутыми (вариант 3 из обсуждения:
  // не пытаемся редактировать/удалять, чтобы не зависеть от 48ч-окна и
  // edge-cases с уже нажатыми inline-кнопками). Welcome здесь служит
  // имплицитным подтверждением «язык переключился».
  await sendStartMessages(ctx, lang, {
    isNew: updatedUser.isNew,
    tokenBalance: updatedUser.tokenBalance as number,
  });

  if (ctx.chat?.id) {
    await ctx.api
      .setMyCommands(buildCommands(t), { scope: { type: "chat", chat_id: ctx.chat.id } })
      .catch(() => void 0);
  }

  ctx.user = { ...updatedUser, isNew: ctx.user.isNew };
}

function buildCommands(t: Translations) {
  return [
    { command: "start", description: t.start.restart },
    { command: "menu", description: t.start.mainMenuTitle.split("\n")[0] },
    // { command: "profile", description: t.menu.profile },
    { command: "gpt", description: t.menu.gpt },
    { command: "design", description: t.menu.design },
    { command: "audio", description: t.menu.audio },
    { command: "video", description: t.menu.video },
  ];
}
