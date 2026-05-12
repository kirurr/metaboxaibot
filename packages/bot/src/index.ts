import "dotenv/config";
import { initSentry } from "./sentry.js";
initSentry(); // must be before any other imports that could throw
import { createBot } from "./bot.js";
import { preloadLocales, SUPPORTED_LANGUAGES, config } from "@metabox/shared";
import { logger } from "./logger.js";
import { run } from "@grammyjs/runner";
import { closeRedis } from "@metabox/api/redis";
import { initPricingConfig } from "@metabox/api/services/pricing-config";
import { closeDb } from "./db.js";

/**
 * Максимум времени, который мы ждём завершения in-flight handler'ов после
 * SIGTERM. Должен быть < `stop_grace_period` в docker-compose, чтобы мы
 * успели exit чисто до того как Docker пришлёт SIGKILL. LLM streaming на
 * thinking-моделях может тянуться до ~3 минут — берём 4 минуты с запасом.
 */
const SHUTDOWN_TIMEOUT_MS = 4 * 60 * 1000;

async function main() {
  logger.info("Loading i18n locales...");
  await preloadLocales(SUPPORTED_LANGUAGES);

  // Загружаем per-model price multipliers + подписываемся на pubsub
  // инвалидацию. Без этого `costPreviewService` в bot-процессе считает
  // `getModelMultiplier === 1.0` и показывает юзеру предварительную цену
  // без коэффициента — расходится с фактическим списанием (worker/API
  // инициализируют этот кеш у себя). См. pricing-config.service.ts.
  logger.info("Initializing pricing config cache...");
  await initPricingConfig();

  const bot = createBot(config.bot.token);

  // ── In-flight handler counter (graceful-shutdown insurance) ─────────────
  // grammy-runner сам ждёт завершения handler'ов в `runner.task()`, но для
  // прозрачности (логи + таймаут) считаем их явно через middleware.
  let inFlight = 0;
  bot.use(async (_ctx, next) => {
    inFlight++;
    try {
      await next();
    } finally {
      inFlight--;
    }
  });

  // Reset webhook (we use long polling) but KEEP pending updates so сообщения,
  // отправленные пока бот был оффлайн (рестарт/деплой), обработаются после старта.
  // Защита от re-delivery — Redis-дедуп по update_id в bot.ts.
  logger.info("Resetting webhook (keeping pending updates)...");
  await bot.api.deleteWebhook({ drop_pending_updates: false });

  // Set allowed_updates via a dummy getUpdates call before runner starts
  await bot.api.getUpdates({
    limit: 0,
    allowed_updates: [
      "message",
      "edited_message",
      "callback_query",
      "inline_query",
      "chosen_inline_result",
      "pre_checkout_query",
      "my_chat_member",
      "chat_member",
    ],
  });

  logger.info("Starting bot (long polling with runner)...");
  const runner = run(bot);

  let shuttingDown = false;
  const stopSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of stopSignals) {
    process.once(signal, () => {
      if (shuttingDown) {
        logger.warn({ signal }, "Second signal received, forcing exit");
        process.exit(1);
      }
      shuttingDown = true;
      logger.info({ signal, inFlight }, "Stopping bot runner — waiting for in-flight handlers...");
      runner.stop();

      // Hard-timeout: если handler'ы зависли (внешний API не отвечает),
      // exit'имся форс'ом до того как Docker пришлёт SIGKILL по grace period'у.
      const deadline = setTimeout(() => {
        logger.error({ inFlight }, "Shutdown timeout exceeded, forcing exit");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      // unref — таймер не должен мешать естественному exit'у когда handler'ы
      // успели завершиться раньше deadline.
      deadline.unref();

      // Прогресс-лог раз в 5 секунд пока есть in-flight.
      const progress = setInterval(() => {
        if (inFlight > 0) {
          logger.info({ inFlight }, "Still waiting for handlers to finish...");
        } else {
          clearInterval(progress);
        }
      }, 5000);
      progress.unref();
    });
  }

  await runner.task();
  logger.info({ inFlight }, "Bot runner stopped, closing resources...");

  // Явно закрываем долгоживущие соединения, иначе Node не может выйти и виснет
  // ~минуту до TCP keepalive timeout. Postgres pool, ioredis singleton —
  // оба держат event loop открытым.
  await Promise.race([
    Promise.allSettled([closeRedis(), closeDb()]),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);

  logger.info("Resources closed, exiting");
  process.exit(0);
}

main().catch((err) => {
  logger.error(err, "Fatal error");
  process.exit(1);
});
