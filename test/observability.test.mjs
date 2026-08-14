import assert from 'node:assert/strict';
import test from 'node:test';
import {
	ALERT_HISTORY_QUERY,
	LOKI_QUERIES,
	createObservabilityHandlers,
	getObservabilityConfig,
	parseAlertHistory,
	parseLokiResults,
	parseSystemResults,
	parseTailscaleDevices,
	queryAlertHistory,
	queryReverseProxyInformation,
	querySystemInformation,
	queryTailscaleStatus,
} from '../proxy/observability.mjs';

const matrix = (values) => ({
	status: 'success',
	data: {
		resultType: 'matrix',
		result: values.map(({ labels, value, points }) => ({
			metric: labels,
			values: points ?? [[1_700_000_000, String(value)]],
		})),
	},
});

const GIGABYTE = 1024 ** 3;

test('observability URLs are optional and normalized', () => {
	assert.deepEqual(getObservabilityConfig({}), {
		prometheusUrl: undefined,
		lokiUrl: undefined,
		tailscaleApiUrl: 'https://api.tailscale.com',
		tailscaleToken: undefined,
		tailscaleTailnet: '-',
	});
	assert.deepEqual(getObservabilityConfig({
		WS4KP_PROMETHEUS_URL: 'http://prometheus:9090/',
		WS4KP_LOKI_URL: 'https://loki.example.test/',
		WS4KP_TAILSCALE_API_URL: 'https://tailscale.example.test/',
		WS4KP_TAILSCALE_API_TOKEN: ' token ',
		WS4KP_TAILSCALE_TAILNET: 'example.com',
	}), {
		prometheusUrl: 'http://prometheus:9090',
		lokiUrl: 'https://loki.example.test',
		tailscaleApiUrl: 'https://tailscale.example.test',
		tailscaleToken: 'token',
		tailscaleTailnet: 'example.com',
	});
	assert.throws(() => getObservabilityConfig({ WS4KP_LOKI_URL: 'file:///logs' }), /HTTP or HTTPS/);
});

test('Prometheus alert matrices become firing episodes over the requested range', () => {
	const response = matrix([
		{
			labels: { alertname: 'DiskFull', severity: 'critical', instance: 'node-a' },
			points: [[100, '1'], [160, '1'], [400, '1'], [460, '1']],
		},
		{
			labels: { alertname: 'HighLoad', job: 'nodes' },
			points: [[100, '1'], [160, '1']],
		},
	]);

	assert.deepEqual(parseAlertHistory(response, {
		start: 0, end: 460, step: 60,
	}), [
		{
			name: 'DiskFull',
			severity: 'critical',
			source: 'node-a',
			currentlyFiring: true,
			startedAt: 100,
			lastFiredAt: 460,
			durationSeconds: 180,
			episodes: [
				{ startedAt: 100, endedAt: 220, durationSeconds: 120 },
				{ startedAt: 400, endedAt: null, durationSeconds: 60 },
			],
		},
		{
			name: 'HighLoad',
			severity: 'unknown',
			source: 'nodes',
			currentlyFiring: false,
			startedAt: 100,
			lastFiredAt: 160,
			durationSeconds: 120,
			episodes: [{ startedAt: 100, endedAt: 220, durationSeconds: 120 }],
		},
	]);
});

test('Tailscale devices use assigned names and expose console-style roles', () => {
	const now = Date.parse('2026-08-13T12:00:00Z');
	assert.deepEqual(parseTailscaleDevices({ devices: [
		{
			name: 'home-router.tailnet-example.ts.net.',
			hostname: 'zeta',
			connectedToControl: false,
			lastSeen: '2026-08-13T11:59:59Z',
			clientVersion: '1.86.2',
			advertisedRoutes: ['192.168.1.0/24', '0.0.0.0/0', '::/0'],
		},
		{
			name: 'workstation.tailnet-example.ts.net',
			hostname: 'alpha',
			lastSeen: '2026-08-13T11:58:00Z',
			clientVersion: '1.84.0',
			advertisedRoutes: [],
		},
		{ name: 'phone.tailnet-example.ts.net', hostname: 'beta', lastSeen: '2026-08-12T12:00:00Z' },
	] }, now), [
		{ name: 'home-router', online: false, version: '1.86.2', roles: ['Subnet Router', 'Exit Node'] },
		{ name: 'phone', online: false, version: '', roles: [] },
		{ name: 'workstation', online: true, version: '1.84.0', roles: [] },
	]);
});

