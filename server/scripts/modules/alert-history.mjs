import { registerDisplay } from './navigation.mjs';
import ObservabilityDisplay, { observabilityNavId } from './observability-display.mjs';

const formatDuration = (seconds) => {
	const minutes = Math.max(1, Math.round(seconds / 60));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
};

const alertName = (alert) => {
	const element = document.createElement('span');
	element.className = 'primary-value';
	const name = document.createElement('span');
	name.textContent = alert.name;
	element.append(name);
	if (alert.source) {
		const source = document.createElement('small');
		source.textContent = alert.source;
		element.append(source);
	}
	return element;
};

class AlertHistory extends ObservabilityDisplay {
	constructor() {
		super(observabilityNavId('alerts'), 'alert-history', 'Prometheus Alert History', '/observability/alerts', 'alerts');
		this.pageSize = 8;
	}

	prepareData(data) {
		return data.length === 0 ? [[]] : super.prepareData(data);
	}

	drawCanvas() {
		const alerts = this.data?.[this.screenIndex];
		if (!alerts) return;

		const firingCount = this.rawData.filter((alert) => alert.currentlyFiring).length;
		this.elem.querySelector('.alert-summary').textContent = `${firingCount} Active / ${this.rawData.length} Total`;
		const rows = this.elem.querySelector('.status-list-rows');
		rows.innerHTML = '';
		if (alerts.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'status-list-empty';
			empty.textContent = 'No Alerts';
			rows.append(empty);
		}
		alerts.forEach((alert) => {
			const row = document.createElement('div');
			row.className = 'status-list-row alert-columns';
			const state = document.createElement('span');
			state.className = `state-value ${alert.currentlyFiring ? 'state-firing' : 'state-cleared'}`;
			state.textContent = alert.currentlyFiring ? 'FIRING' : 'CLEARED';
			const duration = document.createElement('span');
			duration.className = 'duration-value';
			duration.textContent = formatDuration(alert.durationSeconds);
			row.append(alertName(alert), state, duration);
			rows.append(row);
		});
		super.drawCanvas();
	}
}

if (window.WS4KP_OBSERVABILITY?.prometheus) registerDisplay(new AlertHistory());

export { AlertHistory, formatDuration };
