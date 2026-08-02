const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const WIDTH = 240;
const HEIGHT = 72;

const svgElement = (name, attributes = {}) => {
	const element = document.createElementNS(SVG_NAMESPACE, name);
	Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
	return element;
};

const textElement = (className, value) => {
	const element = document.createElement('span');
	element.className = className;
	element.textContent = value;
	return element;
};

const formatTime = (timestamp) => new Date(timestamp * 1000).toLocaleTimeString([], {
	hour: 'numeric',
}).replaceAll(' ', '')
	.toLowerCase()
	.replace(/([ap])m$/, '$1');

const renderTrendSeries = (container, rawSeries, options = {}) => {
	container.innerHTML = '';
	const series = rawSeries.map((item) => ({
		...item,
		points: (item.points ?? []).filter(([timestamp, value]) => Number.isFinite(timestamp) && Number.isFinite(value)),
	})).filter((item) => item.points.length > 0);
	const allPoints = series.flatMap((item) => item.points);
	if (allPoints.length === 0) {
		const noData = document.createElement('div');
		noData.className = 'chart-no-data';
		noData.textContent = 'No Data';
		container.append(noData);
		return;
	}

	const timestamps = allPoints.map(([timestamp]) => timestamp);
	const values = allPoints.map(([, value]) => value);
	const firstTimestamp = Math.min(...timestamps);
	const lastTimestamp = Math.max(...timestamps);
	const timestampRange = Math.max(1, lastTimestamp - firstTimestamp);
	let minimum = options.minimum ?? Math.min(...values);
	let maximum = options.maximum ?? Math.max(...values);

	if (minimum === maximum) {
		const padding = Math.max(1, Math.abs(minimum) * 0.1);
		if (options.minimum !== undefined && options.maximum === undefined) {
			maximum += padding;
		} else if (options.maximum !== undefined && options.minimum === undefined) {
			minimum -= padding;
		} else {
			minimum -= padding;
			maximum += padding;
		}
	}
	const valueRange = maximum - minimum;
	const coordinatesFor = (points) => points.map(([timestamp, value]) => {
		const x = ((timestamp - firstTimestamp) / timestampRange) * WIDTH;
		const y = HEIGHT - ((value - minimum) / valueRange) * HEIGHT;
		return [x, Math.max(0, Math.min(HEIGHT, y))];
	});

	const yAxis = document.createElement('div');
	yAxis.className = 'chart-y-axis';
	const valueFormatter = options.valueFormatter ?? ((value) => Math.round(value).toLocaleString());
	[maximum, minimum + valueRange / 2, minimum].forEach((value) => {
		yAxis.append(textElement('axis-label', valueFormatter(value)));
	});

	const plot = document.createElement('div');
	plot.className = 'chart-plot';
	const svg = svgElement('svg', {
		viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
		preserveAspectRatio: 'none',
		role: 'img',
		'aria-label': options.label ?? 'One hour trend',
	});
	[0, 0.5, 1].forEach((position) => {
		svg.append(svgElement('line', {
			x1: 0, y1: HEIGHT * position, x2: WIDTH, y2: HEIGHT * position, class: 'chart-grid-line',
		}));
		svg.append(svgElement('line', {
			x1: WIDTH * position, y1: 0, x2: WIDTH * position, y2: HEIGHT, class: 'chart-grid-line',
		}));
	});

	const renderedSeries = series.map((item) => ({
		...item,
		coordinateText: coordinatesFor(item.points).map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' '),
	}));
	if (renderedSeries.length === 1) {
		svg.append(svgElement('polygon', {
			points: `0,${HEIGHT} ${renderedSeries[0].coordinateText} ${WIDTH},${HEIGHT}`,
			class: 'chart-area',
		}));
	}
	renderedSeries.forEach((item) => {
		svg.append(svgElement('polyline', {
			points: item.coordinateText,
			class: 'chart-line-shadow',
		}));
	});
	renderedSeries.forEach((item) => {
		const attributes = {
			points: item.coordinateText,
			class: 'chart-line',
		};
		if (item.color) attributes.style = `stroke: ${item.color}`;
		svg.append(svgElement('polyline', attributes));
	});
	plot.append(svg);

	const xAxis = document.createElement('div');
	xAxis.className = 'chart-x-axis';
	[firstTimestamp, firstTimestamp + timestampRange / 2, lastTimestamp].forEach((timestamp) => {
		xAxis.append(textElement('axis-label', formatTime(timestamp)));
	});

	const legendItems = renderedSeries.filter((item) => item.name);
	if (legendItems.length > 0) {
		const legend = document.createElement('div');
		legend.className = 'chart-legend';
		legendItems.forEach((item) => {
			const legendItem = document.createElement('span');
			legendItem.className = 'chart-legend-item';
			legendItem.title = item.name;
			const swatch = document.createElement('span');
			swatch.className = 'chart-legend-swatch';
			swatch.style.backgroundColor = item.color;
			legendItem.append(swatch, textElement('chart-legend-label', item.name));
			legend.append(legendItem);
		});
		container.append(legend);
	}

	container.append(yAxis, plot, xAxis);
};

const renderTrendChart = (container, rawPoints, options = {}) => renderTrendSeries(container, [{ points: rawPoints }], options);

const renderMultiTrendChart = (container, series, options = {}) => renderTrendSeries(container, series, options);

const latestValue = (points) => {
	const point = points?.at(-1);
	return Number.isFinite(point?.[1]) ? point[1] : null;
};

export { latestValue, renderMultiTrendChart, renderTrendChart };