test('Prometheus matrices are joined and sorted by instance', () => {
	const results = {
		cpu: matrix([
			{ labels: { instance: 'node-b:9100' }, value: 25 },
			{ labels: { instance: 'node-a:9100' }, value: 10.5 },
		]),
		memory: matrix([
			{ labels: { instance: 'node-a:9100' }, value: 60 },
			{ labels: { instance: 'node-b:9100' }, value: 70 },
		]),
		memoryUsedGb: matrix([
			{ labels: { instance: 'node-a:9100' }, value: 7.5 },
			{ labels: { instance: 'node-b:9100' }, value: 14 },
		]),
		memoryTotalGb: matrix([
			{ labels: { instance: 'node-a:9100' }, value: 16 },
			{ labels: { instance: 'node-b:9100' }, value: 32 },
		]),
		diskFree: matrix([
			{ labels: { instance: 'node-a:9100', device: '/dev/sda1', mountpoint: '/' }, value: 25 * GIGABYTE },
			{ labels: { instance: 'node-a:9100', device: '/dev/sdb1', mountpoint: '/data' }, value: 50 * GIGABYTE },
			{ labels: { instance: 'node-b:9100', device: '/dev/vda1', mountpoint: '/' }, value: 20 * GIGABYTE },
		]),
		diskTotal: matrix([
			{ labels: { instance: 'node-a:9100', device: '/dev/sda1', mountpoint: '/' }, value: 100 * GIGABYTE },
			{ labels: { instance: 'node-a:9100', device: '/dev/sdb1', mountpoint: '/data' }, value: 200 * GIGABYTE },
			{ labels: { instance: 'node-b:9100', device: '/dev/vda1', mountpoint: '/' }, value: 80 * GIGABYTE },
		]),
		temperature: matrix([
			{ labels: { instance: 'node-b:9100' }, value: 54.25 },
		]),
	};

	assert.deepEqual(parseSystemResults(results), [
		{
			instance: 'node-a:9100',
			series: {
				cpuPercent: [[1_700_000_000, 10.5]],
				memoryPercent: [[1_700_000_000, 60]],
				memoryUsedGb: [[1_700_000_000, 7.5]],
				memoryTotalGb: [[1_700_000_000, 16]],
				disks: [
					{
						device: '/dev/sda1',
						mountpoint: '/',
						usedPercent: [[1_700_000_000, 75]],
						usedGb: [[1_700_000_000, 75]],
						capacityGb: 100,
						freeBytes: [[1_700_000_000, 25 * GIGABYTE]],
						totalBytes: [[1_700_000_000, 100 * GIGABYTE]],
					},
					{
						device: '/dev/sdb1',
						mountpoint: '/data',
						usedPercent: [[1_700_000_000, 75]],
						usedGb: [[1_700_000_000, 150]],
						capacityGb: 200,
						freeBytes: [[1_700_000_000, 50 * GIGABYTE]],
						totalBytes: [[1_700_000_000, 200 * GIGABYTE]],
					},
				],
				temperatureC: [],
			},
		},
		{
			instance: 'node-b:9100',
			series: {
				cpuPercent: [[1_700_000_000, 25]],
				memoryPercent: [[1_700_000_000, 70]],
				memoryUsedGb: [[1_700_000_000, 14]],
				memoryTotalGb: [[1_700_000_000, 32]],
				disks: [{
					device: '/dev/vda1',
					mountpoint: '/',
					usedPercent: [[1_700_000_000, 75]],
					usedGb: [[1_700_000_000, 60]],
					capacityGb: 80,
					freeBytes: [[1_700_000_000, 20 * GIGABYTE]],
					totalBytes: [[1_700_000_000, 80 * GIGABYTE]],
				}],
				temperatureC: [[1_700_000_000, 54.25]],
			},
		},
	]);
});

test('Prometheus parsing rejects non-matrix query results', () => {
	const invalid = matrix([]);
	invalid.data.resultType = 'vector';
	assert.throws(() => parseSystemResults({
		cpu: invalid,
		memory: matrix([]),
		memoryUsedGb: matrix([]),
		memoryTotalGb: matrix([]),
		diskFree: matrix([]),
		diskTotal: matrix([]),
		temperature: matrix([]),
	}), /range matrix/);
});

test('Loki response-class matrices are joined by upstream and skip unlabeled data', () => {
	const results = {
		successful: matrix([
			{ labels: { upstream: 'web-b' }, value: 14 },
			{ labels: {}, value: 100 },
			{ labels: { upstream: 'web-a' }, value: 27 },
		]),
		errors: matrix([
			{ labels: { upstream: 'web-a' }, value: 3 },
			{ labels: { upstream: 'web-c' }, value: 5 },
		]),
	};

	assert.deepEqual(parseLokiResults(results), [
		{
			upstream: 'web-a',
			successfulPoints: [[1_700_000_000, 27]],
			errorPoints: [[1_700_000_000, 3]],
			totalPoints: [[1_700_000_000, 30]],
		},
		{
			upstream: 'web-b',
			successfulPoints: [[1_700_000_000, 14]],
			errorPoints: [],
			totalPoints: [[1_700_000_000, 14]],
		},
		{
			upstream: 'web-c',
			successfulPoints: [],
			errorPoints: [[1_700_000_000, 5]],
			totalPoints: [[1_700_000_000, 5]],
		},
	]);
});

