-- Persist subscription tokens so administrators can view and copy existing
-- subscription links after removing token rotation. Legacy rows stay NULL.
ALTER TABLE subscriptions ADD COLUMN token TEXT;
