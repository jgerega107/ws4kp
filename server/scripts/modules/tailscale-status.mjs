import { registerDisplay } from './navigation.mjs';
import ObservabilityDisplay, { observabilityNavId } from './observability-display.mjs';

const textElement = (className, value) => {
	const element = document.createElement('span');
	element.className = className;
	element.textContent = value;
	return element;
};

const nodeName = (node) => {
	const element = document.createElement('span');
	element.className = 'primary-value';
	element.append(textElement('', node.name));
	if (node.roles?.length) {
		const roles = document.createElement('small');
		roles.textContent = node.roles.join(' / ');
		element.append(roles);
	}
	return element;
};

class TailscaleStatus extends ObservabilityDisplay {
	constructor() {
		super(observabilityNavId('tailscale'), 'tailscale-status', 'Tailscale Status', '/observability/tailscale', 'nodes');
		this.pageSize = 8;
	}

	drawCanvas() {
		const nodes = this.data?.[this.screenIndex];
		if (!nodes) return;

		const onlineCount = this.rawData.filter((node) => node.online).length;
		this.elem.querySelector('.online-summary').textContent = `${onlineCount}/${this.rawData.length} Online`;
		this.elem.querySelector('.page-label').textContent = this.data.length > 1
			? `Tailnet Devices  ${this.screenIndex + 1}/${this.data.length}`
			: 'Tailnet Devices';

		const rows = this.elem.querySelector('.status-list-rows');
		rows.innerHTML = '';
		nodes.forEach((node) => {
			const row = document.createElement('div');
			row.className = 'status-list-row tailscale-columns';
			row.append(
				nodeName(node),
				textElement(`state-value ${node.online ? 'state-online' : 'state-offline'}`, node.online ? 'ONLINE' : 'OFFLINE'),
				textElement('version-value', node.version || ''),
			);
			rows.append(row);
		});
		super.drawCanvas();
	}
}

if (window.WS4KP_OBSERVABILITY?.tailscale) registerDisplay(new TailscaleStatus());

export default TailscaleStatus;
