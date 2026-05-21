/**
 * Builds a Fastify instance with all plugins, hooks and routes registered.
 *
 * Production entry (`index.ts`) calls this with `startBackgroundJobs: true`
 * and then `server.listen()`. Tests call it with `startBackgroundJobs: false`
 * and use `server.inject(...)` directly — no port binding, no schedulers,
 * no pubsub subscribers.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { registry } from "./metrics.js";
import { authRoutes } from "./routes/auth.js";
import { webAuthRoutes } from "./routes/web-auth.js";
import { webChatRoutes } from "./routes/web-chat.js";
import { webModelsRoutes } from "./routes/web-models.js";
import { webGalleryRoutes } from "./routes/web-gallery.js";
import { webVoicesRoutes } from "./routes/web-voices.js";
import { webPickersRoutes } from "./routes/web-pickers.js";
import { webBillingRoutes } from "./routes/web-billing.js";
import { profileRoutes } from "./routes/profile.js";
import { dialogsRoutes } from "./routes/dialogs.js";
import { stateRoutes } from "./routes/state.js";
import { modelsRoutes } from "./routes/models.js";
import { adminRoutes } from "./routes/admin.js";
import { adminKeysRoutes } from "./routes/admin-keys.js";
import { adminPricingRoutes } from "./routes/admin-pricing.js";
import { initPricingConfig } from "./services/pricing-config.service.js";
import { startJobNotificationsSubscriber } from "./services/job-notifications.subscriber.js";
import { dispatchJobNotification } from "./services/web-notification.service.js";
import { paymentsRoutes } from "./routes/payments.js";
import { galleryRoutes } from "./routes/gallery.js";
import { slidesRoutes } from "./routes/slides.js";
import { imageSettingsRoutes } from "./routes/image-settings.js";
import { videoSettingsRoutes } from "./routes/video-settings.js";
import { modelSettingsRoutes } from "./routes/model-settings.js";
import { internalRoutes } from "./routes/internal.js";
import { metaboxAibotRoutes } from "./routes/metabox-aibot.js";
import { tariffsRoutes } from "./routes/tariffs.js";
import { heygenVoicesRoutes } from "./routes/heygen-voices.js";
import { heygenAvatarsRoutes } from "./routes/heygen-avatars.js";
import { didVoicesRoutes } from "./routes/d-id-voices.js";
import { uploadsRoutes } from "./routes/uploads.js";
import { higgsfieldMotionsRoutes } from "./routes/higgsfield-motions.js";
import { soulStylesRoutes } from "./routes/soul-styles.js";
import { userAvatarsRoutes } from "./routes/user-avatars.js";
import { accountRoutes } from "./routes/account.js";
import { elevenlabsVoicesRoutes } from "./routes/elevenlabs-voices.js";
import { cartesiaVoicesRoutes } from "./routes/cartesia-voices.js";
import { userVoicesRoutes } from "./routes/user-voices.js";
import { downloadRoutes } from "./routes/download.js";
import { wsRoutes } from "./routes/ws.js";
import { webPromptsRoutes } from "./routes/web-prompts.js";
import { webGenerationRoutes } from "./routes/web-generation.js";
import { webUserAvatarsRoutes } from "./routes/web-user-avatars.js";
import { startRateScheduler } from "./services/exchange-rate.service.js";
import { startSubscriptionScheduler } from "./services/subscription.service.js";

export interface BuildAppOptions {
  /**
   * Start cron schedulers, pricing-config preload, and job-notification
   * pubsub subscriber. Default true — production entry. Tests pass `false`
   * to keep the instance pure and fast.
   */
  startBackgroundJobs?: boolean;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const { startBackgroundJobs = true } = opts;
  const __dirname = dirname(fileURLToPath(import.meta.url));

  const server = Fastify({ logger: false });

  await server.register(cookie, {});
  await server.register(cors, {
    origin: true,
    credentials: true,
    exposedHeaders: ["X-Refresh-Wtoken"],
  });
  await server.register(helmet);

  await server.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    errorResponseBuilder: () => ({ error: "Too Many Requests" }),
  });

  await server.register(swagger, {
    openapi: {
      info: {
        title: "Metabox AI Bot API",
        version: "1.0.0",
        description: "Internal API for Metabox Telegram Mini App",
      },
      components: {
        securitySchemes: {
          auth: {
            type: "apiKey",
            in: "header",
            name: "Authorization",
            description: "Telegram Mini App auth: `tma <initDataRaw>`",
          },
        },
      },
    },
  });
  await server.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list" },
  });

  await server.register(fastifyMultipart, {
    limits: { fileSize: 25 * 1024 * 1024 },
  });
  await server.register(fastifyStatic, {
    root: join(__dirname, "..", "uploads"),
    prefix: "/uploads/",
    decorateReply: false,
  });

  const REQUEST_LOG_SKIP_PREFIX = ["/health", "/metrics", "/docs", "/uploads/"];
  function shouldSkipRequestLog(url: string): boolean {
    const path = url.split("?")[0];
    return REQUEST_LOG_SKIP_PREFIX.some(
      (p) => path === p || path.startsWith(`${p}/`) || path === p,
    );
  }

  server.addHook("onRequest", async (request) => {
    if (!logger.isLevelEnabled("debug")) return;
    if (shouldSkipRequestLog(request.url)) return;
    (request as FastifyRequest & { _startTime?: number })._startTime = Date.now();
    logger.debug(
      {
        method: request.method,
        url: request.url,
        ip: request.ip,
        ua: request.headers["user-agent"],
      },
      "api request",
    );
  });

  server.addHook("onResponse", async (request, reply) => {
    if (shouldSkipRequestLog(request.url)) return;
    const started = (request as FastifyRequest & { _startTime?: number })._startTime;
    const durationMs = started ? Date.now() - started : undefined;
    const ctx = {
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      durationMs,
      userId: (request as FastifyRequest & { userId?: bigint }).userId?.toString(),
    };
    if (reply.statusCode >= 500) {
      logger.error(ctx, "api response 5xx");
    } else if (reply.statusCode >= 400) {
      logger.warn(ctx, "api response 4xx");
    } else if (logger.isLevelEnabled("debug")) {
      logger.debug(ctx, "api response");
    }
  });

  server.setErrorHandler(
    (error: Error & { statusCode?: number; code?: string }, request, reply) => {
      const status =
        typeof error.statusCode === "number" && error.statusCode >= 400 ? error.statusCode : 500;
      const ctx = {
        method: request.method,
        url: request.url,
        status,
        userId: (request as FastifyRequest & { userId?: bigint }).userId?.toString(),
        code: error.code,
        err: { message: error.message, stack: error.stack, name: error.name },
      };
      if (status >= 500) {
        logger.error(ctx, "api handler error");
      } else {
        logger.warn(ctx, "api handler error");
      }
      reply.status(status).send({ error: error.message ?? "Internal Server Error" });
    },
  );

  server.get("/health", { schema: { hide: true } }, async () => ({ status: "ok" }));

  server.post("/suno-callback", { schema: { hide: true } }, async (request, reply) => {
    logger.info({ body: request.body }, "Suno callback received");
    return reply.status(200).send({ ok: true });
  });

  server.get("/metrics", { schema: { hide: true } }, async (_request, reply) => {
    const metrics = await registry.metrics();
    await reply.type(registry.contentType).send(metrics);
  });

  await server.register(authRoutes);
  await server.register(webAuthRoutes);
  await server.register(webChatRoutes);
  await server.register(webModelsRoutes);
  await server.register(webGalleryRoutes);
  await server.register(webVoicesRoutes);
  await server.register(webPickersRoutes);
  await server.register(webBillingRoutes);
  await server.register(profileRoutes);
  await server.register(dialogsRoutes);
  await server.register(stateRoutes);
  await server.register(modelsRoutes);
  await server.register(adminRoutes);
  await server.register(adminKeysRoutes);
  await server.register(adminPricingRoutes);
  await server.register(paymentsRoutes);
  await server.register(galleryRoutes);
  await server.register(slidesRoutes);
  await server.register(imageSettingsRoutes);
  await server.register(videoSettingsRoutes);
  await server.register(modelSettingsRoutes);
  await server.register(internalRoutes, { prefix: "/internal" });
  await server.register(metaboxAibotRoutes);
  await server.register(tariffsRoutes);
  await server.register(heygenVoicesRoutes);
  await server.register(heygenAvatarsRoutes);
  await server.register(didVoicesRoutes);
  await server.register(uploadsRoutes);
  await server.register(higgsfieldMotionsRoutes);
  await server.register(soulStylesRoutes);
  await server.register(userAvatarsRoutes);
  await server.register(accountRoutes);
  await server.register(elevenlabsVoicesRoutes);
  await server.register(cartesiaVoicesRoutes);
  await server.register(userVoicesRoutes);
  await server.register(downloadRoutes);
  await server.register(wsRoutes);
  await server.register(webPromptsRoutes);
  await server.register(webGenerationRoutes);
  await server.register(webUserAvatarsRoutes);

  if (startBackgroundJobs) {
    startRateScheduler();
    startSubscriptionScheduler();
    await initPricingConfig();
    await startJobNotificationsSubscriber(dispatchJobNotification);
  }

  return server;
}
