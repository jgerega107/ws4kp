import assert from 'node:assert/strict';
import test from 'node:test';
import {
	UNIFI_RANGE_QUERIES,
	parseDeviceHealth,
	parseSwitchPorts,
	parseTrafficInsights,
	queryUnifiNetworkOverview,
	queryUnifiTrafficInsights,
} from '../proxy/unifi-observability.mjs';

const matrix = (series = []) => ({
	status: 'success',
	data: {
		resultType: 'matrix',
		result: series.map(({ labels = {}, values = [[100, '1']] }) => ({ metric: labels, values })),
	},
});

const vector = (series = []) => ({
	status: 'success',
	data: {
		resultType: 'vector',
		result: series.map(({ labels = {}, value = 1 }) => ({ metric: labels, value: [100, String(value)] })),
	},
});

test('UniFi device health joins range series by device name and type', () => {
	const result = parseDeviceHealth({
		cpuPercent: matrix([
			{ labels: { name: 'Gateway', type: 'ugw' }, values: [[100, '12'], [160, '14']] },
			{ labels: { name: 'Switch', type: 'usw' }, values: [[100, '7']] },
		]),
		memoryPercent: matrix([{ labels: { name: 'Gateway', type: 'ugw' }, values: [[100, '45']] }]),
		temperatureC: matrix([]),
		uptimeSeconds: matrix([]),
		receiveBytesPerSecond: matrix([]),
		transmitBytesPerSecond: matrix([]),
	});

	assert.deepEqual(result, [
		{
			name: 'Gateway',
			type: 'ugw',
			series: {
				cpuPercent: [[100, 12], [160, 14]],
				memoryPercent: [[100, 45]],
				temperatureC: [],
				uptimeSeconds: [],
				receiveBytesPerSecond: [],
				transmitBytesPerSecond: [],
			},
		},
		{
			name: 'Switch',
			type: 'usw',
			series: {
				cpuPercent: [[100, 7]],
				memoryPercent: [],
				temperatureC: [],
				uptimeSeconds: [],
				receiveBytesPerSecond: [],
				transmitBytesPerSecond: [],
			},
		},
	]);
});

test('UniFi port and traffic vectors become bounded display rows', () => {
	const ports = parseSwitchPorts({
		speedBps: vector([{ labels: { name: 'Core Switch', port_name: 'LAN 1', port_num: '1' }, value: 1_000_000_000 }]),
		poeWatts: vector([{ labels: { name: 'Core Switch', port_name: 'LAN 1', port_num: '1' }, value: 7.5 }]),
		errors: vector([{ labels: { name: 'Core Switch', port_name: 'LAN 1', port_num: '1' }, value: 2 }]),
	});
	assert.deepEqual(ports, [{
		device: 'Core Switch',
		portName: 'LAN 1',
		portNumber: 1,
		speedBps: 1_000_000_000,
		poeWatts: 7.5,
		errors: 2,
	}]);

	const traffic = parseTrafficInsights({
		applications: vector([{ labels: { application: 'Video', category: 'Streaming' }, value: 750 }]),
		clients: vector([{ labels: { name: 'Living Room TV' }, value: 250 }]),
		total: vector([{ value: 1000 }]),
	});
	assert.deepEqual(traffic, {
		totalBytesPerSecond: 1000,
		trafficInsights: [
			{ kind: 'Application', name: 'Video', detail: 'Streaming', bytesPerSecond: 750, share: 0.75 },
			{ kind: 'Client', name: 'Living Room TV', detail: '', bytesPerSecond: 250, share: 0.25 },
		],
	});
});

test('UniFi dashboards query Prometheus only from server-side endpoints', async () => {
	const rangeRequests = [];
	const rangeFetch = async (url) => {
		rangeRequests.push(url);
		return { ok: true, json: async () => matrix([{ values: [[100, '1']] }]) };
	};
	const overview = await queryUnifiNetworkOverview('http://prometheus:9090', rangeFetch, 1_700_000_000_000);
	assert.equal(overview.networkOverview.length, 1);
	assert.equal(rangeRequests.length, Object.keys(UNIFI_RANGE_QUERIES.networkOverview).length);
	assert.ok(rangeRequests.every((url) => url.pathname === '/api/v1/query_range'));
	assert.ok(rangeRequests.every((url) => url.searchParams.get('start') === '1699996400'));

	const instantRequests = [];
	const instantFetch = async (url) => {
		instantRequests.push(url);
		return { ok: true, json: async () => vector([]) };
	};
	assert.deepEqual(
		await queryUnifiTrafficInsights('http://prometheus:9090', instantFetch, 1_700_000_000_000),
		{ totalBytesPerSecond: 0, trafficInsights: [] },
	);
	assert.equal(instantRequests.length, 3);
	assert.ok(instantRequests.every((url) => url.pathname === '/api/v1/query'));
	assert.ok(instantRequests.every((url) => url.searchParams.get('time') === '1700000000'));
});
