-- Replace per-node one-time enrollment tokens with a single rotatable, reusable
-- panel-wide enrollment token stored by SHA-256 hash in meta.
DROP TABLE IF EXISTS node_enrollment_tokens;
