import type { BotContext } from "../types/context.js";
import { paymentService, checkPaidSubscription } from "@metabox/api/services";
import type { SaleUserInfo } from "@metabox/api/services";
import { logger } from "../logger.js";
import { config, getT } from "@metabox/shared";

/** Answer Telegram's pre-checkout query — must respond within 10 seconds. */
export async function handlePreCheckoutQuery(ctx: BotContext): Promise<void> {
  const payload = ctx.preCheckoutQuery?.invoice_payload ?? "";
  logger.info({ userId: ctx.from?.id, payload }, "pre_checkout_query received");

  try {
    // Token packages require an active PAID subscription (trial не проходит).
    if (payload.startsWith("product:") && ctx.from?.id) {
      try {
        await checkPaidSubscription(BigInt(ctx.from.id));
      } catch {
        const t = ctx.t ?? getT("en");
        await ctx.answerPreCheckoutQuery(false, t.errors.noSubscriptionForPurchase);
        logger.info({ userId: ctx.from.id, payload }, "pre_checkout_query denied: no subscription");
        return;
      }
    }

    await ctx.answerPreCheckoutQuery(true);
    logger.info("pre_checkout_query answered OK");
  } catch (err) {
    logger.error({ err }, "pre_checkout_query answer FAILED");
  }
}

/** Credit tokens after Stars payment is confirmed. */
export async function handleSuccessfulPayment(ctx: BotContext): Promise<void> {
  if (!ctx.user) return;
  const payment = ctx.message?.successful_payment;
  if (!payment) return;

  const payload = payment.invoice_payload;

  try {
    // RUB-эквивалент одной звезды берётся напрямую из конфига
    // (STAR_PRICE_RUB env), без промежуточного USD-курса.
    const stars = payment.total_amount; // actual Stars charged by Telegram
    const starRate = config.payments.starPriceRub;

    // Build user info from Telegram context
    const userInfo: SaleUserInfo = {
      firstName: ctx.from?.first_name ?? "Unknown",
      lastName: ctx.from?.last_name,
      username: ctx.from?.username,
      referrerTelegramId: ctx.user.referredById ?? undefined,
      stars,
      starRate,
    };

    // New format: "product:{id}:{tokens}:{priceRub}:{name}" or "subscription:{planId}:{period}:{tokens}:{priceRub}"
    if (payload.startsWith("product:") || payload.startsWith("subscription:")) {
      const parts = payload.split(":");
      const isSubscription = payload.startsWith("subscription:");
      const productId = parts[1];
      const tokens = Number(parts[isSubscription ? 3 : 2]);
      const priceRub = Number(parts[isSubscription ? 4 : 3]);
      const productName = parts[isSubscription ? 5 : 4] || undefined;
      const productType = isSubscription ? "subscription" : "product";
      const period = isSubscription ? parts[2] : undefined;

      await paymentService.creditDynamicPurchase(
        ctx.user.id,
        tokens,
        productId,
        priceRub,
        productType,
        period,
        userInfo,
        productName,
      );
    } else {
      // Legacy format: planId directly
      await paymentService.creditPurchase(ctx.user.id, payload, userInfo);
    }

    await ctx.reply(ctx.t.payments.success);
  } catch (err) {
    logger.error({ err, userId: ctx.user.id.toString(), payload }, "Failed to credit purchase");
    await ctx.reply(ctx.t.payments.error);
  }
}
