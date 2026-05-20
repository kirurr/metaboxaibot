-- Allow `telegramId` to be NULL on GrantedMetaboxOrder so that web-only users
-- (registered through ai.metabox.global without TG linking) can also be tracked
-- by the dedup table. Idempotency is guaranteed by the PRIMARY KEY on orderId;
-- telegramId is informational metadata, not part of the dedup constraint.
ALTER TABLE "granted_metabox_orders" ALTER COLUMN "telegramId" DROP NOT NULL;
