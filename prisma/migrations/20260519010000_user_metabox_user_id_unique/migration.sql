-- Safety-net unique constraint on `users.metaboxUserId`.
--
-- До этой миграции дубликаты теоретически могли возникнуть при race condition
-- между двумя одновременными вызовами `ensureAibUserForMetabox` для одного
-- metaboxUserId (web-login flow), либо если бы где-то проставлялся metaboxUserId
-- без `mergeWebUserIfExists`. Теперь все three точки записи прикрыты merge'ем,
-- и constraint гарантирует, что новые дубли не появятся даже при гонке.
--
-- Pre-check: миграция падает (с понятной диагностикой), если в существующих
-- данных есть дубликаты — DBA должен сначала их смержить вручную.
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT "metaboxUserId"
    FROM "users"
    WHERE "metaboxUserId" IS NOT NULL
    GROUP BY "metaboxUserId"
    HAVING COUNT(*) > 1
  ) AS duplicates;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'Cannot add UNIQUE constraint on users.metaboxUserId: % duplicate value(s) found. Merge duplicates via mergeWebUserIntoBotUser then retry.',
      dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX "users_metaboxUserId_key" ON "users"("metaboxUserId");
