export interface SubscriptionLink {
	label: string;
	url: string;
}

/** Links handed out once after a subscription is created or rotated. */
export function subscriptionLinks(token: string, origin = window.location.origin): SubscriptionLink[] {
	if (token === '') return [];
	const base = `${origin}/sub/${token}`;
	return [
		{ label: 'Clash', url: `${base}/clash.yaml` },
		{ label: 'URI Base64', url: `${base}/uri?encoding=base64` },
		{ label: 'URI Plain', url: `${base}/uri?encoding=plain` },
	];
}
