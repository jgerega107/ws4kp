import { fetchQuery, parseMatrix, rangeParameters } from './observability.mjs';

const UNIFI_RANGE_QUERIES = {
	networkOverview: {
		controllerUp: 'max(unpoller_controller_up)',
		cacheAgeSeconds: 'max(unpoller_prometheus_cache_age_seconds)',
		receiveBytesPerSecond: 'sum(unpoller_site_receive_rate_bytes)',
		transmitBytesPerSecond: 'sum(unpoller_site_transmit_rate_bytes)',
		clients: 'sum(unpoller_topology_clients_total)',
		latencyMs: '1000 * max(unpoller_site_latency_seconds)',
		disconnectedDevices: 'sum(unpoller_site_disconnected)',
		wanDrops: 'sum(increase(unpoller_site_intenet_drops_total[1h]))',
	},
	wanPerformance: {
		receiveBytesPerSecond: 'sum(unpoller_site_receive_rate_bytes)',
		transmitBytesPerSecond: 'sum(unpoller_site_transmit_rate_bytes)',
		downloadUtilization: 'clamp_max(max by (wan_name) (unpoller_wan_peak_download_percent), 100)',
		uploadUtilization: 'clamp_max(max by (wan_name) (unpoller_wan_peak_upload_percent), 100)',
		uptimePercent: 'max by (wan_name) (unpoller_wan_uptime_percentage)',
		speedtestDownloadMbps: 'max(unpoller_site_xput_down_rate)',
		speedtestUploadMbps: 'max(unpoller_site_xput_up_rate)',
		speedtestPingMs: 'max(unpoller_site_speedtest_ping)',
	},
	wifiHealth: {
		signalDbm: 'avg(unpoller_client_radio_signal_db)',
		satisfactionPercent: '100 * avg(unpoller_client_satisfaction_ratio)',
		receiveBytesPerSecond: 'sum(unpoller_client_receive_rate_bytes)',
		transmitBytesPerSecond: 'sum(unpoller_client_transmit_rate_bytes)',
		retriesPerSecond: 'sum(rate(unpoller_client_transmit_retries_total[5m]))',
		clientsByBand: 'sum by (band) (unpoller_topology_connections_by_band)',
	},
	deviceHealth: {
		cpuPercent: '100 * max by (name, type) (unpoller_device_cpu_utilization_ratio)',
		memoryPercent: '100 * max by (name, type) (unpoller_device_memory_utilization_ratio)',
		temperatureC: 'max by (name, type) (unpoller_device_temperature_celsius)',
		uptimeSeconds: 'max by (name, type) (unpoller_device_uptime_seconds)',
		receiveBytesPerSecond: 'sum by (name, type) (rate(unpoller_device_receive_bytes_total[5m]))',
		transmitBytesPerSecond: 'sum by (name, type) (rate(unpoller_device_transmit_bytes_total[5m]))',
	},
	networkCapacity: {
		dhcpUtilizationPercent: 'max by (network) (unpoller_dhcp_utilization_percent)',
		activeLeases: 'sum(unpoller_dhcp_active_leases)',
		availableIps: 'sum(unpoller_dhcp_available_ips)',
		linkExperiencePercent: 'avg(unpoller_topology_link_experience_score)',
		wiredClients: 'sum(unpoller_topology_connections_wired)',
		wirelessClients: 'sum(unpoller_topology_connections_wireless)',
		unknownSwitch: 'max(unpoller_topology_has_unknown_switch)',
	},
};

const UNIFI_INSTANT_QUERIES = {
	switchPorts: {
		speedBps: 'max by (name, port_name, port_num) (unpoller_device_port_port_speed_bps)',
		poeWatts: 'max by (name, port_name, port_num) (unpoller_device_port_poe_watts)',
		errors: 'sum by (name, port_name, port_num) (increase(unpoller_device_port_receive_errors_total[1h]) + increase(unpoller_device_port_transmit_errors_total[1h]))',
	},
	trafficInsights: {
		applications: 'topk(8, sum by (application, category) (rate(unpoller_client_dpi_receive_bytes[5m])) + sum by (application, category) (rate(unpoller_client_dpi_transmit_bytes[5m])))',
		clients: 'topk(8, sum by (name) (rate(unpoller_client_receive_bytes_total[5m])) + sum by (name) (rate(unpoller_client_transmit_bytes_total[5m])))',
		total: 'sum(rate(unpoller_client_dpi_receive_bytes[5m])) + sum(rate(unpoller_client_dpi_transmit_bytes[5m]))',
	},
};

const numericPoints = (values) => (values ?? []).map(([timestamp, rawValue]) => [
	Number(timestamp), Number(rawValue),
]).filter(([timestamp, value]) => Number.isFinite(timestamp) && Number.isFinite(value));

const scalarSeries = (response) => numericPoints(parseMatrix(response)[0]?.values);

const groupedMatrix = (response, labelNames) => {
	const groups = new Map();
	parseMatrix(response).forEach((result) => {
		const labels = Object.fromEntries(labelNames.map((name) => [name, result?.metric?.[name] ?? '']));
		const points = numericPoints(result?.values);
		if (points.length === 0 || labelNames.some((name) => !labels[name])) return;
		groups.set(JSON.stringify(labels), { labels, points });
	});
	return groups;
};

