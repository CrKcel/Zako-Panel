import { env, SELF } from 'cloudflare:test';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { previewProfile } from '../src/services/distribution';
import { base64UrlEncode } from '../src/lib/base64';
import {
	DEFAULT_HYSTERIA2_PARAMS,
	DEFAULT_PARAMS,
	DEFAULT_VMESS_PARAMS,
	seedEndpoint,
	seedNode,
	seedNodeClient,
	seedProfile,
	seedSubscriber,
	seedSubscription,
	testToken,
} from './helpers';

interface ClashDocument {
	proxies: Record<string, unknown>[];
}

async function fetchClash(token: string): Promise<Response> {
	return SELF.fetch(`https://panel.test/sub/${token}/clash.yaml`);
}

async function fetchUriLines(token: string): Promise<string[]> {
	const response = await SELF.fetch(`https://panel.test/sub/${token}/uri?encoding=plain`);
	expect(response.status).toBe(200);
	return (await response.text()).split('\n');
}

/** Endpoints of one node share a creation second, so their render order is not fixed. */
function proxyByName(document: ClashDocument, name: string): Record<string, unknown> {
	const proxy = document.proxies.find((candidate) => candidate.name === name);
	if (!proxy) throw new Error(`missing proxy ${name}`);
	return proxy;
}

function uriWithScheme(lines: string[], scheme: string): string {
	const uri = lines.find((line) => line.startsWith(scheme));
	if (!uri) throw new Error(`missing ${scheme} URI`);
	return uri;
}

function decodeVmess(uri: string): Record<string, unknown> {
	return JSON.parse(atob(uri.slice('vmess://'.length))) as Record<string, unknown>;
}

