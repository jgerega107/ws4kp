import STATUS from './status.mjs';
import { safeJson } from './utils/fetch.mjs';
import WeatherDisplay from './weatherdisplay.mjs';

class ObservabilityDisplay extends WeatherDisplay {
	constructor(navId, elemId, name, endpoint, responseKey) {
		super(navId, elemId, name, false);
		this.endpoint = endpoint;
		this.responseKey = responseKey;
		this.refreshTime = 60_000;
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

			this.data = nextData;
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

	drawCanvas() {
		super.drawCanvas();
		this.finishDraw();
	}
}

export default ObservabilityDisplay;
