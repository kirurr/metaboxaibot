import { InlineKeyboard } from "grammy";
import type { BotContext } from "../types/context.js";
import { userService } from "../services/user.service.js";
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
 */
async function syncMetaboxGrants(userId: bigint): Promise<void> {
  // Token-pack orders sync
  const pendingOrders = await getPendingTokenGrants(userId);
  for (const order of pendingOrders) {
    try {
      await db.user.update({
        where: { id: userId },
        data: { tokenBalance: { increment: order.tokens } },
      });
      await db.tokenTransaction.create({
        data: {
          userId,
          amount: order.tokens,
          type: "credit",
          reason: "metabox_purchase",
          description: order.description,
        },
      });
      await markOrderGrantedOnMetabox(order.orderId);
    } catch (err) {
      logger.error({ err, orderId: order.orderId }, "[syncMetaboxGrants] token order grant failed");
    }
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

  // ── Metabox→Bot account linking ────────────────────────────────────────────
  if (param?.startsWith("link_") && ctx.user) {
    const token = param.slice("link_".length);
    try {
      const botPurchase = await db.tokenTransaction.findFirst({
        where: { userId: ctx.user.id, type: "credit", reason: "purchase" },
        select: { id: true },
      });
      const { metaboxUserId, referralCode, mergedFrom } = await verifyLinkToken(
        token,
        ctx.user.id,
        {
          telegramUsername: ctx.from?.username,
          firstName: ctx.from?.first_name,
          lastName: ctx.from?.last_name,
          referrerTelegramId: ctx.user.referredById,
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
      void syncMetaboxGrants(ctx.user.id).catch((err) => {
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
      } else {
        // Проверяем конфликт: если на AI Box юзере уже прописан ДРУГОЙ metaboxUserId
        if (ctx.user.metaboxUserId && ctx.user.metaboxUserId !== metaboxUserId) {
          await ctx.reply(
            `⚠️ Этот Telegram уже привязан к другому аккаунту на Metabox.\n\nЕсли это ошибка — напишите в поддержку: @${config.supportTg}`,
          );
        } else {
          await db.user.update({
            where: { id: ctx.user.id },
            data: { metaboxUserId },
          });
          await markLinkTelegramLinked(state, ctx.user.id.toString(), ctx.from?.username ?? null);
          await ctx.reply(
            "✅ Аккаунт привязан. Возвращайтесь на ai.metabox.global — нейросети уже доступны.",
          );
          // Синхронизируем токены/подписки из metabox
          void syncMetaboxGrants(ctx.user.id).catch((err) => {
            logger.error({ err }, "[start linkweb] grant sync failed");
          });
        }
      }
    } catch (err) {
      logger.error({ err, state }, "[start linkweb] failed");
      await ctx.reply("❌ Не удалось привязать аккаунт. Попробуйте ещё раз.");
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
    // Then fall back to telegramId (legacy format: ref_6186315229)
    let referrerId: bigint | null = null;

    if (/^\d+$/.test(refParam)) {
      // Legacy: numeric telegramId
      const legacyId = BigInt(refParam);
      if (legacyId !== ctx.user.id) {
        const exists = await db.user.findUnique({
          where: { id: legacyId },
          select: { id: true },
        });
        if (exists) referrerId = legacyId;
      }
    }

    if (!referrerId) {
      // New: referralCode → resolve via Metabox API
      try {
        const { resolveReferralCode } = await import("@metabox/api/services");
        const resolved = await resolveReferralCode(refParam);
        if (resolved?.telegramId) {
          const resolvedId = BigInt(resolved.telegramId);
          if (resolvedId !== ctx.user.id) {
            const exists = await db.user.findUnique({
              where: { id: resolvedId },
              select: { id: true },
            });
            if (exists) {
              referrerId = resolvedId;
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
        // Re-read user from DB to get updated referredById (set in ref_ handler above)
        const freshUser = await db.user.findUnique({
          where: { id: ctx.user!.id },
          select: { referredById: true, firstName: true, lastName: true, username: true },
        });
        const { registerBotUser } = await import("@metabox/api/services");
        const result = await registerBotUser({
          telegramId: ctx.user!.id,
          firstName: freshUser?.firstName ?? ctx.user!.firstName,
          lastName: freshUser?.lastName ?? ctx.user!.lastName,
          username: freshUser?.username ?? ctx.user!.username,
          referrerTelegramId: freshUser?.referredById ?? ctx.user!.referredById,
          referrerUserId: resolvedReferrerUserId ?? undefined,
        });
        if (result?.ok) {
          if (!result.isStub) {
            // Real account found — auto-link
            await db.user.update({
              where: { id: ctx.user!.id },
              data: {
                metaboxUserId: result.userId,
                metaboxReferralCode: result.referralCode,
              },
            });
            // Notify user about auto-linking
            const mentorInfo = result.mentor
              ? `\nВаш наставник: ${result.mentor.name}${result.mentor.telegramUsername ? ` (@${result.mentor.telegramUsername})` : ""}`
              : "";
            await ctx
              .reply(`✅ Мы нашли ваш аккаунт на Metabox и привязали его к боту.${mentorInfo}`)
              .catch(() => {});

            // Sync subscription + pending token grants from Metabox
            void syncMetaboxGrants(ctx.user!.id).catch((err) => {
              logger.error({ err }, "[start registerBotUser] grant sync failed");
            });
          } else {
            // Stub account — store referralCode but NOT metaboxUserId
            await db.user.update({
              where: { id: ctx.user!.id },
              data: { metaboxReferralCode: result.referralCode },
            });
          }
        }
      } catch (registerErr) {
        logger.error({ err: registerErr }, "[start] registerBotUser failed");
      }
    })();
  }

  if (isNew) {
    await userService.creditWelcomeBonus(ctx.user.id);
  }

  // Welcome-сообщение (с дисклеймером и ссылками на документы) идёт отдельным
  // сообщением, без кнопок — чтобы при смене языка не удалялся весь текст с
  // юр. ссылками (handleLanguageChangeSelect делает deleteMessage на сообщении
  // с picker'ом). Для RU-пользователей шлём bilingual (RU + EN) — аудитория
  // двуязычная, приветствие показываем на двух языках. Для всех остальных
  // (включая en и неподдерживаемые → fallback "en") — только в целевом языке.
  // Шаблон welcome содержит {landingUrl} многократно (по ссылке на каждый
  // документ) — нужен replaceAll, иначе остаются битые href.
  const landingUrl = config.metabox.landingUrl;
  let welcome: string;
  if (inferredLang === "ru") {
    // Разделитель из подчёркиваний — Telegram не поддерживает <hr>/markdown HR,
    // визуальная черта только символами.
    const divider = "________________________";
    const ruWelcome = getT("ru").start.welcome.replaceAll("{landingUrl}", landingUrl);
    const enWelcome = getT("en").start.welcome.replaceAll("{landingUrl}", landingUrl);
    welcome = `${ruWelcome}\n\n${divider}\n\n${enWelcome}`;
  } else {
    welcome = t.start.welcome.replaceAll("{landingUrl}", landingUrl);
  }
  await ctx.reply(welcome, { reply_markup: buildLanguageKeyboard("langset_"), parse_mode: "HTML" });

  // Inline button to open Profile in mini app
  const webappUrl = config.bot.webappUrl;
  const profileKb = webappUrl
    ? new InlineKeyboard().webApp(t.menu.profile, `${webappUrl}?page=profile`)
    : undefined;

  // New users: show tokens credited; returning users: show current balance
  if (isNew) {
    await ctx.reply(t.start.tokensGranted, profileKb ? { reply_markup: profileKb } : undefined);
  } else {
    const balance = (updatedUser.tokenBalance as number).toFixed(2);
    const balanceText = t.start.yourBalance.replace("{balance}", balance);
    await ctx.reply(balanceText, profileKb ? { reply_markup: profileKb } : undefined);
  }

  if (isNew) {
    // Onboarding message with "Got it" button — main menu opens after
    const onboardingKb = new InlineKeyboard().text(t.start.onboardingGotIt, "onboarding_ok");
    await ctx.reply(t.start.onboarding, {
      parse_mode: "HTML",
      reply_markup: onboardingKb,
    });
  } else {
    // Returning users get the main menu immediately. buildMainMenuKeyboard
    // ставит persistent reply-keyboard со свежими wtoken'ами — старые
    // протухшие webApp-URL'ы заменяются.
    await ctx.reply(t.start.mainMenuTitle, {
      reply_markup: buildMainMenuKeyboard(t, ctx.user.id),
    });
  }

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
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => void 0);

  const t = ctx.t;
  await ctx.reply(t.start.mainMenuTitle, {
    reply_markup: buildMainMenuKeyboard(t, ctx.user?.id),
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

  await ctx.answerCallbackQuery();

  const updatedUser = await userService.setLanguage(ctx.user.id, lang);
  const t = getT(lang);

  // Remove the inline picker message to keep chat clean.
  await ctx.deleteMessage().catch(() => void 0);

  await ctx.reply(t.menu.languageChanged, {
    reply_markup: buildMainMenuKeyboard(t, ctx.user.id),
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
