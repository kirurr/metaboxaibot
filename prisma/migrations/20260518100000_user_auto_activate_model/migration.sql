-- Per-user toggle for instant model auto-activation in the webapp settings.
-- Default `true` preserves the current behavior (switching a model in the
-- mini-app immediately activates it). Users can opt out via the Account tab
-- to require an explicit "Активировать" tap.
ALTER TABLE "users" ADD COLUMN "autoActivateModel" BOOLEAN NOT NULL DEFAULT true;
