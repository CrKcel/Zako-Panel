export interface SubscriberRow {
	id: string;
	name: string;
	email: string | null;
	status: 'active' | 'limited' | 'expired' | 'disabled';
	traffic_limit_bytes: number | null;
	expires_at: number | null;
	usage_cycle_start: number;
	usage_cycle_end: number;
	created_at: number;
	updated_at: number;
}

export interface NodeClientRow {
	id: string;
	node_id: string;
	subscriber_id: string;
	xray_email: string;
	vless_uuid: string;
	enabled: number;
	created_at: number;
	updated_at: number;
}

export interface SubscriberUsageRow {
	subscriber_id: string;
	cycle_start: number;
	uplink_bytes: number;
	downlink_bytes: number;
	updated_at: number;
}
