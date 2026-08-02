import { registerDisplay } from './navigation.mjs';
import ObservabilityDisplay from './observability-display.mjs';
import { latestValue, renderTrendChart } from './observability-chart.mjs';

const formatCount = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString() : 'N/A');

class ReverseProxyInformation extends ObservabilityDisplay {
	constructor(navId = 13) {
		super(navId, 'reverse-proxy-information', 'Reverse Proxy Information', '/observability/reverse-proxy', 'upstreams');
	}

	drawCanvas() {
		const upstream = this.data?.[this.screenIndex];
		if (!upstream) return;

		this.elem.querySelector('.entity-name').textContent = upstream.upstream;
		this.elem.querySelector('.log-count').textContent = formatCount(latestValue(upstream.points));
		renderTrendChart(this.elem.querySelector('.log-chart'), upstream.points, {
			minimum: 0, label: 'Requests per hour over the last hour',
		});
		super.drawCanvas();
	}
}

if (window.WS4KP_OBSERVABILITY?.loki) {
	const navId = window.WS4KP_OBSERVABILITY.prometheus ? 13 : 12;
	registerDisplay(new ReverseProxyInformation(navId));
}

export { formatCount, ReverseProxyInformation };
