export interface EndpointRow {
	id: string;
	node_id: string;
	name: string;
	protocol: string;
	host: string;
	port: number;
	params_json: string;
	enabled: number;
	created_at: number;
	updated_at: number;
}
