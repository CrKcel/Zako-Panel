-- Move proxy credentials (xray_email, vless_uuid) from per-(subscriber, node)
-- node_clients grants onto subscribers directly so every active subscriber is
-- provisioned to all nodes and node access is governed by subscription profiles.
ALTER TABLE subscribers ADD COLUMN xray_email TEXT;
ALTER TABLE subscribers ADD COLUMN vless_uuid TEXT;

UPDATE subscribers
SET xray_email = COALESCE(
		(SELECT nc.xray_email
		 FROM node_clients nc
		 WHERE nc.subscriber_id = subscribers.id
		 ORDER BY nc.enabled DESC, nc.created_at ASC, nc.id ASC
		 LIMIT 1),
		'u_' || id
	),
	vless_uuid = COALESCE(
		(SELECT nc.vless_uuid
		 FROM node_clients nc
		 WHERE nc.subscriber_id = subscribers.id
		 ORDER BY nc.enabled DESC, nc.created_at ASC, nc.id ASC
		 LIMIT 1),
		lower(
			hex(randomblob(4)) || '-' ||
			hex(randomblob(2)) || '-4' ||
			substr(hex(randomblob(2)), 2) || '-' ||
			substr('89ab', 1 + (random() & 3), 1) ||
			substr(hex(randomblob(2)), 2) || '-' ||
			hex(randomblob(6))
		)
	);

CREATE UNIQUE INDEX idx_subscribers_xray_email ON subscribers (xray_email);
CREATE UNIQUE INDEX idx_subscribers_vless_uuid ON subscribers (vless_uuid);

DROP TABLE IF EXISTS node_clients;

INSERT INTO meta (k, v)
SELECT 'users_ver', '1'
WHERE EXISTS (SELECT 1 FROM subscribers WHERE status = 'active')
ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT);
