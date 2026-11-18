-- Support graceful remote agent uninstall triggered from the panel.
ALTER TABLE nodes ADD COLUMN uninstall_requested_at INTEGER;
ALTER TABLE nodes ADD COLUMN uninstall_remove_xray INTEGER NOT NULL DEFAULT 0 CHECK (uninstall_remove_xray IN (0, 1));
