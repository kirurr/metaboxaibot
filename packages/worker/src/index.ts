import "dotenv/config";
import { config, preloadLocales } from "@metabox/shared";

await preloadLocales(["ru", "en"]);
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import type { ImageJobData, VideoJobData, AudioJobData, AvatarJobData } from "@metabox/api/queues";
import { processImageJob } from "./processors/image.processor.js";
import { processVideoJob } from "./processors/video.processor.js";
import { processAudioJob } from "./processors/audio.processor.js";
import { processAvatarJob } from "./processors/avatar.processor.js";
import { checkProviderBalances } from "./monitors/balance.monitor.js";
import { sendUsageReport, msUntilNextMidnightMsk } from "./monitors/usage-report.monitor.js";
import { runWatchdog } from "./monitors/watchdog.monitor.js";
import { runCleanupOldJobs } from "./monitors/cleanup-old-jobs.monitor.js";
import { runPendingGenerationCleanup } from "./monitors/pending-generation.monitor.js";
import { reconcileOrphanedJobs } from "./reconcile.js";
import { initPricingConfig } from "@metabox/api/services/pricing-config";
import { logger } from "./logger.js";

// Загружаем runtime price overrides до первого calculateCost (final billing
// в processor'ах). При пустой таблице поведение идентично env-конфигу.
await initPricingConfig();

const connection = new Redis(config.redis.url, {
  maxRetriesPerRequest: null,
});

const imageWorker = new Worker<ImageJobData>("image", processImageJob, {
  connection,
  concurrency: 3,
});

imageWorker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "Image job completed");
});

imageWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "Image job failed");
});

const videoWorker = new Worker<VideoJobData>("video", processVideoJob, {
  connection,
  concurrency: 2,
});

videoWorker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "Video job completed");
});

videoWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "Video job failed");
});

const audioWorker = new Worker<AudioJobData>("audio", processAudioJob, {
  connection,
  concurrency: 5,
});

audioWorker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "Audio job completed");
});

audioWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "Audio job failed");
});

const avatarWorker = new Worker<AvatarJobData>("avatar", processAvatarJob, {
  connection,
  concurrency: 3,
});

avatarWorker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "Avatar job completed");
});

avatarWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "Avatar job failed");
});

logger.info("Worker started — listening on image, video, audio and avatar queues");

// ── Reconcile orphaned jobs on startup ────────────────────────────────────────
reconcileOrphanedJobs().catch((err) => logger.error({ err }, "Reconcile error"));

// ── Watchdog: re-enqueue stuck jobs every 10 min (no overlap) ────────────────
const WATCHDOG_INTERVAL_MS = 10 * 60 * 1000;
let watchdogTimer: ReturnType<typeof setTimeout>;
const scheduleWatchdog = (): void => {
  watchdogTimer = setTimeout(() => {
    runWatchdog()
      .catch((err) => logger.error({ err }, "Watchdog error"))
      .finally(() => scheduleWatchdog());
  }, WATCHDOG_INTERVAL_MS);
};
scheduleWatchdog();

// ── Cleanup: purge generation jobs older than 60 days (daily, no overlap) ───
// Run once on startup so a long-stopped worker drains the backlog immediately,
// then every 24 h via self-rescheduling setTimeout (mirrors watchdog pattern).
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setTimeout>;
const scheduleCleanup = (): void => {
  cleanupTimer = setTimeout(() => {
    runCleanupOldJobs()
      .catch((err) => logger.error({ err }, "Cleanup-old-jobs error"))
      .finally(() => scheduleCleanup());
  }, CLEANUP_INTERVAL_MS);
};
runCleanupOldJobs().catch((err) => logger.error({ err }, "Cleanup-old-jobs error"));
scheduleCleanup();

// ── Pending generation cleanup: drop expired confirm-rows every 10 min ──────
const PENDING_GEN_INTERVAL_MS = 10 * 60 * 1000;
let pendingGenTimer: ReturnType<typeof setTimeout>;
const schedulePendingGenCleanup = (): void => {
  pendingGenTimer = setTimeout(() => {
    runPendingGenerationCleanup()
      .catch((err) => logger.error({ err }, "Pending-generation cleanup error"))
      .finally(() => schedulePendingGenCleanup());
  }, PENDING_GEN_INTERVAL_MS);
};
schedulePendingGenCleanup();

// ── Balance monitor ───────────────────────────────────────────────────────────
// Шлёт алерты в balanceAlerts.chatId (тема BALANCE); не запускается, если этот
// канал не настроен. balanceAlerts.chatId дефолтится на ALERT_CHAT_ID, так что
// при обычной конфигурации (один ALERT_CHAT_ID) поведение не меняется.
let balanceTimer: ReturnType<typeof setInterval> | undefined;
if (config.balanceAlerts.chatId) {
  const intervalMs = config.alerts.intervalHours * 60 * 60 * 1000;
  checkProviderBalances().catch((err) => logger.error({ err }, "Balance monitor error"));
  balanceTimer = setInterval(() => {
    checkProviderBalances().catch((err) => logger.error({ err }, "Balance monitor error"));
  }, intervalMs);
  logger.info({ intervalHours: config.alerts.intervalHours }, "Balance monitor started");
}

// ── Daily usage report at 00:00 MSK ──────────────────────────────────────────
// Шлёт в reports.chatId (по умолчанию = alerts.chatId через фоллбек в config).
// Независим от balance monitor — можно крутить отчёты в отдельном канале без алертов.
let usageReportTimer: ReturnType<typeof setInterval> | undefined;
if (config.reports.chatId) {
  const scheduleUsageReport = (): void => {
    const delay = msUntilNextMidnightMsk();
    logger.info({ delayMin: Math.round(delay / 60_000) }, "Usage report scheduled");
    setTimeout(() => {
      sendUsageReport().catch((err) => logger.error({ err }, "Usage report error"));
      usageReportTimer = setInterval(
        () => {
          sendUsageReport().catch((err) => logger.error({ err }, "Usage report error"));
        },
        24 * 60 * 60 * 1000,
      );
    }, delay);
  };
  scheduleUsageReport();
}

process.on("SIGTERM", async () => {
  clearTimeout(watchdogTimer);
  clearTimeout(cleanupTimer);
  clearTimeout(pendingGenTimer);
  if (balanceTimer) clearInterval(balanceTimer);
  if (usageReportTimer) clearInterval(usageReportTimer);
  await Promise.all([
    imageWorker.close(),
    videoWorker.close(),
    audioWorker.close(),
    avatarWorker.close(),
  ]);
  process.exit(0);
});
