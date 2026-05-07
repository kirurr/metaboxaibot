-- Account deletion feature: архивная таблица DeletedUser + изменение
-- onDelete для referrals (SetNull) и добавление FK на GenerationJob -> users.

-- 1. Архивная таблица. Снапшот юзера на момент удаления.
--    pendingMetaboxTransfer=true => перенос tokens/sub на metabox-аккаунт не
--    прошёл; localSubscriptionSnapshot хранит данные для retry.
CREATE TABLE "deleted_users" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "language" TEXT NOT NULL,
    "metaboxUserId" TEXT,
    "metaboxReferralCode" TEXT,
    "tokenBalance" DECIMAL(12,4) NOT NULL,
    "subscriptionTokenBalance" DECIMAL(12,4) NOT NULL,
    "hadLocalSubscription" BOOLEAN NOT NULL DEFAULT false,
    "localSubscriptionSnapshot" JSONB,
    "pendingMetaboxTransfer" BOOLEAN NOT NULL DEFAULT false,
    "transferError" TEXT,
    "originalCreatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deleted_users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "deleted_users_telegramId_key" ON "deleted_users"("telegramId");
CREATE INDEX "deleted_users_metaboxUserId_idx" ON "deleted_users"("metaboxUserId");
CREATE INDEX "deleted_users_pendingMetaboxTransfer_idx" ON "deleted_users"("pendingMetaboxTransfer");

-- 2. Меняем User.referredBy → onDelete: SetNull. Удаление юзера должно
--    обнулять `referredById` у его рефералов вместо blocking-fail.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_referredById_fkey";
ALTER TABLE "users" ADD CONSTRAINT "users_referredById_fkey"
    FOREIGN KEY ("referredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Добавляем FK на GenerationJob (был только индекс userId, без relation).
--    После удаления юзера cascade прибьёт все его джобы; до этого orphans
--    оставались бесконечно.
--
-- ВАЖНО: до этого FK не было, поэтому в БД могли накопиться orphan-записи
-- (generation_jobs.userId, для которых нет соответствующего users.id —
-- например, после прежних ручных удалений или старых багов). ADD CONSTRAINT
-- упадёт на таких строках с FK violation. Зачищаем их явно перед ADD.
DELETE FROM "generation_jobs"
WHERE "userId" NOT IN (SELECT "id" FROM "users");

ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
