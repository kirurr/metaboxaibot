-- Дополняем token_transactions двумя audit-полями:
--   actualProvider — фактически использованный провайдер (может отличаться
--     от model.provider при fallback'е).
--   actualCostUsd — оценка цены запроса в USD на actualProvider, БЕЗ
--     применения pricing-коэффициентов (per-model multiplier, target margin).
-- Оба nullable: старые записи остаются как есть, заполнение начинается
-- с момента деплоя.

ALTER TABLE "token_transactions" ADD COLUMN "actualProvider" TEXT;
ALTER TABLE "token_transactions" ADD COLUMN "actualCostUsd" DECIMAL(12,6);
