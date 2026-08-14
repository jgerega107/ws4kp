import { registerDisplay } from './navigation.mjs';
import ObservabilityDisplay, { observabilityNavId } from './observability-display.mjs';
import {
	latestValue, renderMultiTrendChart, renderTrendChart,
} from './observability-chart.mjs';

const DISK_COLORS = ['aqua', '#38df55', '#ff3b30', '#ffcf33', '#d66bff', 'white', '#ff8a30', '#4aa3ff'];
const diskColor = (index) => DISK_COLORS[index] ?? `hsl(${Math.round(index * 137.508) % 360} 85% 65%)`;

const formatPercent = (value) => (Number.isFinite(value) ? `${value.toFixed(1)}%` : 'N/A');
const formatGigabytes = (value) => {
	if (!Number.isFinite(value)) return 'N/A';
	const digits = value > 0 && value < 10 ? 1 : 0;
	return `${value.toFixed(digits)} GB`;
};
const formatStorage = (value) => {
	if (!Number.isFinite(value)) return 'N/A';
	if (value < 1024) return formatGigabytes(value);
	return `${(value / 1024).toFixed(1)} TB`;
};

const formatInstance = (value) => value.replace(/:\d+$/, '');
const formatDiskName = (disk) => disk.mountpoint;

class SystemInformation extends ObservabilityDisplay {
	constructor() {
		super(observabilityNavId('system'), 'system-information', 'System Information', '/observability/system', 'instances');
	}

	drawCanvas() {
		const instance = this.data?.[this.screenIndex];
		if (!instance) return;
		const { series } = instance;

		this.elem.querySelector('.entity-name').textContent = formatInstance(instance.instance);
		this.elem.querySelector('.cpu-value').textContent = formatPercent(latestValue(series.cpuPercent));
		this.elem.querySelector('.memory-value').textContent = formatPercent(latestValue(series.memoryPercent));
		this.elem.querySelector('.disk-count').textContent = `${series.disks.length} Disk${series.disks.length === 1 ? '' : 's'}`;
		const temperature = latestValue(series.temperatureC);
		const memoryCapacityGb = latestValue(series.memoryTotalGb);
		const diskCapacities = series.disks.map((disk) => disk.capacityGb).filter(Number.isFinite);
		const largestDiskCapacityGb = diskCapacities.length > 0 ? Math.max(...diskCapacities) : undefined;
		this.elem.querySelector('.temperature-value').textContent = Number.isFinite(temperature)
			? `${temperature.toFixed(1)}°C`
			: 'N/A';

		renderTrendChart(this.elem.querySelector('.cpu-chart'), series.cpuPercent, {
			minimum: 0, maximum: 100, label: 'CPU usage over the last hour', valueFormatter: (value) => `${Math.round(value)}%`,
		});
		renderTrendChart(this.elem.querySelector('.memory-chart'), series.memoryUsedGb, {
			minimum: 0,
			maximum: Number.isFinite(memoryCapacityGb) ? memoryCapacityGb : undefined,
			label: 'Memory usage in gigabytes over the last hour',
			valueFormatter: formatGigabytes,
		});
		renderMultiTrendChart(this.elem.querySelector('.disk-chart'), series.disks.map((disk, index) => ({
			name: formatDiskName(disk),
			color: diskColor(index),
			points: disk.usedGb,
		})), {
			minimum: 0,
			maximum: largestDiskCapacityGb,
			label: 'Disk usage in gigabytes over the last hour',
			valueFormatter: formatStorage,
		});
		renderTrendChart(this.elem.querySelector('.temperature-chart'), series.temperatureC, {
			label: 'Temperature over the last hour', valueFormatter: (value) => `${Math.round(value)}°`,
		});

		super.drawCanvas();
	}
}

if (window.WS4KP_OBSERVABILITY?.prometheus) registerDisplay(new SystemInformation());

export {
	diskColor, formatDiskName, formatGigabytes, formatInstance, formatPercent, formatStorage, SystemInformation,
};
