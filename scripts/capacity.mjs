#!/usr/bin/env node
// Capacity harness for the read paths under the P0 shape.
//
// Seeds a throwaway local D1 (100 nodes, 100 user-node grants, 50 subscribers,
// 500 rules by default), starts an isolated `wrangler dev` against that state,
// and measures subscription generation plus the admin read paths over
// keep-alive connections.
//
// Wall time here includes the local Miniflare runtime, so the numbers are a
// regression signal rather than the deployed Worker's billed CPU. Production
// CPU and D1 row counts are read from Cloudflare observability as part of
// docs/deployment.md.

import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request, Agent } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEARTBEAT_SECONDS = 300;
const TRAFFIC_SECONDS = 900;
const DAILY_WRITE_BUDGET = 100_000; // Workers Free D1 row writes, docs/operations.md §1
const ADMIN_EMAIL = 'capacity@local.test';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const { values: options } = parseArgs({
	options: {
		nodes: { type: 'string', default: '100' },
		subscribers: { type: 'string', default: '50' },
		combos: { type: 'string', default: '100' },
		rules: { type: 'string', default: '500' },
		requests: { type: 'string', default: '200' },
		concurrency: { type: 'string', default: '10' },
		'p95-ms': { type: 'string' },
		'keep-state': { type: 'boolean', default: false },
		help: { type: 'boolean', short: 'h', default: false },
	},
});

if (options.help) {
	console.log(`usage: npm run capacity -- [options]

  --nodes <n>        nodes to seed (default 100)
  --combos <n>       subscriber-node grants, at least --nodes (default 100)
  --subscribers <n>  subscribers to seed (default 50)
  --rules <n>        profile rules (default 500)
  --requests <n>     requests per target (default 200)
  --concurrency <n>  parallel connections (default 10)
  --p95-ms <n>       fail when any target p95 exceeds this local wall time
  --keep-state       keep the seeded D1 directory for inspection

Requires apps/web/dist from \`npm run build\`.`);
	process.exit(0);
}

const nodeCount = positiveInt('nodes', options.nodes);
const subscriberCount = positiveInt('subscribers', options.subscribers);
const comboCount = positiveInt('combos', options.combos);
const ruleCount = positiveInt('rules', options.rules);
const requestCount = positiveInt('requests', options.requests);
const concurrency = positiveInt('concurrency', options.concurrency);
const p95Gate = options['p95-ms'] === undefined ? null : Number(options['p95-ms']);

if (comboCount > nodeCount * subscriberCount) {
	fail(`--combos ${comboCount} exceeds ${nodeCount} nodes x ${subscriberCount} subscribers`);
}
if (comboCount < nodeCount) {
	fail(`--combos ${comboCount} must be at least --nodes ${nodeCount} so the benchmark subscription renders every node`);
}

function positiveInt(name, raw) {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) fail(`--${name} must be a positive integer`);
	return value;
}

function fail(message) {
	console.error(`capacity: ${message}`);
	process.exit(1);
}

function ulid(now = Date.now()) {
	const random = randomBytes(10);
	let bits = 0;
	let value = 0;
	let encoded = '';
	for (const byte of random) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			encoded += CROCKFORD[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) encoded += CROCKFORD[(value << (5 - bits)) & 31];

	let timeText = '';
	let ms = now;
	for (let index = 0; index < 10; index += 1) {
		timeText = CROCKFORD[ms % 32] + timeText;
		ms = Math.floor(ms / 32);
	}
	return timeText + encoded;
}

function sqlText(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlValue(value) {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'number') return String(value);
	return sqlText(value);
}

/** One INSERT per 50 rows keeps each statement well below SQLite's limits. */
function insertMany(table, columns, rows) {
	const statements = [];
	for (let index = 0; index < rows.length; index += 50) {
		const group = rows.slice(index, index + 50);
		const values = group.map((row) => `(${row.map(sqlValue).join(', ')})`).join(',\n  ');
		statements.push(`INSERT INTO ${table} (${columns.join(', ')})\nVALUES ${values};`);
	}
	return statements;
}

