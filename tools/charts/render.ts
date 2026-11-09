// Draws a timing chart as plain SVG: one row per set of samples, every sample a dot, the median a tick, and the 10th to 90th percentile a band behind the
// dots. Pure and deterministic (no random jitter, no dates, fixed number formats), so the same data always gives the same bytes and a test can rebuild every
// committed chart and compare. The card has its own dark background, so it reads the same on a light page, a dark page and in a README.
import { median, quantile } from "../../scripts/lib/stats.ts";

export interface ChartRow {
	label: string;
	/** A second line under the label, for example the median. */
	detail: string;
	samples: readonly number[];
	/** The colour of the row's dots and tick. */
	color: string;
}

export interface ChartSpec {
	title: string;
	subtitle: string;
	/** The unit written on the axis, for example "ms". */
	unit: string;
	rows: readonly ChartRow[];
}

const WIDTH = 760;
const PLOT_LEFT = 230;
const PLOT_RIGHT = 730;
const TOP = 78;
const ROW_HEIGHT = 62;
const AXIS_GAP = 12;
const FONT = '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif';

const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

/** The gap between axis ticks: the smallest round step that gives no more than seven ticks up to `max`. */
export function tickStep(max: number): number {
	return STEPS.find((step) => max / step <= 7) ?? 2000;
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fixed = (value: number) => value.toFixed(1);

/** The SVG of the chart. Every row shares one axis that starts at zero, so a difference looks as large as it is. */
export function renderChart(spec: ChartSpec): string {
	const all = spec.rows.flatMap((row) => [...row.samples]);
	const step = tickStep(Math.max(...all, 1));
	const max = Math.ceil((Math.max(...all, 1) * 1.04) / step) * step;
	const x = (value: number) => PLOT_LEFT + (value / max) * (PLOT_RIGHT - PLOT_LEFT);
	const plotBottom = TOP + spec.rows.length * ROW_HEIGHT;
	const height = plotBottom + AXIS_GAP + 44;
	const parts: string[] = [];
	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-labelledby="chart-title chart-desc" font-family='${FONT}'>`,
	);
	parts.push(`<title id="chart-title">${escapeXml(spec.title)}</title>`);
	parts.push(
		`<desc id="chart-desc">${escapeXml(spec.subtitle)} ${spec.rows
			.map((row) => `${row.label}: ${row.detail}.`)
			.map(escapeXml)
			.join(" ")}</desc>`,
	);
	parts.push(`<rect width="${WIDTH}" height="${height}" rx="12" fill="#1a2431"/>`);
	parts.push(`<text x="24" y="34" font-size="18" font-weight="600" fill="#f1e6cf">${escapeXml(spec.title)}</text>`);
	parts.push(`<text x="24" y="56" font-size="13" fill="#9aa7b5">${escapeXml(spec.subtitle)}</text>`);
	for (let tick = 0; tick <= max; tick += step) {
		const at = fixed(x(tick));
		parts.push(`<line x1="${at}" y1="${TOP - 6}" x2="${at}" y2="${plotBottom}" stroke="#33414f" stroke-width="1"/>`);
		parts.push(`<text x="${at}" y="${plotBottom + AXIS_GAP + 14}" font-size="12" text-anchor="middle" fill="#9aa7b5">${tick}</text>`);
	}
	parts.push(`<text x="${PLOT_RIGHT}" y="${plotBottom + AXIS_GAP + 36}" font-size="12" text-anchor="end" fill="#9aa7b5">${escapeXml(spec.unit)}</text>`);
	spec.rows.forEach((row, index) => {
		const middle = TOP + index * ROW_HEIGHT + ROW_HEIGHT / 2;
		parts.push(`<text x="24" y="${fixed(middle - 4)}" font-size="14" fill="#f1e6cf">${escapeXml(row.label)}</text>`);
		parts.push(`<text x="24" y="${fixed(middle + 15)}" font-size="12" fill="#9aa7b5">${escapeXml(row.detail)}</text>`);
		const low = quantile(row.samples, 0.1);
		const high = quantile(row.samples, 0.9);
		parts.push(
			`<rect x="${fixed(x(low))}" y="${fixed(middle - 15)}" width="${fixed(Math.max(2, x(high) - x(low)))}" height="30" rx="4" fill="${row.color}" fill-opacity="0.18"/>`,
		);
		row.samples.forEach((sample, position) => {
			// A fixed vertical spread by position, so the dots of equal values do not hide each other and nothing is random.
			const offset = ((position * 7) % 11) - 5;
			parts.push(`<circle cx="${fixed(x(sample))}" cy="${fixed(middle + offset * 2)}" r="2.6" fill="${row.color}" fill-opacity="0.85"/>`);
		});
		const center = fixed(x(median(row.samples)));
		parts.push(
			`<line x1="${center}" y1="${fixed(middle - 19)}" x2="${center}" y2="${fixed(middle + 19)}" stroke="#f1e6cf" stroke-width="2.5" stroke-linecap="round"/>`,
		);
	});
	parts.push("</svg>");
	return `${parts.join("\n")}\n`;
}
