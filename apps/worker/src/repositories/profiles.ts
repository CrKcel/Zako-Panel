export interface ProfileRow {
	id: string;
	name: string;
	description: string | null;
	node_selection: 'all' | 'selected';
	online_only: number;
	clash_base_json: string;
	proxy_groups_json: string;
	rules_json: string;
	revision: number;
	created_at: number;
	updated_at: number;
}

export interface ProfileNodeRow {
	profile_id: string;
	node_id: string;
}