// Calendar-month cycle in UTC, matching the Worker's `initialUsageCycle`.
function monthCycle(date) {
	const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
	const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
	return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000) };
}

/**
 * The Worker only accepts the local identity bypass when ENVIRONMENT=development
 * and DEV_ADMIN_EMAIL resolve to an enabled administrator. The harness seeds that
 * administrator itself so it works on a fresh checkout without .dev.vars.
 */
async function resolveAdminEmail() {
	try {
		const text = await readFile(join(REPO_ROOT, '.dev.vars'), 'utf8');
		for (const line of text.split('\n')) {
			const match = /^\s*DEV_ADMIN_EMAIL\s*=\s*(.*)\s*$/.exec(line);
			if (match && match[1]) return match[1].trim().replace(/^["']|["']$/g, '');
		}
	} catch {
		// No .dev.vars is the normal case for a fresh checkout.
	}
	return ADMIN_EMAIL;
}

function buildSeedSql(adminEmail) {
	const now = Math.floor(Date.now() / 1000);
	const cycle = monthCycle(new Date(now * 1000));

	const subscribers = Array.from({ length: subscriberCount }, (_, index) => ({
		id: ulid(),
		name: `capacity-user-${String(index + 1).padStart(3, '0')}`,
	}));
	const nodes = Array.from({ length: nodeCount }, (_, index) => ({
		id: ulid(),
		name: `capacity-node-${String(index + 1).padStart(3, '0')}`,
		secret: randomBytes(32).toString('base64url'),
	}));

	// The benchmark subscription belongs to the first subscriber and grants every
	// node, so the rendered document has one proxy per node. Remaining grants spread
	// across the other subscribers to reach the documented combination count.
	const pairs = [];
	const seen = new Set();
	const grant = (node, subscriber) => {
		const key = `${subscriber.id}:${node.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		pairs.push({ node, subscriber });
	};
	for (const node of nodes) grant(node, subscribers[0]);
	for (let index = 0; pairs.length < comboCount && index < nodeCount * subscriberCount; index += 1) {
		grant(nodes[index % nodeCount], subscribers[index % subscriberCount]);
	}
	if (pairs.length < comboCount) fail('could not build unique subscriber-node grants');

	const rules = Array.from({ length: ruleCount }, (_, index) =>
		index === ruleCount - 1 ? 'MATCH,PROXY' : `DOMAIN-SUFFIX,capacity-${index + 1}.example.com,PROXY`,
	);

	const statements = [
		...insertMany(
			'subscribers',
			[
				'id',
				'name',
				'email',
				'status',
				'traffic_limit_bytes',
				'expires_at',
				'usage_cycle_start',
				'usage_cycle_end',
				'created_at',
				'updated_at',
			],
			subscribers.map((subscriber) => [subscriber.id, subscriber.name, null, 'active', null, null, cycle.start, cycle.end, now, now]),
		),
		...insertMany(
			'subscriber_usage',
			['subscriber_id', 'cycle_start', 'uplink_bytes', 'downlink_bytes', 'updated_at'],
			subscribers.map((subscriber) => [subscriber.id, cycle.start, 0, 0, now]),
		),
		...insertMany(
			'nodes',
			[
				'id',
				'name',
				'enabled',
				'agent_token_hash',
				'heartbeat_interval_seconds',
				'last_seen_at',
				'xray_healthy',
				'stats_healthy',
				'agent_version',
				'xray_version',
				'sys_json',
				'desired_config_version',
				'applied_config_version',
				'last_config_error',
				'last_config_at',
				'created_at',
				'updated_at',
			],
			nodes.map((node) => [
				node.id,
				node.name,
				1,
				createHash('sha256').update(node.secret).digest('hex'),
				HEARTBEAT_SECONDS,
				now,
				1,
				1,
				'0.1.0',
				'25.10.1',
				JSON.stringify({ cpu: 0.1, mem: 0.4, load: 0.2, uptime: 86400 }),
				0,
				0,
				null,
				null,
				now,
				now,
			]),
		),
		...insertMany(
			'endpoints',
			['id', 'node_id', 'name', 'protocol', 'host', 'port', 'params_json', 'enabled', 'created_at', 'updated_at'],
			nodes.map((node, index) => [
				ulid(),
				node.id,
				'primary',
				'vless-reality',
				`192.0.2.${(index % 254) + 1}`,
				443,
				JSON.stringify({
					sni: 'www.example.com',
					public_key: randomBytes(32).toString('base64url'),
					short_id: randomBytes(4).toString('hex'),
					fingerprint: 'chrome',
					flow: 'xtls-rprx-vision',
					network: 'tcp',
				}),
				1,
				now,
				now,
			]),
		),
		...insertMany(
			'node_clients',
			['id', 'node_id', 'subscriber_id', 'xray_email', 'vless_uuid', 'enabled', 'created_at', 'updated_at'],
			pairs.map(({ node, subscriber }) => [ulid(), node.id, subscriber.id, `u_${ulid()}`, randomUUID(), 1, now, now]),
		),
	];

	// An empty proxy-group list makes the renderer emit its default PROXY/AUTO
	// groups, so the measured document is the shape a fresh profile produces.
	const profileId = ulid();
	statements.push(
		...insertMany(
			'subscription_profiles',
			[
				'id',
				'name',
				'description',
				'node_selection',
				'online_only',
				'clash_base_json',
				'proxy_groups_json',
				'rules_json',
				'revision',
				'created_at',
				'updated_at',
			],
			[
				[
					profileId,
					'capacity-profile',
					null,
					'all',
					1,
					JSON.stringify({ 'mixed-port': 7890, 'allow-lan': false, mode: 'rule', 'log-level': 'info' }),
					'[]',
					JSON.stringify(rules),
					1,
					now,
					now,
				],
			],
		),
	);

	// Populate the last 24 hourly buckets so summary reads scan realistic ranges
	// instead of empty tables.
	const hourStarts = Array.from({ length: 24 }, (_, index) => Math.floor(now / 3600) * 3600 - index * 3600);
	statements.push(
		...insertMany(
			'site_traffic_hourly',
			['bucket_start', 'uplink_bytes', 'downlink_bytes', 'updated_at'],
			hourStarts.map((bucket) => [bucket, 1024 * comboCount, 4096 * comboCount, now]),
		),
		...insertMany(
			'node_traffic_hourly',
			['node_id', 'bucket_start', 'uplink_bytes', 'downlink_bytes', 'updated_at'],
			hourStarts.flatMap((bucket) => nodes.map((node) => [node.id, bucket, 1024, 4096, now])),
		),
		...insertMany(
			'user_traffic_hourly',
			['subscriber_id', 'node_id', 'bucket_start', 'uplink_bytes', 'downlink_bytes', 'updated_at'],
			hourStarts.flatMap((bucket) => pairs.map(({ node, subscriber }) => [subscriber.id, node.id, bucket, 1024, 4096, now])),
		),
	);

	const token = randomBytes(32).toString('base64url');
	statements.push(
		...insertMany(
			'subscriptions',
			['id', 'subscriber_id', 'profile_id', 'name', 'token', 'revoked_at', 'expires_at', 'created_at'],
			[[ulid(), subscribers[0].id, profileId, 'capacity-subscription', token, null, null, now]],
		),
		...insertMany(
			'meta',
			['k', 'v'],
			[
				['users_ver', '0'],
				['default_subscriber_id', subscribers[0].id],
			],
		),
	);

	return { sql: `${statements.join('\n')}\n`, token, grantCount: pairs.length };
}

function runCommand(args) {
	return new Promise((resolve, reject) => {
		const child = spawn('npx', args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('error', reject);
		child.on('close', (code) => resolve({ code, stdout, stderr }));
	});
}

async function freePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

async function waitForServer(baseUrl, dev) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (dev.exitCode !== null) {
			throw new Error(`wrangler dev exited early (code ${dev.exitCode})\n${dev.stderr.slice(-2000)}`);
		}
		try {
			const response = await fetch(`${baseUrl}/api/v1/admin/nodes?limit=1`, { signal: AbortSignal.timeout(2000) });
			if (response.ok) return;
		} catch {
			// The listener is not up yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	throw new Error(`wrangler dev did not become ready\n${dev.stderr.slice(-2000)}`);
}

function startDev(port, stateDir, adminEmail) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			'npx',
			[
				'wrangler',
				'dev',
				'--local',
				'--port',
				String(port),
				'--persist-to',
				stateDir,
				'--var',
				'ENVIRONMENT:development',
				'--var',
				`DEV_ADMIN_EMAIL:${adminEmail}`,
				'--show-interactive-dev-session=false',
			],
			{ cwd: REPO_ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
		);
		const handle = { child, exitCode: null, stdout: '', stderr: '' };
		child.stdout.on('data', (chunk) => (handle.stdout += chunk));
		child.stderr.on('data', (chunk) => (handle.stderr += chunk));
		child.on('error', reject);
		child.on('exit', (code) => {
			handle.exitCode = code;
		});
		// Give the process a beat to fail fast on bad flags before readiness polling.
		setTimeout(() => resolve(handle), 100);
	});
}

async function stopDev(handle) {
	if (!handle || handle.exitCode !== null) return;
	try {
		process.kill(-handle.child.pid, 'SIGTERM');
	} catch {
		handle.child.kill('SIGTERM');
	}
	await new Promise((resolve) => setTimeout(resolve, 1000));
	if (handle.exitCode === null) {
		try {
			process.kill(-handle.child.pid, 'SIGKILL');
		} catch {
			handle.child.kill('SIGKILL');
		}
	}
}

function get(port, path, agent) {
	return new Promise((resolve, reject) => {
		const req = request({ host: '127.0.0.1', port, path, method: 'GET', agent }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => (body += chunk));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on('error', reject);
		req.end();
	});
}

function percentile(sorted, ratio) {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1);
	return sorted[index];
}

async function measure(port, label, path, concurrencyLimit, validate) {
	const agent = new Agent({ keepAlive: true, maxSockets: concurrencyLimit });
	const latencies = [];
	const statuses = new Map();
	let bytes = 0;
	let invalid = 0;
	let lastError = null;
	let next = 0;

	const worker = async () => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= requestCount) return;
			const started = process.hrtime.bigint();
			try {
				const response = await get(port, path, agent);
				const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
				latencies.push(elapsed);
				statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
				bytes += Buffer.byteLength(response.body);
				if (response.status !== 200) {
					invalid += 1;
					lastError = `status ${response.status}`;
					continue;
				}
				const problem = validate(response.body);
				if (problem) {
					invalid += 1;
					lastError = problem;
				}
			} catch (error) {
				invalid += 1;
				lastError = error instanceof Error ? error.message : String(error);
			}
		}
	};

	const startedAt = process.hrtime.bigint();
	await Promise.all(Array.from({ length: Math.min(concurrencyLimit, requestCount) }, worker));
	const totalSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
	agent.destroy();

	latencies.sort((a, b) => a - b);
	return {
		label,
		path,
		requests: latencies.length,
		invalid,
		lastError,
		statuses,
		p50: percentile(latencies, 0.5),
		p95: percentile(latencies, 0.95),
		p99: percentile(latencies, 0.99),
		max: latencies.at(-1) ?? 0,
		rps: latencies.length / totalSeconds,
		avgBytes: latencies.length === 0 ? 0 : bytes / latencies.length,
	};
}

function countClashProxies(document) {
	const lines = document.split('\n');
	const start = lines.findIndex((line) => line === 'proxies:');
	const end = lines.findIndex((line) => line === 'proxy-groups:');
	if (start < 0 || end < 0) return -1;
	return lines.slice(start + 1, end).filter((line) => line.startsWith('  - name: ')).length;
}

function countClashRules(document) {
	const lines = document.split('\n');
	const start = lines.findIndex((line) => line === 'rules:');
	if (start < 0) return -1;
	return lines.slice(start + 1).filter((line) => line.startsWith('  - ')).length;
}

function formatTable(rows) {
	const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
	return rows.map((row) => row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ')).join('\n');
}

function writeBudget(grantCount) {
	const heartbeatRuns = Math.floor(86_400 / HEARTBEAT_SECONDS);
	const trafficRuns = Math.floor(86_400 / TRAFFIC_SECONDS);
	const rows = [
		['心跳行', nodeCount * heartbeatRuns],
		['报表行', nodeCount * trafficRuns],
		['节点小时桶', nodeCount * trafficRuns],
		['站点小时桶', trafficRuns],
		['用户小时桶', grantCount * trafficRuns],
		['用户周期汇总', subscriberCount * trafficRuns],
	];
	const total = rows.reduce((sum, [, value]) => sum + value, 0);
	return { rows, total };
}

async function main() {
	try {
		await access(join(REPO_ROOT, 'apps/web/dist/index.html'));
	} catch {
		fail('apps/web/dist is missing; run `npm run build` first');
	}

	const stateDir = await mkdtemp(join(tmpdir(), 'zako-capacity-'));
	const adminEmail = await resolveAdminEmail();
	const seed = buildSeedSql(adminEmail);
	const seedPath = join(stateDir, 'seed.sql');
	let dev = null;

	const cleanup = async () => {
		await stopDev(dev);
		if (!options['keep-state']) await rm(stateDir, { recursive: true, force: true });
	};
	process.on('SIGINT', () => {
		void cleanup().then(() => process.exit(130));
	});

	try {
		console.log(`capacity: state ${stateDir}`);

		const migrate = await runCommand(['wrangler', 'd1', 'migrations', 'apply', 'zako-panel', '--local', '--persist-to', stateDir]);
		if (migrate.code !== 0) throw new Error(`migrations failed\n${migrate.stderr || migrate.stdout}`);

		await writeFile(seedPath, seed.sql, { mode: 0o600 });
		const seeded = await runCommand(['wrangler', 'd1', 'execute', 'zako-panel', '--local', '--persist-to', stateDir, '--file', seedPath]);
		if (seeded.code !== 0) throw new Error(`seed failed\n${seeded.stderr || seeded.stdout}`);

		const countQuery =
			'SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM node_clients) AS clients, ' +
			'(SELECT COUNT(*) FROM subscribers) AS subscribers, (SELECT COUNT(*) FROM subscription_profiles) AS profiles, ' +
			'(SELECT json_array_length(rules_json) FROM subscription_profiles LIMIT 1) AS rules';
		const counted = await runCommand([
			'wrangler',
			'd1',
			'execute',
			'zako-panel',
			'--local',
			'--persist-to',
			stateDir,
			'--json',
			'--command',
			countQuery,
		]);
		if (counted.code !== 0) throw new Error(`row count failed\n${counted.stderr || counted.stdout}`);
		const counts = JSON.parse(counted.stdout.trim())[0].results[0];

		const port = await freePort();
		const baseUrl = `http://127.0.0.1:${port}`;
		dev = await startDev(port, stateDir, adminEmail);
		await waitForServer(baseUrl, dev);

		// The admin list is cursor-paged; verify the seeded row count through the
		// API once so a mis-seeded profile cannot silently benchmark an empty set.
		const listing = await fetch(`${baseUrl}/api/v1/admin/nodes?limit=200`);
		const listed = (await listing.json()).data.items.length;
		if (listed !== nodeCount) throw new Error(`admin list returned ${listed} nodes, expected ${nodeCount}`);

		const expectedProxies = nodeCount;
		const now = Math.floor(Date.now() / 1000);
		const targets = [
			{
				label: 'clash.yaml',
				path: `/sub/${seed.token}/clash.yaml`,
				validate: (body) => {
					const proxies = countClashProxies(body);
					if (proxies !== expectedProxies) return `rendered ${proxies} proxies, expected ${expectedProxies}`;
					const rules = countClashRules(body);
					if (rules !== ruleCount) return `rendered ${rules} rules, expected ${ruleCount}`;
					return null;
				},
			},
			{
				label: 'uri base64',
				path: `/sub/${seed.token}/uri?encoding=base64`,
				validate: (body) => {
					const decoded = Buffer.from(body, 'base64').toString('utf8');
					const uris = decoded.split('\n').filter((line) => line.startsWith('vless://')).length;
					return uris === expectedProxies ? null : `rendered ${uris} URIs, expected ${expectedProxies}`;
				},
			},
			{
				label: 'traffic summary',
				path: `/api/v1/admin/traffic/summary?from=${now - 86_400}&to=${now}&groupBy=site`,
				validate: (body) => (Array.isArray(JSON.parse(body).data.items) ? null : 'missing data.items'),
			},
			{
				label: 'nodes list',
				path: '/api/v1/admin/nodes?limit=200',
				validate: (body) => {
					const items = JSON.parse(body).data.items;
					return items.length === nodeCount ? null : `list returned ${items.length} nodes, expected ${nodeCount}`;
				},
			},
			{
				label: 'subscribers list',
				path: '/api/v1/admin/subscribers?limit=200',
				validate: (body) => {
					const items = JSON.parse(body).data.items;
					return items.length === subscriberCount ? null : `list returned ${items.length} subscribers, expected ${subscriberCount}`;
				},
			},
		];

		console.log(
			`capacity: ${nodeCount} nodes / ${comboCount} grants / ${subscriberCount} subscribers / ${ruleCount} rules, ` +
				`${requestCount} requests per target at concurrency ${concurrency}`,
		);
		console.log(
			formatTable([
				['rows', 'nodes', 'grants', 'subscribers', 'profiles', 'rules'],
				['seeded', counts.nodes, counts.clients, counts.subscribers, counts.profiles, counts.rules],
			]),
		);

		const results = [];
		for (const target of targets) {
			results.push(await measure(port, target.label, target.path, concurrency, target.validate));
		}

		console.log('');
		console.log(
			formatTable([
				['target', 'ok', 'bad', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'req/s', 'KB/resp'],
				...results.map((result) => [
					result.label,
					result.requests - result.invalid,
					result.invalid,
					result.p50.toFixed(1),
					result.p95.toFixed(1),
					result.p99.toFixed(1),
					result.max.toFixed(1),
					result.rps.toFixed(1),
					(result.avgBytes / 1024).toFixed(1),
				]),
			]),
		);

		for (const result of results) {
			if (result.invalid > 0) {
				console.log(`capacity: ${result.path} had ${result.invalid} invalid responses (last: ${result.lastError})`);
			}
		}

		const budget = writeBudget(seed.grantCount);
		console.log('');
		console.log('capacity: projected daily D1 writes for this shape (docs/operations.md §3)');
		for (const [label, value] of budget.rows) {
			console.log(`  ${label.padEnd(8)} ${String(value).padStart(7)}`);
		}
		console.log(
			`  ${'total'.padEnd(8)} ${String(budget.total).padStart(7)}  ` +
				`(${((budget.total / DAILY_WRITE_BUDGET) * 100).toFixed(1)}% of ${DAILY_WRITE_BUDGET})`,
		);

		let failed = results.some((result) => result.invalid > 0);
		if (p95Gate !== null) {
			for (const result of results) {
				if (result.p95 > p95Gate) {
					console.log(`capacity: ${result.path} p95 ${result.p95.toFixed(1)} ms exceeds --p95-ms ${p95Gate}`);
					failed = true;
				}
			}
		}

		console.log('');
		console.log('capacity: local wall time includes the Miniflare runtime; confirm deployed Worker CPU');
		console.log('capacity: and D1 row counts from Cloudflare observability before launch.');

		process.exitCode = failed ? 1 : 0;
		if (!failed) console.log('capacity: ok');
	} finally {
		await cleanup();
	}
}

await main().catch((error) => {
	console.error(`capacity: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
