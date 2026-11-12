export interface NodeConfigRow {
	node_id: string;
	version: number;
	definition_json: string;
	definition_sha256: string;
	created_by: string | null;
	created_at: number;
	applied_at: number | null;
	last_error: string | null;
}