test('Loki response-class queries use one-minute volume buckets over a one-hour range', async () => {
	const requestedUrls = [];
	const fetchImpl = async (url) => {
		requestedUrls.push(url);
		const value = url.searchParams.get('query') === LOKI_QUERIES.successful ? '9' : '2';
		return {
			ok: true,
			json: async () => matrix([{
				labels: { upstream: 'api' },
				points: [[1_699_999_999.999, value]],
			}]),
		};
	};

	const result = await queryReverseProxyInformation('http://loki:3100', fetchImpl, 1_700_000_000_000);
	assert.equal(result.upstreams[0].upstream, 'api');
	assert.equal(result.upstreams[0].successfulPoints.length, 61);
	assert.deepEqual(result.upstreams[0].successfulPoints[0], [1_699_996_400, 0]);
	assert.deepEqual(result.upstreams[0].successfulPoints.at(-1), [1_700_000_000, 9]);
	assert.deepEqual(result.upstreams[0].errorPoints.at(-1), [1_700_000_000, 2]);
	assert.deepEqual(result.upstreams[0].totalPoints.at(-1), [1_700_000_000, 11]);
	assert.equal(requestedUrls.length, 2);
	assert.deepEqual(new Set(requestedUrls.map((url) => url.searchParams.get('query'))), new Set(Object.values(LOKI_QUERIES)));
	requestedUrls.forEach((requestedUrl) => {
		assert.equal(requestedUrl.pathname, '/loki/api/v1/query_range');
		assert.equal(requestedUrl.searchParams.get('start'), '1699996400');
		assert.equal(requestedUrl.searchParams.get('end'), '1700000000');
		assert.equal(requestedUrl.searchParams.get('step'), '60');
	});
});

test('system information executes every built-in query through the Prometheus range API', async () => {
	const requestedUrls = [];
	const fetchImpl = async (url) => {
		requestedUrls.push(url);
		return {
			ok: true,
			json: async () => matrix([{ labels: { instance: 'node:9100' }, value: 50 }]),
		};
	};

	const result = await querySystemInformation('http://prometheus:9090', fetchImpl);
	assert.equal(requestedUrls.length, 7);
	assert.ok(requestedUrls.every((url) => url.pathname === '/api/v1/query_range'));
	assert.equal(result.instances[0].instance, 'node:9100');
});

test('alert history stays server-side and queries a 24-hour Prometheus range', async () => {
	let requestedUrl;
	const fetchImpl = async (url) => {
		requestedUrl = url;
		return { ok: true, json: async () => matrix([]) };
	};

	await queryAlertHistory('http://prometheus:9090', fetchImpl, 1_700_000_000_000);
	assert.equal(requestedUrl.pathname, '/api/v1/query_range');
	assert.equal(requestedUrl.searchParams.get('query'), ALERT_HISTORY_QUERY);
	assert.equal(requestedUrl.searchParams.get('start'), '1699913600');
	assert.equal(requestedUrl.searchParams.get('end'), '1700000000');
	assert.equal(requestedUrl.searchParams.get('step'), '60');
});

test('Tailscale requests use a server-side bearer token and shorthand tailnet', async () => {
	let request;
	const fetchImpl = async (url, options) => {
		request = { url, options };
		return { ok: true, json: async () => ({ devices: [] }) };
	};

	assert.deepEqual(await queryTailscaleStatus({
		tailscaleApiUrl: 'https://api.tailscale.test',
		tailscaleTailnet: '-',
		tailscaleToken: 'secret-token',
	}, fetchImpl), { nodes: [] });
	assert.equal(request.url.pathname, '/api/v2/tailnet/-/devices');
	assert.equal(request.url.searchParams.get('fields'), 'all');
	assert.equal(request.options.headers.authorization, 'Bearer secret-token');
});

test('handler errors are sanitized before being returned to the browser', async () => {
	const response = {
		statusCode: 200,
		body: undefined,
		set() {},
		status(value) {
			this.statusCode = value;
			return this;
		},
		json(value) {
			this.body = value;
		},
	};
	const originalConsoleError = console.error;
	console.error = () => {};
	try {
		const handlers = createObservabilityHandlers({ lokiUrl: 'http://secret-loki:3100' }, async () => {
			throw new Error('secret backend details');
		});
		await handlers.reverseProxy({}, response);
	} finally {
		console.error = originalConsoleError;
	}

	assert.equal(response.statusCode, 502);
	assert.deepEqual(response.body, { error: 'Loki query failed' });
});
