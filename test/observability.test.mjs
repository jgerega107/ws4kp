import assert from 'node:assert/strict';
import test from 'node:test';
import {
	LOKI_QUERY,
	createObservabilityHandlers,
	getObservabilityConfig,
	parseLokiResults,
	parseSystemResults,
	queryReverseProxyInformation,
	querySystemInformation,
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

test('observability URLs are optional and normalized', () => {
	assert.deepEqual(getObservabilityConfig({}), {
		prometheusUrl: undefined,
		lokiUrl: undefined,
	});
	assert.deepEqual(getObservabilityConfig({
		WS4KP_PROMETHEUS_URL: 'http://prometheus:9090/',
		WS4KP_LOKI_URL: 'https://loki.example.test/',
	}), {
		prometheusUrl: 'http://prometheus:9090',
		lokiUrl: 'https://loki.example.test',
	});
	assert.throws(() => getObservabilityConfig({ WS4KP_LOKI_URL: 'file:///logs' }), /HTTP or HTTPS/);
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
		diskFree: matrix([
			{ labels: { instance: 'node-a:9100', device: '/dev/sda1', mountpoint: '/' }, value: 25 },
			{ labels: { instance: 'node-a:9100', device: '/dev/sdb1', mountpoint: '/data' }, value: 50 },
			{ labels: { instance: 'node-b:9100', device: '/dev/vda1', mountpoint: '/' }, value: 20 },
		]),
		diskTotal: matrix([
			{ labels: { instance: 'node-a:9100', device: '/dev/sda1', mountpoint: '/' }, value: 100 },
			{ labels: { instance: 'node-a:9100', device: '/dev/sdb1', mountpoint: '/data' }, value: 200 },
			{ labels: { instance: 'node-b:9100', device: '/dev/vda1', mountpoint: '/' }, value: 80 },
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
				disks: [
					{
						device: '/dev/sda1',
						mountpoint: '/',
						usedPercent: [[1_700_000_000, 75]],
						freeBytes: [[1_700_000_000, 25]],
						totalBytes: [[1_700_000_000, 100]],
					},
					{
						device: '/dev/sdb1',
						mountpoint: '/data',
						usedPercent: [[1_700_000_000, 75]],
						freeBytes: [[1_700_000_000, 50]],
						totalBytes: [[1_700_000_000, 200]],
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
				disks: [{
					device: '/dev/vda1',
					mountpoint: '/',
					usedPercent: [[1_700_000_000, 75]],
					freeBytes: [[1_700_000_000, 20]],
					totalBytes: [[1_700_000_000, 80]],
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
		diskFree: matrix([]),
		diskTotal: matrix([]),
		temperature: matrix([]),
	}), /range matrix/);
});

test('Loki matrices return sorted raw count series and skip unlabeled data', () => {
	const response = matrix([
		{ labels: { upstream: 'web-b' }, value: 14 },
		{ labels: {}, value: 100 },
		{ labels: { upstream: 'web-a' }, value: 27 },
	]);

	assert.deepEqual(parseLokiResults(response), [
		{ upstream: 'web-a', points: [[1_700_000_000, 27]] },
		{ upstream: 'web-b', points: [[1_700_000_000, 14]] },
	]);
});

test('Loki queries use one-minute volume buckets over a one-hour range', async () => {
	let requestedUrl;
	const fetchImpl = async (url) => {
		requestedUrl = url;
		return {
			ok: true,
			json: async () => matrix([{
				labels: { upstream: 'api' },
				points: [[1_699_999_999.999, '9']],
			}]),
		};
	};

	const result = await queryReverseProxyInformation('http://loki:3100', fetchImpl, 1_700_000_000_000);
	assert.equal(result.upstreams[0].upstream, 'api');
	assert.equal(result.upstreams[0].points.length, 61);
	assert.deepEqual(result.upstreams[0].points[0], [1_699_996_400, 0]);
	assert.deepEqual(result.upstreams[0].points.at(-1), [1_700_000_000, 9]);
	assert.equal(requestedUrl.pathname, '/loki/api/v1/query_range');
	assert.equal(requestedUrl.searchParams.get('query'), LOKI_QUERY);
	assert.equal(requestedUrl.searchParams.get('start'), '1699996400');
	assert.equal(requestedUrl.searchParams.get('end'), '1700000000');
	assert.equal(requestedUrl.searchParams.get('step'), '60');
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
	assert.equal(requestedUrls.length, 5);
	assert.ok(requestedUrls.every((url) => url.pathname === '/api/v1/query_range'));
	assert.equal(result.instances[0].instance, 'node:9100');
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
