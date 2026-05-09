-- Один и тот же telegramId может удалиться несколько раз: юзер удалил аккаунт
-- через mini-app → нажал /start → registered заново → снова удалил. Каждое
-- удаление — отдельный snapshot для аудита и retry-reconcile.
-- Снимаем unique-constraint, оставляем regular index.

DROP INDEX IF EXISTS "deleted_users_telegramId_key";
CREATE INDEX IF NOT EXISTS "deleted_users_telegramId_idx" ON "deleted_users"("telegramId");
