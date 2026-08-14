/* eslint-disable max-classes-per-file */
import { registerDisplay } from './navigation.mjs';
import ObservabilityDisplay, { observabilityNavId } from './observability-display.mjs';
import {
	latestValue, renderMultiTrendChart, renderTrendChart,
} from './observability-chart.mjs';

const COLORS = ['aqua', '#38df55', '#ffcf33', '#ff3b30', '#d66bff', '#ff8a30', '#4aa3ff', 'white'];
const colorFor = (index) => COLORS[index] ?? `hsl(${Math.round(index * 137.508) % 360} 85% 65%)`;
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const formatCount = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString() : 'N/A');
const formatPercent = (value) => (Number.isFinite(value) ? `${value.toFixed(1)}%` : 'N/A');
const formatRate = (value) => {
	if (!Number.isFinite(value)) return 'N/A';
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB/s`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB/s`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB/s`;
	return `${Math.round(value)} B/s`;
};
const formatRateCompact = (value) => {
	if (!Number.isFinite(value)) return 'N/A';
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}G/s`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M/s`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K/s`;
	return `${Math.round(value)}B/s`;
};
const formatRateAxis = (value) => {
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}G`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return Math.round(value).toLocaleString();
};
const formatDuration = (seconds) => {
	if (!Number.isFinite(seconds)) return 'N/A';
	const days = Math.floor(seconds / 86_400);
	if (days > 0) return `${days}d`;
	const hours = Math.floor(seconds / 3600);
	if (hours > 0) return `${hours}h`;
	return `${Math.floor(seconds / 60)}m`;
};
const formatLinkSpeed = (bitsPerSecond) => {
	if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return 'DOWN';
	if (bitsPerSecond >= 1_000_000_000) return `${bitsPerSecond / 1_000_000_000}G`;
	return `${Math.round(bitsPerSecond / 1_000_000)}M`;
};
const latestSum = (series) => series.reduce((sum, item) => sum + finite(latestValue(item.points)), 0);
const latestMaximum = (series) => {
	const values = series.map((item) => latestValue(item.points)).filter(Number.isFinite);
	return values.length > 0 ? Math.max(...values) : null;
};
const coloredSeries = (series, name = (item) => item.name) => series.map((item, index) => ({
	name: name(item), color: colorFor(index), points: item.points,
}));

const textElement = (className, value) => {
	const element = document.createElement('span');
	element.className = className;
	element.textContent = value;
	return element;
};

const primaryValue = (name, detail) => {
	const element = document.createElement('span');
	element.className = 'primary-value';
	element.append(textElement('', name));
	if (detail) {
		const detailElement = document.createElement('small');
		detailElement.textContent = detail;
		element.append(detailElement);
	}
	return element;
};

class UnifiNetworkOverview extends ObservabilityDisplay {
	constructor() {
		super(observabilityNavId('unifi-network'), 'unifi-network-overview', 'UniFi Network Overview', '/observability/unifi/network-overview', 'networkOverview');
	}

	drawCanvas() {
		const panel = this.data?.[this.screenIndex];
		if (!panel) return;
		const { series } = panel;
		const controllerOnline = latestValue(series.controllerUp) >= 0.5;
		const cacheAge = latestValue(series.cacheAgeSeconds);
		const wanDrops = latestValue(series.wanDrops);
		this.elem.querySelector('.entity-name').textContent = `${controllerOnline ? 'Controller Online' : 'Controller Offline'} • ${formatCount(wanDrops)} WAN Drops • ${formatCount(cacheAge)}s Old`;
		this.elem.querySelector('.traffic-value').textContent = formatRateCompact(
			finite(latestValue(series.receiveBytesPerSecond)) + finite(latestValue(series.transmitBytesPerSecond)),
		);
		this.elem.querySelector('.clients-value').textContent = formatCount(latestValue(series.clients));
		this.elem.querySelector('.latency-value').textContent = `${formatCount(latestValue(series.latencyMs))}ms`;
		this.elem.querySelector('.offline-value').textContent = formatCount(latestValue(series.disconnectedDevices));

		renderMultiTrendChart(this.elem.querySelector('.traffic-chart'), [
			{ name: 'Down', color: '#38df55', points: series.receiveBytesPerSecond },
			{ name: 'Up', color: '#ffcf33', points: series.transmitBytesPerSecond },
		], { minimum: 0, label: 'UniFi network traffic over the last hour', valueFormatter: formatRateAxis });
		renderTrendChart(this.elem.querySelector('.clients-chart'), series.clients, {
			minimum: 0, label: 'Connected clients over the last hour',
		});
		renderTrendChart(this.elem.querySelector('.latency-chart'), series.latencyMs, {
			minimum: 0, label: 'WAN latency over the last hour', valueFormatter: (value) => `${Math.round(value)}ms`,
		});
		renderTrendChart(this.elem.querySelector('.offline-chart'), series.disconnectedDevices, {
			minimum: 0, label: 'Disconnected UniFi devices over the last hour',
		});
		super.drawCanvas();
	}
}

class UnifiWanPerformance extends ObservabilityDisplay {
	constructor() {
		super(observabilityNavId('unifi-wan'), 'unifi-wan-performance', 'UniFi WAN Performance', '/observability/unifi/wan-performance', 'wanPerformance');
	}

	drawCanvas() {
		const panel = this.data?.[this.screenIndex];
		if (!panel) return;
		const { series } = panel;
		const wanNames = new Set([
			...series.downloadUtilization.map(({ name }) => name),
			...series.uploadUtilization.map(({ name }) => name),
			...series.uptimePercent.map(({ name }) => name),
		]);
		const ping = latestValue(series.speedtestPingMs);
		const utilizationSeries = [
			...series.downloadUtilization.map((item) => ({ ...item, direction: 'Down' })),
			...series.uploadUtilization.map((item) => ({ ...item, direction: 'Up' })),
		];
		this.elem.querySelector('.entity-name').textContent = `${wanNames.size} WAN${wanNames.size === 1 ? '' : 's'} • ${formatCount(ping)}ms Ping`;
		this.elem.querySelector('.traffic-value').textContent = formatRateCompact(
			finite(latestValue(series.receiveBytesPerSecond)) + finite(latestValue(series.transmitBytesPerSecond)),
		);
		this.elem.querySelector('.capacity-value').textContent = formatPercent(latestMaximum(utilizationSeries));
		this.elem.querySelector('.uptime-value').textContent = formatPercent(latestMaximum(series.uptimePercent));
		this.elem.querySelector('.speedtest-value').textContent = `${formatCount(latestValue(series.speedtestDownloadMbps))}/${formatCount(latestValue(series.speedtestUploadMbps))}`;

		renderMultiTrendChart(this.elem.querySelector('.traffic-chart'), [
			{ name: 'Down', color: '#38df55', points: series.receiveBytesPerSecond },
			{ name: 'Up', color: '#ffcf33', points: series.transmitBytesPerSecond },
		], { minimum: 0, label: 'WAN traffic over the last hour', valueFormatter: formatRateAxis });
		renderMultiTrendChart(this.elem.querySelector('.capacity-chart'), coloredSeries(
			utilizationSeries,
			(item) => `${item.name} ${item.direction}`,
		), {
			minimum: 0, maximum: 100, label: 'WAN capacity utilization over the last hour', valueFormatter: (value) => `${Math.round(value)}%`,
		});
		renderMultiTrendChart(this.elem.querySelector('.uptime-chart'), coloredSeries(series.uptimePercent), {
			minimum: 0, maximum: 100, label: 'WAN uptime over the last hour', valueFormatter: (value) => `${Math.round(value)}%`,
		});
		renderMultiTrendChart(this.elem.querySelector('.speedtest-chart'), [
			{ name: 'Down', color: '#38df55', points: series.speedtestDownloadMbps },
			{ name: 'Up', color: '#ffcf33', points: series.speedtestUploadMbps },
		], { minimum: 0, label: 'UniFi speed tests over the last hour', valueFormatter: (value) => `${Math.round(value)}M` });
		super.drawCanvas();
	}
}

class UnifiWifiHealth extends ObservabilityDisplay {
	constructor() {
		super(observabilityNavId('unifi-wifi'), 'unifi-wifi-health', 'UniFi WiFi Health', '/observability/unifi/wifi-health', 'wifiHealth');
	}

	drawCanvas() {
		const panel = this.data?.[this.screenIndex];
		if (!panel) return;
		const { series } = panel;
		const wifiClients = latestSum(series.clientsByBand);
		const retries = latestValue(series.retriesPerSecond);
		this.elem.querySelector('.entity-name').textContent = `${formatCount(wifiClients)} WiFi Clients • ${finite(retries).toFixed(2)} Retry/s`;
		this.elem.querySelector('.signal-value').textContent = `${formatCount(latestValue(series.signalDbm))}dBm`;
		this.elem.querySelector('.satisfaction-value').textContent = formatPercent(latestValue(series.satisfactionPercent));
		this.elem.querySelector('.traffic-value').textContent = formatRateCompact(
			finite(latestValue(series.receiveBytesPerSecond)) + finite(latestValue(series.transmitBytesPerSecond)),
		);
		this.elem.querySelector('.band-value').textContent = `${series.clientsByBand.length} Bands`;

		renderTrendChart(this.elem.querySelector('.signal-chart'), series.signalDbm, {
			label: 'Average WiFi signal over the last hour', valueFormatter: (value) => `${Math.round(value)}dB`,
		});
		renderTrendChart(this.elem.querySelector('.satisfaction-chart'), series.satisfactionPercent, {
			minimum: 0, maximum: 100, label: 'WiFi satisfaction over the last hour', valueFormatter: (value) => `${Math.round(value)}%`,
		});
		renderMultiTrendChart(this.elem.querySelector('.traffic-chart'), [
			{ name: 'Down', color: '#38df55', points: series.receiveBytesPerSecond },
			{ name: 'Up', color: '#ffcf33', points: series.transmitBytesPerSecond },
		], { minimum: 0, label: 'WiFi client traffic over the last hour', valueFormatter: formatRateAxis });
		renderMultiTrendChart(this.elem.querySelector('.band-chart'), coloredSeries(series.clientsByBand), {
			minimum: 0, label: 'WiFi clients by radio band over the last hour',
		});
		super.drawCanvas();
	}
}

class UnifiDeviceHealth extends ObservabilityDisplay {
	constructor() {
		super(observabilityNavId('unifi-devices'), 'unifi-device-health', 'UniFi Device Health', '/observability/unifi/device-health', 'deviceHealth');
	}

	drawCanvas() {
		const device = this.data?.[this.screenIndex];
		if (!device) return;
		const { series } = device;
		this.elem.querySelector('.entity-name').textContent = `${device.name} • ${device.type.toUpperCase()}`;
		this.elem.querySelector('.cpu-value').textContent = formatPercent(latestValue(series.cpuPercent));
		this.elem.querySelector('.memory-value').textContent = formatPercent(latestValue(series.memoryPercent));
		this.elem.querySelector('.temperature-value').textContent = `${formatCount(latestValue(series.temperatureC))}°C`;
		this.elem.querySelector('.uptime-value').textContent = `Up ${formatDuration(latestValue(series.uptimeSeconds))}`;

		renderTrendChart(this.elem.querySelector('.cpu-chart'), series.cpuPercent, {
			minimum: 0, maximum: 100, label: 'UniFi device CPU over the last hour', valueFormatter: (value) => `${Math.round(value)}%`,
		});
		renderTrendChart(this.elem.querySelector('.memory-chart'), series.memoryPercent, {
			minimum: 0, maximum: 100, label: 'UniFi device memory over the last hour', valueFormatter: (value) => `${Math.round(value)}%`,
		});
		renderTrendChart(this.elem.querySelector('.temperature-chart'), series.temperatureC, {
			label: 'UniFi device temperature over the last hour', valueFormatter: (value) => `${value.toFixed(1)}°`,
		});
		renderMultiTrendChart(this.elem.querySelector('.traffic-chart'), [
			{ name: 'Down', color: '#38df55', points: series.receiveBytesPerSecond },
			{ name: 'Up', color: '#ffcf33', points: series.transmitBytesPerSecond },
		], { minimum: 0, label: 'UniFi device traffic over the last hour', valueFormatter: formatRateAxis });
		super.drawCanvas();
	}
}

class UnifiSwitchPoe extends ObservabilityDisplay {
	constructor() {
		super(observabilityNavId('unifi-switches'), 'unifi-switch-poe', 'UniFi Switch and PoE', '/observability/unifi/switch-ports', 'switchPorts');
		this.pageSize = 8;
	}

	drawCanvas() {
		const ports = this.data?.[this.screenIndex];
		if (!ports) return;
		const activeCount = this.rawData.filter(({ speedBps }) => speedBps > 0).length;
		const poeWatts = this.rawData.reduce((sum, port) => sum + finite(port.poeWatts), 0);
		this.elem.querySelector('.page-label').textContent = this.data.length > 1
			? `Switch Ports  ${this.screenIndex + 1}/${this.data.length}`
			: 'Switch Ports';
		this.elem.querySelector('.port-summary').textContent = `${activeCount}/${this.rawData.length} Up • ${poeWatts.toFixed(1)}W`;
		const rows = this.elem.querySelector('.status-list-rows');
		rows.innerHTML = '';
		ports.forEach((port) => {
			const row = document.createElement('div');
			row.className = 'status-list-row switch-columns';
			const detail = `${port.device}${port.errors > 0 ? ` • ${formatCount(port.errors)} Errors` : ''}`;
			row.append(
				primaryValue(port.portName, detail),
				textElement(`state-value ${port.speedBps > 0 ? 'state-online' : 'state-offline'}`, formatLinkSpeed(port.speedBps)),
				textElement('poe-value', Number.isFinite(port.poeWatts) && port.poeWatts > 0 ? `${port.poeWatts.toFixed(1)}W` : ''),
			);
			rows.append(row);
		});
		super.drawCanvas();
	}
}

class UnifiTrafficInsights extends ObservabilityDisplay {
	constructor() {
		super(observabilityNavId('unifi-traffic'), 'unifi-traffic-insights', 'UniFi Traffic Insights', '/observability/unifi/traffic-insights', 'trafficInsights');
		this.pageSize = 8;
	}

	drawCanvas() {
		const insights = this.data?.[this.screenIndex];
		if (!insights) return;
		const kind = insights[0]?.kind ?? 'Application';
		this.elem.querySelector('.page-label').textContent = `Top ${kind}s`;
		this.elem.querySelector('.traffic-summary').textContent = formatRate(this.response?.totalBytesPerSecond);
		const rows = this.elem.querySelector('.status-list-rows');
		rows.innerHTML = '';
		insights.forEach((item) => {
			const row = document.createElement('div');
			row.className = 'status-list-row traffic-columns';
			row.append(
				primaryValue(item.name, item.detail),
				textElement('rate-value', formatRate(item.bytesPerSecond)),
				textElement('share-value', formatPercent(item.share * 100)),
			);
			rows.append(row);
		});
		super.drawCanvas();
	}
}

class UnifiNetworkCapacity extends ObservabilityDisplay {
	constructor() {
		super(observabilityNavId('unifi-capacity'), 'unifi-network-capacity', 'UniFi Network Capacity', '/observability/unifi/network-capacity', 'networkCapacity');
	}

	drawCanvas() {
		const panel = this.data?.[this.screenIndex];
		if (!panel) return;
		const { series } = panel;
		const unknownSwitch = latestValue(series.unknownSwitch) >= 0.5;
		const activeLeases = latestValue(series.activeLeases);
		const availableIps = latestValue(series.availableIps);
		const connectionCount = finite(latestValue(series.wiredClients)) + finite(latestValue(series.wirelessClients));
		this.elem.querySelector('.entity-name').textContent = `${series.dhcpUtilizationPercent.length} Networks • ${unknownSwitch ? 'Unknown Switch' : 'Topology Healthy'}`;
		this.elem.querySelector('.dhcp-value').textContent = formatPercent(latestMaximum(series.dhcpUtilizationPercent));
		this.elem.querySelector('.lease-value').textContent = `${formatCount(activeLeases)}/${formatCount(finite(activeLeases) + finite(availableIps))}`;
		this.elem.querySelector('.link-value').textContent = formatPercent(latestValue(series.linkExperiencePercent));
		this.elem.querySelector('.connection-value').textContent = formatCount(connectionCount);

		renderMultiTrendChart(this.elem.querySelector('.dhcp-chart'), coloredSeries(series.dhcpUtilizationPercent), {
			minimum: 0, maximum: 100, label: 'DHCP utilization by network over the last hour', valueFormatter: (value) => `${Math.round(value)}%`,
		});
		renderMultiTrendChart(this.elem.querySelector('.lease-chart'), [
			{ name: 'Active', color: '#38df55', points: series.activeLeases },
			{ name: 'Free', color: 'aqua', points: series.availableIps },
		], { minimum: 0, label: 'DHCP active and available addresses over the last hour' });
		renderTrendChart(this.elem.querySelector('.link-chart'), series.linkExperiencePercent, {
			minimum: 0, maximum: 100, label: 'Topology link experience over the last hour', valueFormatter: (value) => `${Math.round(value)}%`,
		});
		renderMultiTrendChart(this.elem.querySelector('.connection-chart'), [
			{ name: 'Wired', color: 'aqua', points: series.wiredClients },
			{ name: 'WiFi', color: '#d66bff', points: series.wirelessClients },
		], { minimum: 0, label: 'Wired and wireless client counts over the last hour' });
		super.drawCanvas();
	}
}

if (window.WS4KP_OBSERVABILITY?.prometheus) {
	registerDisplay(new UnifiNetworkOverview());
	registerDisplay(new UnifiWanPerformance());
	registerDisplay(new UnifiWifiHealth());
	registerDisplay(new UnifiDeviceHealth());
	registerDisplay(new UnifiSwitchPoe());
	registerDisplay(new UnifiTrafficInsights());
	registerDisplay(new UnifiNetworkCapacity());
}

export {
	formatDuration,
	formatLinkSpeed,
	formatRate,
	formatRateAxis,
	UnifiDeviceHealth,
	UnifiNetworkCapacity,
	UnifiNetworkOverview,
	UnifiSwitchPoe,
	UnifiTrafficInsights,
	UnifiWanPerformance,
	UnifiWifiHealth,
};
