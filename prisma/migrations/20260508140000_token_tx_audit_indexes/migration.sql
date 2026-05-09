-- Индексы под аудит-запросы в Grafana по token_transactions:
-- агрегации по дате/модели/провайдеру с фильтром type='debit' AND actualCostUsd IS NOT NULL.
-- Без них Grafana-дашборд (расходы по моделям, time-series по дням, маржа)
-- делал бы seq-scan по всей таблице на каждый рефреш.
--
-- ВАЖНО: индексы создаются БЕЗ `CONCURRENTLY` — Prisma migrate оборачивает
-- каждую миграцию в транзакцию, а CONCURRENTLY в транзакции запрещён.
-- При создании индекса блокируется запись в таблицу на несколько секунд
-- (ровно столько, сколько занимает построение индекса). Для маленьких
-- инстансов это OK.
--
-- ЕСЛИ token_transactions В ПРОДЕ БОЛЬШАЯ (50k+ строк) и блокировка
-- неприемлема — выполнить ВРУЧНУЮ ДО `prisma migrate deploy`:
--   psql -d aibot -c '
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tx_audit
--       ON token_transactions ("createdAt", "modelId", "actualProvider")
--       WHERE type = '\''debit'\'' AND "actualCostUsd" IS NOT NULL;
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tx_model_reason_created
--       ON token_transactions ("modelId", reason, "createdAt")
--       WHERE type = '\''debit'\'';
--   '
-- После этого `IF NOT EXISTS` в миграции скипнется и всё применится без блокировок.

-- 1. Композитный partial-индекс под дашборд расходов:
--    time-range фильтр + group by model/provider, только debit + actualCostUsd.
CREATE INDEX IF NOT EXISTS "idx_tx_audit"
  ON "token_transactions" ("createdAt", "modelId", "actualProvider")
  WHERE type = 'debit' AND "actualCostUsd" IS NOT NULL;

-- 2. Под фильтр по конкретной модели + reason (типы списаний:
--    ai_usage / autotranslate / describe_image / soul_creation).
CREATE INDEX IF NOT EXISTS "idx_tx_model_reason_created"
  ON "token_transactions" ("modelId", reason, "createdAt")
  WHERE type = 'debit';
