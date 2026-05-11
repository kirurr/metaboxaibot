-- Учёт выдач welcome-бонуса. Без FK на users — запись должна пережить
-- cascade-удаление аккаунта (account-deletion.service.ts), чтобы юзер не
-- мог переполучить бонус через delete → /start заново.
--
-- Ключ — telegramId; Telegram не переиспользует ID, поэтому уникальность
-- сохраняется на всю жизнь юзера (даже через несколько удалений).

CREATE TABLE "welcome_bonus_receipts" (
    "telegramId"  BIGINT          NOT NULL,
    "amount"      DECIMAL(12, 4)  NOT NULL,
    "creditedAt"  TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "welcome_bonus_receipts_pkey" PRIMARY KEY ("telegramId")
);

-- Backfill: для всех уже существующих юзеров, у которых ранее проставлен
-- welcome_bonus в token_transactions, создаём receipt — иначе при удалении
-- такого юзера и повторном /start он получит бонус ещё раз.
--
-- Используем минимальный createdAt по каждому userId (на случай если каким-то
-- образом в проде есть >1 записи) и фактический amount той транзакции.
-- ON CONFLICT DO NOTHING — на случай повторного применения миграции.
INSERT INTO "welcome_bonus_receipts" ("telegramId", "amount", "creditedAt")
SELECT DISTINCT ON ("userId")
  "userId",
  "amount",
  "createdAt"
FROM "token_transactions"
WHERE reason = 'welcome_bonus' AND type = 'credit'
ORDER BY "userId", "createdAt" ASC
ON CONFLICT ("telegramId") DO NOTHING;