describe('multi-protocol subscriptions', () => {
	it('renders a Clash proxy and a URI for every endpoint protocol', async () => {
		const nodeId = await seedNode({ name: 'Mixed' });
		await seedEndpoint(nodeId, { name: 'vmess', protocol: 'vmess' });
		await seedEndpoint(nodeId, { name: 'trojan', protocol: 'trojan' });
		await seedEndpoint(nodeId, { name: 'ss', protocol: 'shadowsocks' });
		await seedEndpoint(nodeId, { name: 'hy2', protocol: 'hysteria2' });
		const subscriberId = await seedSubscriber();
		const client = await seedNodeClient(nodeId, subscriberId);
		const profileId = await seedProfile();
		const token = testToken('mixed');
		await seedSubscription({ token, subscriberId, profileId });

		const document = parse(await (await fetchClash(token)).text()) as ClashDocument;
		expect(document.proxies.map((proxy) => proxy.name).sort()).toEqual(['Mixed-hy2', 'Mixed-ss', 'Mixed-trojan', 'Mixed-vmess']);
		expect(proxyByName(document, 'Mixed-vmess')).toMatchObject({
			type: 'vmess',
			server: '203.0.113.10',
			port: 443,
			uuid: client.uuid,
			alterId: 0,
			cipher: 'auto',
			tls: true,
			servername: 'www.example.com',
			udp: true,
			network: 'ws',
			'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.com' } },
		});
		expect(proxyByName(document, 'Mixed-trojan')).toMatchObject({
			type: 'trojan',
			password: client.uuid,
			sni: 'www.example.com',
			udp: true,
			network: 'tcp',
		});
		expect(proxyByName(document, 'Mixed-ss')).toEqual({
			name: 'Mixed-ss',
			type: 'ss',
			server: '203.0.113.10',
			port: 443,
			cipher: 'aes-256-gcm',
			password: client.uuid,
			udp: true,
		});
		expect(proxyByName(document, 'Mixed-hy2')).toMatchObject({
			type: 'hysteria2',
			password: client.uuid,
			sni: 'www.example.com',
			'skip-cert-verify': false,
		});

		const uris = await fetchUriLines(token);
		expect(uris).toHaveLength(4);
		expect(decodeVmess(uriWithScheme(uris, 'vmess://'))).toMatchObject({
			v: '2',
			ps: 'Mixed-vmess',
			add: '203.0.113.10',
			port: '443',
			id: client.uuid,
			net: 'ws',
			path: '/ws',
			host: 'cdn.example.com',
			tls: 'tls',
			sni: 'www.example.com',
		});
		expect(uriWithScheme(uris, 'trojan://')).toBe(
			`trojan://${client.uuid}@203.0.113.10:443?security=tls&sni=www.example.com&type=tcp#Mixed-trojan`,
		);
		expect(uriWithScheme(uris, 'ss://')).toBe(
			`ss://${base64UrlEncode(new TextEncoder().encode(`aes-256-gcm:${client.uuid}`))}@203.0.113.10:443#Mixed-ss`,
		);
		expect(uriWithScheme(uris, 'hysteria2://')).toBe(`hysteria2://${client.uuid}@203.0.113.10:443/?sni=www.example.com#Mixed-hy2`);
	});

	it('renders transport and obfuscation parameters that are set on the endpoint', async () => {
		const nodeId = await seedNode({ name: 'Tuned' });
		await seedEndpoint(nodeId, {
			name: 'grpc',
			protocol: 'vmess',
			params: { ...DEFAULT_VMESS_PARAMS, security: 'none', network: 'grpc', path: 'svc', host: '' },
		});
		await seedEndpoint(nodeId, {
			name: 'ws',
			protocol: 'trojan',
			params: { sni: 'trojan.example.com', network: 'ws', path: '/tr', host: 'front.example.com' },
		});
		await seedEndpoint(nodeId, {
			name: 'obfs',
			protocol: 'hysteria2',
			params: { ...DEFAULT_HYSTERIA2_PARAMS, obfs: 'salamander', obfs_password: 'obfs-secret' },
		});
		const subscriberId = await seedSubscriber();
		const client = await seedNodeClient(nodeId, subscriberId);
		const profileId = await seedProfile();
		const token = testToken('tuned');
		await seedSubscription({ token, subscriberId, profileId });

		const document = parse(await (await fetchClash(token)).text()) as ClashDocument;
		const grpc = proxyByName(document, 'Tuned-grpc');
		expect(grpc).toMatchObject({ tls: false, network: 'grpc', 'grpc-opts': { 'grpc-service-name': 'svc' } });
		expect(grpc).not.toHaveProperty('servername');
		expect(proxyByName(document, 'Tuned-ws')).toMatchObject({
			type: 'trojan',
			sni: 'trojan.example.com',
			network: 'ws',
			'ws-opts': { path: '/tr', headers: { Host: 'front.example.com' } },
		});
		expect(proxyByName(document, 'Tuned-obfs')).toMatchObject({ obfs: 'salamander', 'obfs-password': 'obfs-secret' });

		const uris = await fetchUriLines(token);
		expect(decodeVmess(uriWithScheme(uris, 'vmess://'))).toMatchObject({ net: 'grpc', path: 'svc', host: '', tls: '', sni: '' });
		expect(uriWithScheme(uris, 'trojan://')).toBe(
			`trojan://${client.uuid}@203.0.113.10:443?security=tls&sni=trojan.example.com&type=ws&path=%2Ftr&host=front.example.com#Tuned-ws`,
		);
		expect(uriWithScheme(uris, 'hysteria2://')).toBe(
			`hysteria2://${client.uuid}@203.0.113.10:443/?sni=www.example.com&obfs=salamander&obfs-password=obfs-secret#Tuned-obfs`,
		);
	});

	it('skips endpoints whose stored params no longer validate', async () => {
		const nodeId = await seedNode({ name: 'Stale' });
		await seedEndpoint(nodeId, { name: 'ok', protocol: 'vless-reality' });
		// TLS without a SNI fails the vmess schema, the same way an older stored row
		// would after a schema change.
		await seedEndpoint(nodeId, {
			name: 'broken',
			protocol: 'vmess',
			params: { ...DEFAULT_VMESS_PARAMS, sni: '' },
		});
		const subscriberId = await seedSubscriber();
		await seedNodeClient(nodeId, subscriberId);
		const profileId = await seedProfile();
		const token = testToken('stale');
		await seedSubscription({ token, subscriberId, profileId });

		const document = parse(await (await fetchClash(token)).text()) as ClashDocument;
		expect(document.proxies.map((proxy) => proxy.name)).toEqual(['Stale-ok']);
		expect(await fetchUriLines(token)).toHaveLength(1);
	});

	it('keeps the real credential out of profile previews for every protocol', async () => {
		const nodeId = await seedNode({ name: 'Preview' });
		await seedEndpoint(nodeId, { name: 'vmess', protocol: 'vmess' });
		await seedEndpoint(nodeId, { name: 'ss', protocol: 'shadowsocks' });
		const subscriberId = await seedSubscriber();
		const client = await seedNodeClient(nodeId, subscriberId);
		const profileId = await seedProfile();
		await seedSubscription({ token: testToken('preview'), subscriberId, profileId });

		const preview = await previewProfile(env.DB, profileId, subscriberId);
		expect(preview.proxies).toHaveLength(2);
		expect(preview.document).not.toContain(client.uuid);
		expect(preview.document).toContain('00000000-0000-0000-0000-000000000000');
		expect(preview.document).toContain('type: vmess');
		expect(preview.document).toContain('type: ss');
	});

	it('treats an endpoint with an unknown stored protocol as unusable', async () => {
		const nodeId = await seedNode({ name: 'Unknown' });
		await seedEndpoint(nodeId, { name: 'unknown', protocol: 'vmess' });
		await env.DB.prepare("UPDATE endpoints SET protocol = 'vless-tls' WHERE node_id = ?").bind(nodeId).run();
		const subscriberId = await seedSubscriber();
		await seedNodeClient(nodeId, subscriberId);
		const profileId = await seedProfile();
		const token = testToken('unknown');
		await seedSubscription({ token, subscriberId, profileId });

		expect((await fetchClash(token)).status).toBe(503);
		const preview = await previewProfile(env.DB, profileId, subscriberId);
		expect(preview.proxies).toEqual([]);
		expect(preview.skipped).toEqual([expect.objectContaining({ node_id: nodeId, reason: 'no_endpoint' })]);
	});

	it('keeps the vless-reality output unchanged for a single-endpoint node', async () => {
		const nodeId = await seedNode({ name: 'Legacy' });
		await seedEndpoint(nodeId, { name: 'primary', params: { ...DEFAULT_PARAMS, short_id: '' } });
		const subscriberId = await seedSubscriber();
		const client = await seedNodeClient(nodeId, subscriberId);
		const profileId = await seedProfile();
		const token = testToken('legacy');
		await seedSubscription({ token, subscriberId, profileId });

		const document = parse(await (await fetchClash(token)).text()) as ClashDocument;
		expect(proxyByName(document, 'Legacy')).toMatchObject({
			type: 'vless',
			uuid: client.uuid,
			flow: 'xtls-rprx-vision',
			'reality-opts': { 'public-key': DEFAULT_PARAMS.public_key },
		});
		expect((await fetchUriLines(token)).length).toBe(1);
	});
});
