-- Support panel-initiated Go agent self-update tracking.
ALTER TABLE nodes ADD COLUMN desired_agent_version TEXT;
ALTER TABLE nodes ADD COLUMN last_update_error TEXT;
ALTER TABLE nodes ADD COLUMN last_update_at INTEGER;
