-- Recycle bin support for disabled subscribers, revoked subscriptions, and soft-deleted profiles.
ALTER TABLE subscribers ADD COLUMN disabled_at INTEGER;
UPDATE subscribers SET disabled_at = updated_at WHERE status = 'disabled' AND disabled_at IS NULL;
CREATE INDEX idx_subscribers_disabled_at ON subscribers (disabled_at) WHERE status = 'disabled';

CREATE INDEX idx_subscriptions_revoked_at ON subscriptions (revoked_at) WHERE revoked_at IS NOT NULL;

ALTER TABLE subscription_profiles ADD COLUMN deleted_at INTEGER;
CREATE INDEX idx_profiles_deleted_at ON subscription_profiles (deleted_at) WHERE deleted_at IS NOT NULL;