const parseVector = (response) => {
	if (response?.data?.resultType !== 'vector' || !Array.isArray(response.data.result)) {
		throw new Error('Expected an instant vector result');
	}
	return response.data.result.map((result) => ({
		labels: result?.metric ?? {},
		value: Number(result?.value?.[1]),
	})).filter(({ value }) => Number.isFinite(value));
};

const namedRangeSeries = (response, label) => [...groupedMatrix(response, [label]).values()]
	.map(({ labels, points }) => ({ name: labels[label], points }))
	.sort((a, b) => a.name.localeCompare(b.name));

const parseNetworkOverview = (results) => [{
	name: 'UniFi Network',
	series: Object.fromEntries(Object.entries(results).map(([name, response]) => [name, scalarSeries(response)])),
}];

const parseWanPerformance = (results) => [{
	name: 'WAN Performance',
	series: {
		receiveBytesPerSecond: scalarSeries(results.receiveBytesPerSecond),
		transmitBytesPerSecond: scalarSeries(results.transmitBytesPerSecond),
		downloadUtilization: namedRangeSeries(results.downloadUtilization, 'wan_name'),
		uploadUtilization: namedRangeSeries(results.uploadUtilization, 'wan_name'),
		uptimePercent: namedRangeSeries(results.uptimePercent, 'wan_name'),
		speedtestDownloadMbps: scalarSeries(results.speedtestDownloadMbps),
		speedtestUploadMbps: scalarSeries(results.speedtestUploadMbps),
		speedtestPingMs: scalarSeries(results.speedtestPingMs),
	},
}];

const parseWifiHealth = (results) => [{
	name: 'Wireless Network',
	series: {
		signalDbm: scalarSeries(results.signalDbm),
		satisfactionPercent: scalarSeries(results.satisfactionPercent),
		receiveBytesPerSecond: scalarSeries(results.receiveBytesPerSecond),
		transmitBytesPerSecond: scalarSeries(results.transmitBytesPerSecond),
		retriesPerSecond: scalarSeries(results.retriesPerSecond),
		clientsByBand: namedRangeSeries(results.clientsByBand, 'band'),
	},
}];

const parseDeviceHealth = (results) => {
	const grouped = Object.fromEntries(Object.entries(results).map(([name, response]) => [
		name, groupedMatrix(response, ['name', 'type']),
	]));
	const keys = new Set(Object.values(grouped).flatMap((groups) => [...groups.keys()]));
	return [...keys].map((key) => {
		const metadata = Object.values(grouped).map((groups) => groups.get(key)).find((value) => value)?.labels;
		return {
			name: metadata.name,
			type: metadata.type,
			series: Object.fromEntries(Object.entries(grouped).map(([name, groups]) => [name, groups.get(key)?.points ?? []])),
		};
	}).sort((a, b) => a.name.localeCompare(b.name));
};

const parseNetworkCapacity = (results) => [{
	name: 'Network Capacity',
	series: {
		dhcpUtilizationPercent: namedRangeSeries(results.dhcpUtilizationPercent, 'network'),
		activeLeases: scalarSeries(results.activeLeases),
		availableIps: scalarSeries(results.availableIps),
		linkExperiencePercent: scalarSeries(results.linkExperiencePercent),
		wiredClients: scalarSeries(results.wiredClients),
		wirelessClients: scalarSeries(results.wirelessClients),
		unknownSwitch: scalarSeries(results.unknownSwitch),
	},
}];

const portKey = (labels) => JSON.stringify({
	device: labels.name ?? '',
	portName: labels.port_name ?? '',
	portNumber: labels.port_num ?? '',
});

const parseSwitchPorts = (results) => {
	const values = Object.fromEntries(Object.entries(results).map(([name, response]) => [
		name, new Map(parseVector(response).map(({ labels, value }) => [portKey(labels), { labels, value }])),
	]));
	const keys = new Set(Object.values(values).flatMap((items) => [...items.keys()]));
	return [...keys].map((key) => {
		const item = Object.values(values).map((items) => items.get(key)).find((value) => value);
		const portNumber = Number(item.labels.port_num);
		return {
			device: item.labels.name || 'UniFi Device',
			portName: item.labels.port_name || (Number.isFinite(portNumber) ? `Port ${portNumber}` : 'Port'),
			portNumber: Number.isFinite(portNumber) ? portNumber : null,
			speedBps: values.speedBps.get(key)?.value ?? 0,
			poeWatts: values.poeWatts.get(key)?.value ?? null,
			errors: values.errors.get(key)?.value ?? 0,
		};
	}).sort((a, b) => a.device.localeCompare(b.device)
		|| (a.portNumber ?? Number.MAX_SAFE_INTEGER) - (b.portNumber ?? Number.MAX_SAFE_INTEGER)
		|| a.portName.localeCompare(b.portName));
};

