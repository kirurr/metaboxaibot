import { DelayedError, type Job } from "bullmq";
import { delayJob } from "../utils/delay-job.js";
import { Api } from "grammy";
import type { AvatarJobData } from "@metabox/api/queues";
import { getAvatarQueue } from "@metabox/api/queues";
import { userAvatarService } from "@metabox/api/services/user-avatar";
import {
  getFileUrl,
  generateThumbnail,
  buildThumbnailKey,
  uploadBuffer,
} from "@metabox/api/services/s3";
import { HeyGenAvatarAdapter } from "@metabox/api/ai/avatar/heygen";
import { HiggsFieldSoulAdapter } from "@metabox/api/ai/avatar/higgsfield-soul";
import { logger } from "../logger.js";
import { config, getT } from "@metabox/shared";
import type { Language } from "@metabox/shared";
import { db } from "@metabox/api/db";
import { deductTokens, usdToTokens } from "@metabox/api/services";
import { notifyTechError } from "../utils/notify-error.js";
import { submitWithThrottle, isRateLimitLongWindowError } from "../utils/submit-with-throttle.js";
import { deferIfTransientNetworkError } from "../utils/defer-transient.js";
import { resolveUserFacingMessage } from "../utils/user-facing-error.js";
import { acquireKey, acquireById } from "@metabox/api/services/key-pool";
import type { AcquiredKey } from "@metabox/api/services/key-pool";
import { buildProxyFetch } from "@metabox/api/ai/proxy-fetch";
import { isPoolExhaustedError } from "@metabox/api/utils/pool-exhausted-error";

const telegram = new Api(config.bot.token);

/** Delay between polls (5 minutes) */
const POLL_DELAY_MS = 1 * 60 * 1000;
/** Maximum poll attempts (~2 hours) */
const MAX_POLL_ATTEMPTS = 30;

function buildHeyGenAdapter(acquired: AcquiredKey): HeyGenAvatarAdapter {
  const fetchFn = buildProxyFetch(acquired.proxy) ?? undefined;
  return new HeyGenAvatarAdapter(acquired.apiKey, fetchFn);
}

function buildSoulAdapter(acquired: AcquiredKey): HiggsFieldSoulAdapter {
  const fetchFn = buildProxyFetch(acquired.proxy) ?? undefined;
  return new HiggsFieldSoulAdapter(acquired.apiKey, fetchFn);
}

/**
 * USD-стоимость создания Soul-персонажа. Должна совпадать со значением в
 * bot/src/scenes/video.ts (там используется для checkBalance на сабмите).
 */
const SOUL_COST_USD = 2.5;

/**
 * Создаёт WebP-thumbnail из ПЕРВОГО фото Soul-персонажа и заливает его рядом
 * с оригиналом по `buildThumbnailKey` (e.g. `..._thumb.webp`). Возвращает
 * S3-ключ thumbnail'а или `null` если что-то пошло не так — caller должен
 * обработать null как "нет preview" и не падать (preview — best-effort).
 *
 * Причина существования: HiggsField's API возвращает `previewUrl` ТОЛЬКО на
 * стадии poll'а после `status: ready`, и у юзера в мини-аппе пустая карточка
 * персонажа все 5-15 минут пока он создаётся. Делаем preview из исходного
 * фото сразу — UX гораздо лучше.
 */
async function buildSoulPreviewThumbnail(s3Key: string): Promise<string | null> {
  try {
    const url = await getFileUrl(s3Key);
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const thumb = await generateThumbnail(buf, contentType);
    if (!thumb) return null;
    const thumbKey = buildThumbnailKey(s3Key);
    const uploaded = await uploadBuffer(thumbKey, thumb, "image/webp").catch(() => null);
    return uploaded ?? null;
  } catch {
    return null;
  }
}

