export interface AuditEventRow {
	id: string;
	actor_email: string | null;
	action: string;
	target_type: string | null;
	target_id: string | null;
	detail_json: string | null;
	created_at: number;
}

export interface NewAuditEvent {
	id: string;
	actor_email: string | null;
	action: string;
	target_type: string | null;
	target_id: string | null;
	detail_json: string | null;
	created_at: number;
}

export function insertAuditEventStatement(db: D1Database, event: NewAuditEvent): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO audit_events (id, actor_email, action, target_type, target_id, detail_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(event.id, event.actor_email, event.action, event.target_type, event.target_id, event.detail_json, event.created_at);
}

export async function insertAuditEvent(db: D1Database, event: NewAuditEvent): Promise<void> {
	await insertAuditEventStatement(db, event).run();
}

export async function deleteOldAuditEvents(db: D1Database, cutoff: number, batchSize: number): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM audit_events
			 WHERE id IN (SELECT id FROM audit_events WHERE created_at < ? LIMIT ?)`,
		)
		.bind(cutoff, batchSize)
		.run();
	return result.meta.changes;
}
