import { registerDisplay } from './navigation.mjs';
import ObservabilityDisplay, { observabilityNavId } from './observability-display.mjs';
import { latestValue, renderMultiTrendChart } from './observability-chart.mjs';

const formatCount = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString() : 'N/A');

class ReverseProxyInformation extends ObservabilityDisplay {
	constructor() {
		super(observabilityNavId('reverse-proxy'), 'reverse-proxy-information', 'Request Volume per Host', '/observability/reverse-proxy', 'upstreams');
	}

	drawCanvas() {
		const upstream = this.data?.[this.screenIndex];
		if (!upstream) return;

		this.elem.querySelector('.entity-name').textContent = upstream.upstream;
		this.elem.querySelector('.log-count').textContent = formatCount(latestValue(upstream.totalPoints));
		renderMultiTrendChart(this.elem.querySelector('.log-chart'), [
			{ name: '2xx/3xx', color: '#38df55', points: upstream.successfulPoints },
			{ name: '4xx/5xx', color: '#ff3b30', points: upstream.errorPoints },
		], {
			minimum: 0, label: 'Successful and error responses per minute over the last hour',
		});
		super.drawCanvas();
	}
}

if (window.WS4KP_OBSERVABILITY?.loki) {
	registerDisplay(new ReverseProxyInformation());
}

export { formatCount, ReverseProxyInformation };