export async function processAvatarJob(job: Job<AvatarJobData>, token?: string): Promise<void> {
  const {
    userAvatarId,
    userId: userIdStr,
    provider,
    action,
    imageUrl,
    s3Key,
    telegramChatId,
    pollAttempt = 0,
    s3Keys,
    characterName,
  } = job.data;

  logger.info({ userAvatarId, provider, action, pollAttempt }, "Processing avatar job");

  // ── Higgsfield Soul: dedicated create/poll flow ──────────────────────────
  if (provider === "higgsfield_soul") {
    if (action === "create") {
      try {
        if (!s3Keys?.length) throw new Error("No S3 keys for Soul creation");

        // Soul ID живёт в аккаунте конкретного API-ключа. Привязываемся к нему
        // на этапе create и сохраняем providerKeyId — poll и удаление пойдут
        // через тот же ключ.
        let acquired: AcquiredKey;
        try {
          acquired = await acquireKey("higgsfield_soul");
        } catch (e) {
          if (isPoolExhaustedError(e)) {
            await job.moveToDelayed(Date.now() + e.retryAfterMs, token);
            logger.info(
              { userAvatarId, retryAfterMs: e.retryAfterMs },
              "Soul create deferred: pool exhausted",
            );
            throw new DelayedError();
          }
          throw e;
        }
        const soulAdapter = buildSoulAdapter(acquired);

        // Resolve all S3 keys to presigned URLs
        const imageUrls = await Promise.all(
          s3Keys.map(async (key) => {
            const url = await getFileUrl(key).catch(() => null);
            if (!url) throw new Error(`Failed to resolve S3 key: ${key}`);
            return url;
          }),
        );

        const { externalId } = await soulAdapter.create(characterName ?? "My Character", imageUrls);

        // Best-effort preview thumbnail из первого исходного фото — чтобы юзер
        // видел картинку в мини-аппе пока персонаж процессится. На poll'е
        // `previewUrl` перетрётся реальным provider preview'ом если HiggsField
        // его отдаст; иначе наш thumbnail остаётся постоянным.
        const previewKey = s3Keys[0] ? await buildSoulPreviewThumbnail(s3Keys[0]) : null;

        await userAvatarService.updateStatus(userAvatarId, {
          status: "creating",
          externalId,
          providerKeyId: acquired.keyId,
          ...(previewKey ? { previewUrl: previewKey } : {}),
        });

        logger.info(
          { userAvatarId, externalId, keyId: acquired.keyId },
          "Soul creation submitted, poll scheduled",
        );
        await delayJob(job, { ...job.data, action: "poll", pollAttempt: 0 }, POLL_DELAY_MS, token);
      } catch (err) {
        if (err instanceof DelayedError) throw err;
        // Throws DelayedError if rescheduled; returns silently otherwise → fall through.
        await deferIfTransientNetworkError({ err, job, token, section: "avatar" });
        logger.error({ userAvatarId, err }, "Soul creation failed");
        await userAvatarService.updateStatus(userAvatarId, { status: "failed" });
        await notifyTechError(err, { jobId: userAvatarId, section: "avatar", modelId: provider });

        const userLang = (await db.user
          .findUnique({ where: { id: BigInt(userIdStr) }, select: { language: true } })
          .then((u) => u?.language ?? "en")) as Language;
        const t = getT(userLang);
        const userMsg = resolveUserFacingMessage(err, t);
        await telegram
          .sendMessage(telegramChatId, userMsg ?? t.video.soulFailed)
          .catch(() => void 0);
      }
      return;
    }

    if (action === "poll") {
      try {
        const avatar = await userAvatarService.findById(userAvatarId);
        if (!avatar?.externalId) {
          logger.warn({ userAvatarId }, "Soul avatar not found or no externalId, skipping poll");
          return;
        }

        const userLang = (await db.user
          .findUnique({ where: { id: BigInt(userIdStr) }, select: { language: true } })
          .then((u) => u?.language ?? "en")) as Language;
        const t = getT(userLang);

        // Sticky-key poll: ресурс live на конкретном аккаунте. Если ключ удалён
        // → markOrphaned + ошибка пользователю (пересоздать персонажа).
        let acquired: AcquiredKey;
        try {
          acquired = await acquireById(avatar.providerKeyId, "higgsfield_soul");
        } catch (e) {
          logger.warn(
            { userAvatarId, keyId: avatar.providerKeyId, err: e },
            "Soul poll: owning key gone, marking avatar orphaned",
          );
          await userAvatarService.markOrphaned(userAvatarId);
          await telegram.sendMessage(telegramChatId, t.video.soulFailed).catch(() => void 0);
          return;
        }
        const soulAdapter = buildSoulAdapter(acquired);

        const result = await soulAdapter.poll(avatar.externalId);

        if (result.status === "ready") {
          // Idempotent finalize: atomic compare-and-swap on `status` ensures only
          // one worker run flips "creating" → "ready" and runs the deduction.
          // Если воркер крашнется между updateMany и deductTokens — сценарий
          // "Soul бесплатно" (приемлемо vs двойного списания при ретрае).
          const swap = await db.userAvatar.updateMany({
            where: { id: userAvatarId, status: "creating" },
            data: {
              status: "ready",
              ...(avatar.previewUrl || !result.previewUrl ? {} : { previewUrl: result.previewUrl }),
            },
          });

          if (swap.count === 0) {
            // Уже финализирован другим запуском — не списываем повторно.
            logger.info(
              { userAvatarId },
              "Soul: avatar already finalized, skipping double deduction",
            );
            return;
          }

          // Списываем ПОСЛЕ успешного flip'а статуса. Если за 5-15 минут пока
          // шла обработка юзер потратил баланс в другом месте — deductTokens
          // декрементит до отрицательного значения (мы съедаем стоимость за
          // HiggsField API, но даём готового персонажа). checkBalance на сабмите
          // в bot/scenes/video.ts уже отгейтил кейс "не хватает на момент клика".
          await deductTokens(
            BigInt(userIdStr),
            usdToTokens(SOUL_COST_USD),
            "higgsfield_soul",
            undefined,
            "soul_creation",
            // Soul creation — фиксированная цена без fallback'а; provider
            // совпадает с modelId, актуальная USD-цена = SOUL_COST_USD.
            { actualProvider: "higgsfield_soul", actualCostUsd: SOUL_COST_USD },
          );

          await telegram
            .sendMessage(
              telegramChatId,
              t.video.soulReady.replace("{name}", avatar.name ?? characterName ?? ""),
            )
            .catch(() => void 0);
          logger.info({ userAvatarId }, "Soul character ready");
          return;
        }

        if (result.status === "failed") {
          await userAvatarService.updateStatus(userAvatarId, { status: "failed" });
          await telegram.sendMessage(telegramChatId, t.video.soulFailed).catch(() => void 0);
          logger.warn({ userAvatarId }, "Soul processing failed");
          return;
        }

        // Still processing — reschedule
        const nextAttempt = pollAttempt + 1;
        if (nextAttempt >= MAX_POLL_ATTEMPTS) {
          await userAvatarService.updateStatus(userAvatarId, { status: "failed" });
          await telegram.sendMessage(telegramChatId, t.video.soulFailed).catch(() => void 0);
          logger.warn({ userAvatarId }, "Soul poll timed out");
          return;
        }

        logger.info({ userAvatarId, nextAttempt }, "Soul still processing, rescheduled");
        await delayJob(
          job,
          { ...job.data, action: "poll", pollAttempt: nextAttempt },
          POLL_DELAY_MS,
          token,
        );
      } catch (err) {
        if (err instanceof DelayedError) throw err;
        // Throws DelayedError if rescheduled; returns silently otherwise → fall through.
        await deferIfTransientNetworkError({ err, job, token, section: "avatar" });
        logger.error({ userAvatarId, err }, "Soul poll error");
        await notifyTechError(err, {
          jobId: userAvatarId,
          section: "avatar",
          modelId: provider,
          attempt: pollAttempt,
        });
        const nextAttempt = pollAttempt + 1;
        if (nextAttempt < MAX_POLL_ATTEMPTS) {
          await delayJob(
            job,
            { ...job.data, action: "poll", pollAttempt: nextAttempt },
            POLL_DELAY_MS,
            token,
          );
        }
      }
    }
    return;
  }

  // ── Standard avatar providers (HeyGen, etc.) ────────────────────────────

  if (action === "create") {
    try {
      // Resolve image URL — prefer fresh presigned URL from S3
      const resolvedUrl = s3Key
        ? ((await getFileUrl(s3Key).catch(() => null)) ?? imageUrl)
        : imageUrl;

      if (!resolvedUrl) throw new Error("No image URL available for avatar creation");

      const imgRes = await fetch(resolvedUrl);
      if (!imgRes.ok) throw new Error(`Failed to fetch avatar image: ${imgRes.status}`);
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
      const contentType = imgRes.headers.get("content-type") ?? "image/jpeg";

      // talking_photo_id живёт в аккаунте конкретного HeyGen-ключа.
      // Привязываемся на этапе create — poll и видео-генерация пойдут через него.
      let acquired: AcquiredKey;
      try {
        acquired = await acquireKey(provider);
      } catch (e) {
        if (isPoolExhaustedError(e)) {
          await job.moveToDelayed(Date.now() + e.retryAfterMs, token);
          logger.info(
            { userAvatarId, retryAfterMs: e.retryAfterMs },
            "Avatar create deferred: pool exhausted",
          );
          throw new DelayedError();
        }
        throw e;
      }
      const adapter = buildHeyGenAdapter(acquired);

      const { externalId } = await submitWithThrottle({
        modelId: provider,
        provider,
        section: "avatar",
        job,
        queue: getAvatarQueue(),
        jobName: "create",
        keyId: acquired.keyId,
        submit: () => adapter.create(imgBuffer, contentType),
      });

      // HeyGen asset upload is synchronous — mark ready immediately, skip poll.
      if (provider === "heygen") {
        await userAvatarService.updateStatus(userAvatarId, {
          status: "ready",
          externalId,
          providerKeyId: acquired.keyId,
        });
        const userLang = (await db.user
          .findUnique({ where: { id: BigInt(userIdStr) }, select: { language: true } })
          .then((u) => u?.language ?? "en")) as Language;
        const t = getT(userLang);
        await telegram.sendMessage(telegramChatId, t.video.avatarReady).catch(() => void 0);
        logger.info({ userAvatarId, externalId, keyId: acquired.keyId }, "HeyGen avatar ready");
        return;
      }

      await userAvatarService.updateStatus(userAvatarId, {
        status: "creating",
        externalId,
        providerKeyId: acquired.keyId,
      });

      logger.info(
        { userAvatarId, externalId, keyId: acquired.keyId },
        "Avatar creation submitted, poll scheduled",
      );
      await delayJob(job, { ...job.data, action: "poll", pollAttempt: 0 }, POLL_DELAY_MS, token);
    } catch (err) {
      if (err instanceof DelayedError) throw err;
      const userLang = (await db.user
        .findUnique({ where: { id: BigInt(userIdStr) }, select: { language: true } })
        .then((u) => u?.language ?? "en")) as Language;
      const t = getT(userLang);
      if (isRateLimitLongWindowError(err)) {
        await userAvatarService.updateStatus(userAvatarId, { status: "failed" });
        await telegram.sendMessage(telegramChatId, t.video.avatarFailed).catch(() => void 0);
        return;
      }
      // Throws DelayedError if rescheduled; returns silently otherwise → fall through.
      await deferIfTransientNetworkError({ err, job, token, section: "avatar" });
      logger.error({ userAvatarId, err }, "Avatar creation failed");
      await userAvatarService.updateStatus(userAvatarId, { status: "failed" });
      await notifyTechError(err, { jobId: userAvatarId, section: "avatar", modelId: provider });
      await telegram.sendMessage(telegramChatId, t.video.avatarFailed).catch(() => void 0);
    }
    return;
  }

  if (action === "poll") {
    try {
      const avatar = await userAvatarService.findById(userAvatarId);
      if (!avatar || !avatar.externalId) {
        logger.warn({ userAvatarId }, "Avatar not found or no externalId, skipping poll");
        return;
      }

      const userLang = (await db.user
        .findUnique({ where: { id: BigInt(userIdStr) }, select: { language: true } })
        .then((u) => u?.language ?? "en")) as Language;
      const t = getT(userLang);

      // Sticky-key poll. Если ключ удалён → markOrphaned + ошибка пользователю.
      let acquired: AcquiredKey;
      try {
        acquired = await acquireById(avatar.providerKeyId, provider);
      } catch (e) {
        logger.warn(
          { userAvatarId, keyId: avatar.providerKeyId, err: e },
          "Avatar poll: owning key gone, marking avatar orphaned",
        );
        await userAvatarService.markOrphaned(userAvatarId);
        await telegram.sendMessage(telegramChatId, t.video.avatarFailed).catch(() => void 0);
        return;
      }
      const adapter = buildHeyGenAdapter(acquired);

      const result = await adapter.poll(avatar.externalId);

      if (result.status === "ready") {
        await userAvatarService.updateStatus(userAvatarId, {
          status: "ready",
          // Use talking_photo_id if returned (HeyGen), otherwise keep the group_id
          externalId: result.talkingPhotoId ?? undefined,
          previewUrl: result.previewUrl,
        });
        await telegram.sendMessage(telegramChatId, t.video.avatarReady).catch(() => void 0);
        logger.info({ userAvatarId }, "Avatar ready");
        return;
      }

      if (result.status === "failed") {
        await userAvatarService.updateStatus(userAvatarId, { status: "failed" });
        await telegram.sendMessage(telegramChatId, t.video.avatarFailed).catch(() => void 0);
        logger.warn({ userAvatarId }, "Avatar processing failed");
        return;
      }

      // Still processing — schedule next poll if under limit
      const nextAttempt = pollAttempt + 1;
      if (nextAttempt >= MAX_POLL_ATTEMPTS) {
        await userAvatarService.updateStatus(userAvatarId, { status: "failed" });
        await telegram.sendMessage(telegramChatId, t.video.avatarFailed).catch(() => void 0);
        logger.warn({ userAvatarId }, "Avatar poll timed out");
        return;
      }

      logger.info({ userAvatarId, nextAttempt }, "Avatar still processing, rescheduled");
      await delayJob(
        job,
        { ...job.data, action: "poll", pollAttempt: nextAttempt },
        POLL_DELAY_MS,
        token,
      );
    } catch (err) {
      if (err instanceof DelayedError) throw err;
      // Throws DelayedError if rescheduled; returns silently otherwise → fall through.
      await deferIfTransientNetworkError({ err, job, token, section: "avatar" });
      logger.error({ userAvatarId, err }, "Avatar poll error");
      await notifyTechError(err, {
        jobId: userAvatarId,
        section: "avatar",
        modelId: provider,
        attempt: pollAttempt,
      });
      // Re-schedule on error (non-fatal) if under limit
      const nextAttempt = pollAttempt + 1;
      if (nextAttempt < MAX_POLL_ATTEMPTS) {
        await delayJob(
          job,
          { ...job.data, action: "poll", pollAttempt: nextAttempt },
          POLL_DELAY_MS,
          token,
        );
      }
    }
  }
}