const parseTrafficInsights = (results) => {
	const totalBytesPerSecond = parseVector(results.total)[0]?.value ?? 0;
	const normalize = (kind, items, nameLabel, detailLabel) => items.map(({ labels, value }) => ({
		kind,
		name: labels[nameLabel] || `Unknown ${kind}`,
		detail: detailLabel ? labels[detailLabel] || '' : '',
		bytesPerSecond: value,
		share: totalBytesPerSecond > 0 ? value / totalBytesPerSecond : 0,
	})).sort((a, b) => b.bytesPerSecond - a.bytesPerSecond || a.name.localeCompare(b.name));
	return {
		totalBytesPerSecond,
		trafficInsights: [
			...normalize('Application', parseVector(results.applications), 'application', 'category'),
			...normalize('Client', parseVector(results.clients), 'name'),
		],
	};
};

const queryEntries = async (prometheusUrl, queries, path, parameters, fetchImpl) => Object.fromEntries(await Promise.all(
	Object.entries(queries).map(async ([name, query]) => [
		name, await fetchQuery(prometheusUrl, path, query, parameters, fetchImpl),
	]),
));

const queryRangePanel = async (prometheusUrl, panel, parser, fetchImpl = globalThis.fetch, now = Date.now()) => {
	const results = await queryEntries(
		prometheusUrl,
		UNIFI_RANGE_QUERIES[panel],
		'/api/v1/query_range',
		rangeParameters(now),
		fetchImpl,
	);
	return parser(results);
};

const queryInstantPanel = async (prometheusUrl, panel, parser, fetchImpl = globalThis.fetch, now = Date.now()) => {
	const results = await queryEntries(
		prometheusUrl,
		UNIFI_INSTANT_QUERIES[panel],
		'/api/v1/query',
		{ time: Math.floor(now / 1000) },
		fetchImpl,
	);
	return parser(results);
};

const queryUnifiNetworkOverview = async (...args) => ({
	networkOverview: await queryRangePanel(args[0], 'networkOverview', parseNetworkOverview, ...args.slice(1)),
});
const queryUnifiWanPerformance = async (...args) => ({
	wanPerformance: await queryRangePanel(args[0], 'wanPerformance', parseWanPerformance, ...args.slice(1)),
});
const queryUnifiWifiHealth = async (...args) => ({
	wifiHealth: await queryRangePanel(args[0], 'wifiHealth', parseWifiHealth, ...args.slice(1)),
});
const queryUnifiDeviceHealth = async (...args) => ({
	deviceHealth: await queryRangePanel(args[0], 'deviceHealth', parseDeviceHealth, ...args.slice(1)),
});
const queryUnifiNetworkCapacity = async (...args) => ({
	networkCapacity: await queryRangePanel(args[0], 'networkCapacity', parseNetworkCapacity, ...args.slice(1)),
});
const queryUnifiSwitchPorts = async (...args) => ({
	switchPorts: await queryInstantPanel(args[0], 'switchPorts', parseSwitchPorts, ...args.slice(1)),
});
const queryUnifiTrafficInsights = async (...args) => queryInstantPanel(args[0], 'trafficInsights', parseTrafficInsights, ...args.slice(1));

const sendError = (res, panel, error) => {
	console.error(`UniFi ${panel} query failed: ${error.message}`);
	res.status(502).json({ error: `UniFi ${panel} query failed` });
};

const unifiHandler = (panel, query, prometheusUrl, fetchImpl) => async (_req, res) => {
	try {
		res.set('Cache-Control', 'no-store');
		res.json(await query(prometheusUrl, fetchImpl));
	} catch (error) {
		sendError(res, panel, error);
	}
};

const createUnifiHandlers = (prometheusUrl, fetchImpl = globalThis.fetch) => ({
	networkOverview: unifiHandler('network overview', queryUnifiNetworkOverview, prometheusUrl, fetchImpl),
	wanPerformance: unifiHandler('WAN performance', queryUnifiWanPerformance, prometheusUrl, fetchImpl),
	wifiHealth: unifiHandler('WiFi health', queryUnifiWifiHealth, prometheusUrl, fetchImpl),
	deviceHealth: unifiHandler('device health', queryUnifiDeviceHealth, prometheusUrl, fetchImpl),
	switchPorts: unifiHandler('switch and PoE', queryUnifiSwitchPorts, prometheusUrl, fetchImpl),
	trafficInsights: unifiHandler('traffic insights', queryUnifiTrafficInsights, prometheusUrl, fetchImpl),
	networkCapacity: unifiHandler('network capacity', queryUnifiNetworkCapacity, prometheusUrl, fetchImpl),
});

export {
	UNIFI_INSTANT_QUERIES,
	UNIFI_RANGE_QUERIES,
	createUnifiHandlers,
	parseDeviceHealth,
	parseNetworkCapacity,
	parseNetworkOverview,
	parseSwitchPorts,
	parseTrafficInsights,
	parseWanPerformance,
	parseWifiHealth,
	queryUnifiDeviceHealth,
	queryUnifiNetworkCapacity,
	queryUnifiNetworkOverview,
	queryUnifiSwitchPorts,
	queryUnifiTrafficInsights,
	queryUnifiWanPerformance,
	queryUnifiWifiHealth,
};
