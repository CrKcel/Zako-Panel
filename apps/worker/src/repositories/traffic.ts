export interface TrafficReportRow {
	node_id: string;
	report_id: string;
	payload_hash: string;
	period_start: number;
	period_end: number;
	item_count: number;
	has_counter_gap: number;
	received_at: number;
}

export interface NodeTrafficHourlyRow {
	node_id: string;
	bucket_start: number;
	uplink_bytes: number;
	downlink_bytes: number;
	updated_at: number;
}

export interface SiteTrafficHourlyRow {
	bucket_start: number;
	uplink_bytes: number;
	downlink_bytes: number;
	updated_at: number;
}

export interface UserTrafficHourlyRow {
	subscriber_id: string;
	node_id: string;
	bucket_start: number;
	uplink_bytes: number;
	downlink_bytes: number;
	updated_at: number;
}
