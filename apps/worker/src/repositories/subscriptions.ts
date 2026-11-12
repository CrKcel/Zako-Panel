export interface SubscriptionRow {
	id: string;
	subscriber_id: string;
	profile_id: string;
	name: string;
	token_hash: string;
	revoked_at: number | null;
	expires_at: number | null;
	created_at: number;
}
