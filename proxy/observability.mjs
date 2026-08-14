const REQUEST_TIMEOUT = 15_000;
const HISTORY_SECONDS = 60 * 60;
const ALERT_HISTORY_SECONDS = 24 * 60 * 60;
const STEP_SECONDS = 60;
const TAILSCALE_API_URL = 'https://api.tailscale.com';
const TAILSCALE_ONLINE_WINDOW = 5 * 60 * 1000;
const BYTES_PER_GIGABYTE = 1024 ** 3;
const PROMETHEUS_QUERIES = {
	cpu: '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))',
	memory: 'max by (instance) (100 * (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)))',
	memoryUsedGb: 'max by (instance) ((node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / 1073741824)',
	memoryTotalGb: 'max by (instance) (node_memory_MemTotal_bytes / 1073741824)',
	diskFree: 'max by (instance, device, mountpoint) (node_filesystem_avail_bytes{fstype!~"rootfs|tmpfs|ramfs|overlay|squashfs|nsfs|proc|sysfs|devtmpfs|devpts|cgroup2?"})',
	diskTotal: 'max by (instance, device, mountpoint) (node_filesystem_size_bytes{fstype!~"rootfs|tmpfs|ramfs|overlay|squashfs|nsfs|proc|sysfs|devtmpfs|devpts|cgroup2?"})',
	temperature: 'max by (instance) (node_hwmon_temp_celsius)',
};

const LOKI_QUERIES = {
	successful: 'sum by (upstream) (count_over_time({upstream=~".+"} | json | status >= 200 | status < 400 [1m]))',
	errors: 'sum by (upstream) (count_over_time({upstream=~".+"} | json | status >= 400 | status < 600 [1m]))',
};
const ALERT_HISTORY_QUERY = 'ALERTS{alertstate="firing"}';

const normalizeBaseUrl = (value, name) => {
	if (!value) return undefined;

	const url = new URL(value);
	if (!['http:', 'https:'].includes(url.protocol)) {
		throw new Error(`${name} must use HTTP or HTTPS`);
	}

	return url.toString().replace(/\/$/, '');
};

const getObservabilityConfig = (environment = process.env) => ({
	prometheusUrl: normalizeBaseUrl(environment.WS4KP_PROMETHEUS_URL, 'WS4KP_PROMETHEUS_URL'),
	lokiUrl: normalizeBaseUrl(environment.WS4KP_LOKI_URL, 'WS4KP_LOKI_URL'),
	tailscaleApiUrl: normalizeBaseUrl(
		environment.WS4KP_TAILSCALE_API_URL ?? TAILSCALE_API_URL,
		'WS4KP_TAILSCALE_API_URL',
	),
	tailscaleToken: environment.WS4KP_TAILSCALE_API_TOKEN?.trim() || undefined,
	tailscaleTailnet: environment.WS4KP_TAILSCALE_TAILNET?.trim() || '-',
});

