export interface AuditEventRow {
	id: string;
	actor_email: string | null;
	action: string;
	target_type: string | null;
	target_id: string | null;
	detail_json: string | null;
	created_at: number;
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
