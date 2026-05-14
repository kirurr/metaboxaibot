-- Decouple User.id from Telegram user ID.
--
-- Было: `id BIGINT PRIMARY KEY` устанавливался явно из `ctx.from.id` бота —
-- т.е. PK совпадал с tgid. Это блокировало регистрацию через web без TG.
--
-- Становится:
--  * `id BIGINT PRIMARY KEY DEFAULT nextval('users_id_seq')` — сурогатный
--    автоинкрементный PK. Sequence стартует от max(MAX(id)+1, 10^12), чтобы
--    новые синтетические id никогда не пересекались с историческими
--    (равными tgid) и с любым реалистичным tgid в будущем.
--  * `telegramId BIGINT UNIQUE NULL` — отдельная колонка, ключ для всех
--    Telegram-операций (lookup по `ctx.from.id`, `chat_id` для API-вызовов,
--    ключ для WelcomeBonusReceipt / GrantedMetaboxOrder).
--
-- Backfill: для всех существующих юзеров `telegramId := id` (т.к. до этой
-- миграции id был tgid по построению). После миграции code-paths можно
-- мигрировать на lookup по `telegramId` без data-loss.

ALTER TABLE "users" ADD COLUMN "telegramId" BIGINT;

UPDATE "users" SET "telegramId" = "id" WHERE "telegramId" IS NULL;

CREATE UNIQUE INDEX "users_telegramId_key" ON "users"("telegramId");

-- Sequence для нового автоинкремента. Start = max(MAX(id)+1, 10^12).
-- 10^12 — буфер на случай, если где-то ещё остался code-path `where: { id: tgid }`,
-- который при пропуске мог бы обратиться к синтетическому id, думая что это tgid.
-- Текущие tgid'ы в 2026 — ~10^10, так что 10^12 даёт 100x запас.
CREATE SEQUENCE "users_id_seq" AS BIGINT;
SELECT setval(
  '"users_id_seq"',
  GREATEST((SELECT COALESCE(MAX("id"), 0) FROM "users") + 1, 1000000000000),
  false
);
ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT nextval('"users_id_seq"');
ALTER SEQUENCE "users_id_seq" OWNED BY "users"."id";

-- DeletedUser.telegramId — делаем nullable: web-only юзер мог удалить аккаунт
-- без TG-привязки, snapshot всё равно нужен для аудита/retry-reconcile.
ALTER TABLE "deleted_users" ALTER COLUMN "telegramId" DROP NOT NULL;
