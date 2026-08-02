const REQUEST_TIMEOUT = 15_000;
const HISTORY_SECONDS = 60 * 60;
const STEP_SECONDS = 60;

const PROMETHEUS_QUERIES = {
	cpu: '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))',
	memory: 'max by (instance) (100 * (1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)))',
	diskFree: 'max by (instance, device, mountpoint) (node_filesystem_avail_bytes{fstype!~"rootfs|tmpfs|ramfs|overlay|squashfs|nsfs|proc|sysfs|devtmpfs|devpts|cgroup2?"})',
	diskTotal: 'max by (instance, device, mountpoint) (node_filesystem_size_bytes{fstype!~"rootfs|tmpfs|ramfs|overlay|squashfs|nsfs|proc|sysfs|devtmpfs|devpts|cgroup2?"})',
	temperature: 'max by (instance) (node_hwmon_temp_celsius)',
};

const LOKI_QUERY = 'sum by (upstream) (count_over_time({upstream=~".+"}[1m]))';

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
});

const fetchQuery = async (baseUrl, path, query, queryParameters, fetchImpl = globalThis.fetch) => {
	const url = new URL(`${baseUrl}${path}`);
	url.searchParams.set('query', query);
	Object.entries(queryParameters).forEach(([name, value]) => url.searchParams.set(name, value));

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

	try {
		const response = await fetchImpl(url, {
			headers: { accept: 'application/json' },
			signal: controller.signal,
		});

		if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`);

		const body = await response.json();
		if (body.status !== 'success') throw new Error('Upstream query was not successful');
		return body;
	} finally {
		clearTimeout(timeout);
	}
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
			freeBytes: free?.points ?? [],
			totalBytes: total?.points ?? [],
		};
	}).sort((a, b) => a.mountpoint.localeCompare(b.mountpoint) || a.device.localeCompare(b.device));
};

const parseSystemResults = (results) => {
	const cpu = matrixByLabel(results.cpu, 'instance');
	const memory = matrixByLabel(results.memory, 'instance');
	const diskFree = diskMatrixByInstance(results.diskFree);
	const diskTotal = diskMatrixByInstance(results.diskTotal);
	const temperature = matrixByLabel(results.temperature, 'instance');

	const instanceNames = new Set([
		...cpu.keys(),
		...memory.keys(),
		...diskFree.keys(),
		...diskTotal.keys(),
		...temperature.keys(),
	]);

	return [...instanceNames].sort((a, b) => a.localeCompare(b)).map((instance) => ({
		instance,
		series: {
			cpuPercent: cpu.get(instance) ?? [],
			memoryPercent: memory.get(instance) ?? [],
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

const parseLokiResults = (response, queryParameters) => {
	const upstreams = matrixByLabel(response, 'upstream');
	return [...upstreams.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([upstream, points]) => ({ upstream, points: fillMissingBuckets(points, queryParameters) }));
};

const rangeParameters = (now = Date.now()) => {
	const end = Math.floor(now / 1000);
	return { start: end - HISTORY_SECONDS, end, step: STEP_SECONDS };
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
	const response = await fetchQuery(lokiUrl, '/loki/api/v1/query_range', LOKI_QUERY, queryParameters, fetchImpl);
	return { upstreams: parseLokiResults(response, queryParameters) };
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
});

export {
	LOKI_QUERY,
	PROMETHEUS_QUERIES,
	createObservabilityHandlers,
	getObservabilityConfig,
	parseLokiResults,
	parseSystemResults,
	queryReverseProxyInformation,
	querySystemInformation,
};