const fetchJson = async (url, options = {}, fetchImpl = globalThis.fetch) => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

	try {
		const response = await fetchImpl(url, {
			...options,
			headers: { accept: 'application/json', ...options.headers },
			signal: controller.signal,
		});

		if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`);
		return await response.json();
	} finally {
		clearTimeout(timeout);
	}
};

const fetchQuery = async (baseUrl, path, query, queryParameters, fetchImpl = globalThis.fetch) => {
	const url = new URL(`${baseUrl}${path}`);
	url.searchParams.set('query', query);
	Object.entries(queryParameters).forEach(([name, value]) => url.searchParams.set(name, value));

	const body = await fetchJson(url, {}, fetchImpl);
	if (body.status !== 'success') throw new Error('Upstream query was not successful');
	return body;
};

const parseMatrix = (response) => {
	if (response?.data?.resultType !== 'matrix' || !Array.isArray(response.data.result)) {
		throw new Error('Expected a range matrix result');
	}
	return response.data.result;
};

const matrixByLabel = (response, label) => {
	const values = new Map();
	parseMatrix(response).forEach((result) => {
		const name = result?.metric?.[label];
		if (typeof name !== 'string' || name.length === 0 || !Array.isArray(result?.values)) return;

		const points = result.values.map(([timestamp, rawValue]) => [
			Number(timestamp),
			Number(rawValue),
		]).filter(([timestamp, value]) => Number.isFinite(timestamp) && Number.isFinite(value));
		if (points.length > 0) {
			values.set(name, points);
		}
	});
	return values;
};

const diskMatrixByInstance = (response) => {
	const instances = new Map();
	parseMatrix(response).forEach((result) => {
		const { instance, device, mountpoint } = result?.metric ?? {};
		if (!instance || !device || !mountpoint || !Array.isArray(result?.values)) return;

		const points = result.values.map(([timestamp, rawValue]) => [
			Number(timestamp),
			Number(rawValue),
		]).filter(([timestamp, value]) => Number.isFinite(timestamp) && Number.isFinite(value));
		if (points.length === 0) return;

		if (!instances.has(instance)) instances.set(instance, new Map());
		instances.get(instance).set(JSON.stringify([device, mountpoint]), {
			device, mountpoint, points,
		});
	});
	return instances;
};

const deriveDiskUsed = (freePoints = [], totalPoints = []) => {
	const totalsByTimestamp = new Map(totalPoints.map(([timestamp, value]) => [timestamp, value]));
	return freePoints.map(([timestamp, free]) => {
		const total = totalsByTimestamp.get(timestamp);
		if (!Number.isFinite(total) || total <= 0) return undefined;
		return [timestamp, 100 * (1 - free / total)];
	}).filter((point) => point);
};

const deriveDiskUsedGb = (freePoints = [], totalPoints = []) => {
	const totalsByTimestamp = new Map(totalPoints.map(([timestamp, value]) => [timestamp, value]));
	return freePoints.map(([timestamp, free]) => {
		const total = totalsByTimestamp.get(timestamp);
		if (!Number.isFinite(total) || total <= 0) return undefined;
		return [timestamp, (total - free) / BYTES_PER_GIGABYTE];
	}).filter((point) => point);
};

const disksForInstance = (instance, freeByInstance, totalByInstance) => {
	const freeDisks = freeByInstance.get(instance) ?? new Map();
	const totalDisks = totalByInstance.get(instance) ?? new Map();
	const diskKeys = new Set([...freeDisks.keys(), ...totalDisks.keys()]);

	return [...diskKeys].map((key) => {
		const free = freeDisks.get(key);
		const total = totalDisks.get(key);
		const metadata = free ?? total;
		return {
			device: metadata.device,
			mountpoint: metadata.mountpoint,
			usedPercent: deriveDiskUsed(free?.points, total?.points),
			usedGb: deriveDiskUsedGb(free?.points, total?.points),
			capacityGb: Number.isFinite(total?.points?.at(-1)?.[1])
				? total.points.at(-1)[1] / BYTES_PER_GIGABYTE
				: null,
			freeBytes: free?.points ?? [],
			totalBytes: total?.points ?? [],
		};
	}).sort((a, b) => a.mountpoint.localeCompare(b.mountpoint) || a.device.localeCompare(b.device));
};

const parseSystemResults = (results) => {
	const cpu = matrixByLabel(results.cpu, 'instance');
	const memory = matrixByLabel(results.memory, 'instance');
	const memoryUsedGb = matrixByLabel(results.memoryUsedGb, 'instance');
	const memoryTotalGb = matrixByLabel(results.memoryTotalGb, 'instance');
	const diskFree = diskMatrixByInstance(results.diskFree);
	const diskTotal = diskMatrixByInstance(results.diskTotal);
	const temperature = matrixByLabel(results.temperature, 'instance');

	const instanceNames = new Set([
		...cpu.keys(),
		...memory.keys(),
		...memoryUsedGb.keys(),
		...memoryTotalGb.keys(),
		...diskFree.keys(),
		...diskTotal.keys(),
		...temperature.keys(),
	]);

	return [...instanceNames].sort((a, b) => a.localeCompare(b)).map((instance) => ({
		instance,
		series: {
			cpuPercent: cpu.get(instance) ?? [],
			memoryPercent: memory.get(instance) ?? [],
			memoryUsedGb: memoryUsedGb.get(instance) ?? [],
			memoryTotalGb: memoryTotalGb.get(instance) ?? [],
			disks: disksForInstance(instance, diskFree, diskTotal),
			temperatureC: temperature.get(instance) ?? [],
		},
	}));
};

const fillMissingBuckets = (points, queryParameters) => {
	if (!queryParameters) return points;
	const valuesByBucket = new Map();
	points.forEach(([timestamp, value]) => {
		const bucket = Math.round((timestamp - queryParameters.start) / queryParameters.step);
		if (bucket >= 0) valuesByBucket.set(bucket, value);
	});
	const filled = [];
	const bucketCount = Math.floor((queryParameters.end - queryParameters.start) / queryParameters.step);
	for (let bucket = 0; bucket <= bucketCount; bucket += 1) {
		filled.push([
			queryParameters.start + bucket * queryParameters.step,
			valuesByBucket.get(bucket) ?? 0,
		]);
	}
	return filled;
};

const sumPointSeries = (...series) => {
	const values = new Map();
	series.flat().forEach(([timestamp, value]) => {
		values.set(timestamp, (values.get(timestamp) ?? 0) + value);
	});
	return [...values.entries()].sort(([a], [b]) => a - b);
};

const parseLokiResults = (results, queryParameters) => {
	const successful = matrixByLabel(results.successful, 'upstream');
	const errors = matrixByLabel(results.errors, 'upstream');
	const upstreams = new Set([...successful.keys(), ...errors.keys()]);
	return [...upstreams].sort((a, b) => a.localeCompare(b)).map((upstream) => {
		const successfulPoints = fillMissingBuckets(successful.get(upstream) ?? [], queryParameters);
		const errorPoints = fillMissingBuckets(errors.get(upstream) ?? [], queryParameters);
		return {
			upstream,
			successfulPoints,
			errorPoints,
			totalPoints: sumPointSeries(successfulPoints, errorPoints),
		};
	});
};

const rangeParameters = (now = Date.now(), historySeconds = HISTORY_SECONDS) => {
	const end = Math.floor(now / 1000);
	return { start: end - historySeconds, end, step: STEP_SECONDS };
};

const parseAlertHistory = (response, queryParameters) => parseMatrix(response).map((result) => {
	const labels = result?.metric ?? {};
	const points = (result?.values ?? []).map(([timestamp, rawValue]) => [
		Number(timestamp),
		Number(rawValue),
	]).filter(([timestamp, value]) => Number.isFinite(timestamp) && Number.isFinite(value) && value > 0);
	if (points.length === 0) return undefined;

	const episodes = [];
	points.forEach(([timestamp]) => {
		const previous = episodes.at(-1);
		if (!previous || timestamp - previous.lastPoint > queryParameters.step * 1.5) {
			episodes.push({ startedAt: timestamp, lastPoint: timestamp });
		} else {
			previous.lastPoint = timestamp;
		}
	});

	const currentlyFiring = points.at(-1)[0] >= queryParameters.end - queryParameters.step * 1.5;
	const normalizedEpisodes = episodes.map((episode, index) => {
		const isCurrentEpisode = currentlyFiring && index === episodes.length - 1;
		const end = Math.min(queryParameters.end, episode.lastPoint + queryParameters.step);
		return {
			startedAt: episode.startedAt,
			endedAt: isCurrentEpisode ? null : end,
			durationSeconds: Math.max(queryParameters.step, end - episode.startedAt),
		};
	});

	return {
		name: labels.alertname || 'Unnamed Alert',
		severity: labels.severity || 'unknown',
		source: labels.instance || labels.job || '',
		currentlyFiring,
		startedAt: points[0][0],
		lastFiredAt: points.at(-1)[0],
		durationSeconds: normalizedEpisodes.reduce((sum, episode) => sum + episode.durationSeconds, 0),
		episodes: normalizedEpisodes,
	};
}).filter((alert) => alert).sort((a, b) => (
	Number(b.currentlyFiring) - Number(a.currentlyFiring)
	|| b.lastFiredAt - a.lastFiredAt
	|| a.name.localeCompare(b.name)
));

const parseTailscaleDevices = (response, now = Date.now()) => {
	if (!Array.isArray(response?.devices)) throw new Error('Expected a Tailscale device list');

	return response.devices.map((device) => {
		const lastSeen = Date.parse(device?.lastSeen);
		const recentlySeen = Number.isFinite(lastSeen) && now - lastSeen <= TAILSCALE_ONLINE_WINDOW;
		const assignedName = device?.name?.trim().replace(/\.$/, '').split('.')[0];
		const version = device?.clientVersion?.trim();
		const advertisedRoutes = Array.isArray(device?.advertisedRoutes)
			? device.advertisedRoutes
			: device?.enabledRoutes ?? [];
		const isExitNode = advertisedRoutes.some((route) => route === '0.0.0.0/0' || route === '::/0');
		const isSubnetRouter = advertisedRoutes.some((route) => route !== '0.0.0.0/0' && route !== '::/0');
		const roles = [];
		if (isSubnetRouter) roles.push('Subnet Router');
		if (isExitNode) roles.push('Exit Node');
		return {
			name: assignedName || device?.hostname?.trim() || 'Unnamed Node',
			online: typeof device?.connectedToControl === 'boolean'
				? device.connectedToControl
				: recentlySeen,
			version: version?.toLowerCase() === 'unknown' ? '' : version || '',
			roles,
		};
	}).sort((a, b) => a.name.localeCompare(b.name));
};

const querySystemInformation = async (prometheusUrl, fetchImpl = globalThis.fetch, now = Date.now()) => {
	const queryParameters = rangeParameters(now);
	const entries = await Promise.all(Object.entries(PROMETHEUS_QUERIES).map(async ([name, query]) => [
		name,
		await fetchQuery(prometheusUrl, '/api/v1/query_range', query, queryParameters, fetchImpl),
	]));
	return { instances: parseSystemResults(Object.fromEntries(entries)) };
};

const queryReverseProxyInformation = async (lokiUrl, fetchImpl = globalThis.fetch, now = Date.now()) => {
	const queryParameters = rangeParameters(now);
	const entries = await Promise.all(Object.entries(LOKI_QUERIES).map(async ([name, query]) => [
		name,
		await fetchQuery(lokiUrl, '/loki/api/v1/query_range', query, queryParameters, fetchImpl),
	]));
	return { upstreams: parseLokiResults(Object.fromEntries(entries), queryParameters) };
};

const queryAlertHistory = async (prometheusUrl, fetchImpl = globalThis.fetch, now = Date.now()) => {
	const queryParameters = rangeParameters(now, ALERT_HISTORY_SECONDS);
	const response = await fetchQuery(
		prometheusUrl,
		'/api/v1/query_range',
		ALERT_HISTORY_QUERY,
		queryParameters,
		fetchImpl,
	);
	return { alerts: parseAlertHistory(response, queryParameters) };
};

const queryTailscaleStatus = async (config, fetchImpl = globalThis.fetch, now = Date.now()) => {
	const tailnet = encodeURIComponent(config.tailscaleTailnet || '-');
	const url = new URL(`${config.tailscaleApiUrl}/api/v2/tailnet/${tailnet}/devices`);
	url.searchParams.set('fields', 'all');
	const response = await fetchJson(url, {
		headers: { authorization: `Bearer ${config.tailscaleToken}` },
	}, fetchImpl);
	return { nodes: parseTailscaleDevices(response, now) };
};

const sendObservabilityError = (res, service, error) => {
	console.error(`${service} observability query failed: ${error.message}`);
	res.status(502).json({ error: `${service} query failed` });
};

const createObservabilityHandlers = (config, fetchImpl = globalThis.fetch) => ({
	system: async (_req, res) => {
		try {
			res.set('Cache-Control', 'no-store');
			res.json(await querySystemInformation(config.prometheusUrl, fetchImpl));
		} catch (error) {
			sendObservabilityError(res, 'Prometheus', error);
		}
	},
	reverseProxy: async (_req, res) => {
		try {
			res.set('Cache-Control', 'no-store');
			res.json(await queryReverseProxyInformation(config.lokiUrl, fetchImpl));
		} catch (error) {
			sendObservabilityError(res, 'Loki', error);
		}
	},
	alerts: async (_req, res) => {
		try {
			res.set('Cache-Control', 'no-store');
			res.json(await queryAlertHistory(config.prometheusUrl, fetchImpl));
		} catch (error) {
			sendObservabilityError(res, 'Prometheus alert history', error);
		}
	},
	tailscale: async (_req, res) => {
		try {
			res.set('Cache-Control', 'no-store');
			res.json(await queryTailscaleStatus(config, fetchImpl));
		} catch (error) {
			sendObservabilityError(res, 'Tailscale', error);
		}
	},
});

export {
	ALERT_HISTORY_QUERY,
	LOKI_QUERIES,
	PROMETHEUS_QUERIES,
	createObservabilityHandlers,
	fetchQuery,
	getObservabilityConfig,
	parseAlertHistory,
	parseLokiResults,
	parseMatrix,
	parseSystemResults,
	parseTailscaleDevices,
	queryAlertHistory,
	queryReverseProxyInformation,
	querySystemInformation,
	queryTailscaleStatus,
	rangeParameters,
};
