-- Идемпотентность зачисления токенов по AiBotOrder со стороны Metabox.
-- Без FK на users — запись переживает cascade-удаление аккаунта
-- (account-deletion.service.ts), иначе после deletion + повторного /start
-- metabox мог бы повторно начислить уже зачислявшийся order.
--
-- Ключ — AiBotOrder.id (cuid с metabox-стороны), глобально уникален.
-- Используется в:
--   * syncMetaboxGrants (бот /start pull-flow) — pre-check + создание в транзакции;
--   * /grant-tokens endpoint (metabox push-flow) — dedup по orderId, если передан.

CREATE TABLE "granted_metabox_orders" (
    "orderId"     TEXT          NOT NULL,
    "telegramId"  BIGINT        NOT NULL,
    "tokens"      DECIMAL(12,4) NOT NULL,
    "description" TEXT,
    "grantedAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "granted_metabox_orders_pkey" PRIMARY KEY ("orderId")
);

CREATE INDEX "granted_metabox_orders_telegramId_idx"
  ON "granted_metabox_orders" ("telegramId");
