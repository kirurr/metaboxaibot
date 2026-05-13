-- Структурированная категория ошибки для GenerationJob, чтобы строить
-- статистику по видам отказов (INPUT_MODERATION, RATE_LIMIT_LONG,
-- PROVIDER_UNAVAILABLE и т.п.). Полный список — `GenerationErrorCode` в
-- packages/shared/src/error-codes.ts.
--
-- Колонка nullable: старые джобы (до выкатки) останутся без значения и
-- естественно отфильтруются в admin-запросах `WHERE errorCode IS NOT NULL`.
-- Backfill не делаем — текст в `error` уже свободный, ретроспективно
-- классифицировать его без оригинального exception'а невозможно.

ALTER TABLE "generation_jobs" ADD COLUMN "errorCode" TEXT;

-- Индекс для агрегаций в админке: COUNT(*) / GROUP BY errorCode за период.
CREATE INDEX "generation_jobs_errorCode_idx" ON "generation_jobs"("errorCode");
