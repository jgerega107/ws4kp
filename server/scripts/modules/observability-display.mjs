import STATUS from './status.mjs';
import { safeJson } from './utils/fetch.mjs';
import WeatherDisplay from './weatherdisplay.mjs';

const observabilityNavId = (displayName) => {
	const availability = window.WS4KP_OBSERVABILITY ?? {};
	const displays = [
		['system', availability.prometheus],
		['reverse-proxy', availability.loki],
		['tailscale', availability.tailscale],
		['alerts', availability.prometheus],
		['unifi-network', availability.prometheus],
		['unifi-wan', availability.prometheus],
		['unifi-wifi', availability.prometheus],
		['unifi-devices', availability.prometheus],
		['unifi-switches', availability.prometheus],
		['unifi-traffic', availability.prometheus],
		['unifi-capacity', availability.prometheus],
	].filter(([, available]) => available);
	const index = displays.findIndex(([name]) => name === displayName);
	return 12 + Math.max(0, index);
};

const paginate = (items, pageSize = 6) => {
	const pages = [];
	for (let index = 0; index < items.length; index += pageSize) {
		pages.push(items.slice(index, index + pageSize));
	}
	return pages;
};

class ObservabilityDisplay extends WeatherDisplay {
	constructor(navId, elemId, name, endpoint, responseKey) {
		super(navId, elemId, name, false);
		this.endpoint = endpoint;
		this.responseKey = responseKey;
		this.refreshTime = 60_000;
		this.pageSize = undefined;
		this.okToDrawCurrentConditions = false;
	}

	async getData(weatherParameters, refresh) {
		if (!super.getData(weatherParameters, refresh)) return;

		try {
			const response = await safeJson(this.endpoint, {
				retryCount: 1,
				stillWaiting: () => this.stillWaiting(),
			});
			const nextData = response?.[this.responseKey];

			if (!Array.isArray(nextData)) {
				if (this.data) {
					this.setStatus(STATUS.loaded);
				} else {
					this.setStatus(STATUS.failed);
				}
				return;
			}

			this.response = response;
			this.rawData = nextData;
			this.data = this.prepareData(nextData);
			if (!Array.isArray(this.data)) throw new Error(`Invalid ${this.name} display data`);
			this.timing.totalScreens = this.data.length;
			this.calcNavTiming();

			if (this.data.length === 0) {
				this.setStatus(STATUS.noData);
				return;
			}

			if (this.screenIndex < 0 || this.screenIndex >= this.data.length) this.screenIndex = 0;
			this.setStatus(STATUS.loaded);
			if (this.active) this.drawCanvas();
		} catch (error) {
			console.error(`Unexpected error getting ${this.name}: ${error.message}`);
			if (this.data) {
				this.setStatus(STATUS.loaded);
			} else {
				this.setStatus(STATUS.failed);
			}
		}
	}

	prepareData(data) {
		return this.pageSize ? paginate(data, this.pageSize) : data;
	}

	drawCanvas() {
		super.drawCanvas();
		this.finishDraw();
	}
}

export default ObservabilityDisplay;
export { observabilityNavId, paginate };
