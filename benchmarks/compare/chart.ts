// RFC 013 §4.13.5 — inline-SVG chart primitives. Zero deps; embeds in a
// self-contained HTML file so the report opens in any browser without a CDN.
//
// Three chart types: histogram, line chart, stacked bar. All return XML strings
// with no external defs/scripts. Axes drawn manually (no d3); text uses CSS
// classes from the report stylesheet.

export interface ChartDimensions {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
}

const DEFAULT_DIM: ChartDimensions = {
  width: 480,
  height: 240,
  margin: { top: 20, right: 16, bottom: 32, left: 48 },
};

export interface SeriesPoint {
  x: number;
  y: number;
}

export interface NamedSeries {
  name: string;
  color: string;
  points: SeriesPoint[];
}

export interface HistogramBucket {
  label: string;
  values: { name: string; color: string; value: number }[];
}

/**
 * Bar chart of latency percentiles or similar. Each bucket has one bar per
 * series, side-by-side.
 */
export function renderBarChart(
  buckets: HistogramBucket[],
  options: { title?: string; yLabel?: string; dim?: Partial<ChartDimensions> } = {},
): string {
  const dim = mergeDim(options.dim);
  const innerW = dim.width - dim.margin.left - dim.margin.right;
  const innerH = dim.height - dim.margin.top - dim.margin.bottom;
  const allValues = buckets.flatMap((b) => b.values.map((v) => v.value));
  const yMax = niceMax(allValues);
  const seriesCount = buckets[0]?.values.length ?? 1;
  const groupGap = 8;
  const groupW = (innerW - (buckets.length - 1) * groupGap) / Math.max(1, buckets.length);
  const barW = groupW / seriesCount;

  const bars: string[] = [];
  buckets.forEach((bucket, i) => {
    const groupX = dim.margin.left + i * (groupW + groupGap);
    bucket.values.forEach((v, j) => {
      const x = groupX + j * barW;
      const h = yMax > 0 ? (v.value / yMax) * innerH : 0;
      const y = dim.margin.top + innerH - h;
      bars.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${escAttr(v.color)}"><title>${escText(v.name)}: ${formatNumber(v.value)}</title></rect>`);
    });
  });

  const xLabels = buckets.map((bucket, i) => {
    const groupX = dim.margin.left + i * (groupW + groupGap) + groupW / 2;
    return `<text x="${groupX.toFixed(1)}" y="${(dim.margin.top + innerH + 14).toFixed(1)}" class="axis-tick" text-anchor="middle">${escText(bucket.label)}</text>`;
  }).join('');

  const yTicks = renderYAxis(dim, yMax, options.yLabel);

  return wrapSvg(dim, [
    options.title ? `<text x="${(dim.width / 2).toFixed(1)}" y="14" class="chart-title" text-anchor="middle">${escText(options.title)}</text>` : '',
    yTicks,
    ...bars,
    xLabels,
  ]);
}

/**
 * Line chart for throughput-vs-concurrency or similar trend data.
 */
export function renderLineChart(
  series: NamedSeries[],
  options: { title?: string; xLabel?: string; yLabel?: string; dim?: Partial<ChartDimensions> } = {},
): string {
  const dim = mergeDim(options.dim);
  const innerW = dim.width - dim.margin.left - dim.margin.right;
  const innerH = dim.height - dim.margin.top - dim.margin.bottom;
  const allX = series.flatMap((s) => s.points.map((p) => p.x));
  const allY = series.flatMap((s) => s.points.map((p) => p.y));
  const xMax = niceMax(allX);
  const yMax = niceMax(allY);
  const xMin = Math.min(0, ...allX);

  const project = (p: SeriesPoint) => {
    const x = dim.margin.left + ((p.x - xMin) / (xMax - xMin || 1)) * innerW;
    const y = dim.margin.top + innerH - (yMax > 0 ? (p.y / yMax) * innerH : 0);
    return { x, y };
  };

  const lines = series.map((s) => {
    const path = s.points.map((p, i) => {
      const { x, y } = project(p);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    const dots = s.points.map((p) => {
      const { x, y } = project(p);
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${escAttr(s.color)}"><title>${escText(s.name)} @ ${p.x}: ${formatNumber(p.y)}</title></circle>`;
    }).join('');
    return `<path d="${path}" fill="none" stroke="${escAttr(s.color)}" stroke-width="2"/>${dots}`;
  }).join('');

  const yAxis = renderYAxis(dim, yMax, options.yLabel);
  const xAxis = renderXAxisNumeric(dim, xMin, xMax, options.xLabel);

  return wrapSvg(dim, [
    options.title ? `<text x="${(dim.width / 2).toFixed(1)}" y="14" class="chart-title" text-anchor="middle">${escText(options.title)}</text>` : '',
    yAxis,
    xAxis,
    lines,
  ]);
}

/**
 * Stacked-bar comparison (e.g., vector-binary vs docstore per model).
 */
export function renderStackedBar(
  bars: { label: string; segments: { name: string; color: string; value: number }[] }[],
  options: { title?: string; yLabel?: string; dim?: Partial<ChartDimensions> } = {},
): string {
  const dim = mergeDim(options.dim);
  const innerW = dim.width - dim.margin.left - dim.margin.right;
  const innerH = dim.height - dim.margin.top - dim.margin.bottom;
  const totals = bars.map((b) => b.segments.reduce((sum, s) => sum + s.value, 0));
  const yMax = niceMax(totals);
  const gap = 16;
  const barW = (innerW - (bars.length - 1) * gap) / Math.max(1, bars.length);

  const rects: string[] = [];
  bars.forEach((bar, i) => {
    const x = dim.margin.left + i * (barW + gap);
    let yCursor = dim.margin.top + innerH;
    bar.segments.forEach((seg) => {
      const h = yMax > 0 ? (seg.value / yMax) * innerH : 0;
      yCursor -= h;
      rects.push(`<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${escAttr(seg.color)}"><title>${escText(seg.name)}: ${formatBytes(seg.value)}</title></rect>`);
    });
  });

  const xLabels = bars.map((bar, i) => {
    const x = dim.margin.left + i * (barW + gap) + barW / 2;
    return `<text x="${x.toFixed(1)}" y="${(dim.margin.top + innerH + 14).toFixed(1)}" class="axis-tick" text-anchor="middle">${escText(bar.label)}</text>`;
  }).join('');

  const yAxis = renderYAxis(dim, yMax, options.yLabel, formatBytes);

  return wrapSvg(dim, [
    options.title ? `<text x="${(dim.width / 2).toFixed(1)}" y="14" class="chart-title" text-anchor="middle">${escText(options.title)}</text>` : '',
    yAxis,
    ...rects,
    xLabels,
  ]);
}

/**
 * Legend block. Plain HTML; sits next to or below a chart.
 */
export function renderLegend(items: { name: string; color: string }[]): string {
  const dots = items.map(
    (i) => `<span class="legend-item"><span class="legend-dot" style="background:${escAttr(i.color)}"></span>${escText(i.name)}</span>`,
  ).join('');
  return `<div class="legend">${dots}</div>`;
}

// ---- internals ----

function mergeDim(partial?: Partial<ChartDimensions>): ChartDimensions {
  return {
    width: partial?.width ?? DEFAULT_DIM.width,
    height: partial?.height ?? DEFAULT_DIM.height,
    margin: { ...DEFAULT_DIM.margin, ...(partial?.margin ?? {}) },
  };
}

function wrapSvg(dim: ChartDimensions, children: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim.width} ${dim.height}" class="chart">${children.filter(Boolean).join('')}</svg>`;
}

function renderYAxis(
  dim: ChartDimensions,
  yMax: number,
  yLabel?: string,
  formatter: (v: number) => string = formatNumber,
): string {
  const innerH = dim.height - dim.margin.top - dim.margin.bottom;
  const ticks = niceTicks(yMax, 4);
  const tickLines = ticks.map((tick) => {
    const y = dim.margin.top + innerH - (yMax > 0 ? (tick / yMax) * innerH : 0);
    return `<line x1="${dim.margin.left}" y1="${y.toFixed(1)}" x2="${(dim.width - dim.margin.right).toFixed(1)}" y2="${y.toFixed(1)}" class="grid-line"/><text x="${(dim.margin.left - 4).toFixed(1)}" y="${(y + 3).toFixed(1)}" class="axis-tick" text-anchor="end">${escText(formatter(tick))}</text>`;
  }).join('');
  const label = yLabel
    ? `<text x="12" y="${(dim.margin.top + innerH / 2).toFixed(1)}" class="axis-label" text-anchor="middle" transform="rotate(-90 12 ${(dim.margin.top + innerH / 2).toFixed(1)})">${escText(yLabel)}</text>`
    : '';
  return tickLines + label;
}

function renderXAxisNumeric(dim: ChartDimensions, xMin: number, xMax: number, xLabel?: string): string {
  const innerW = dim.width - dim.margin.left - dim.margin.right;
  const innerH = dim.height - dim.margin.top - dim.margin.bottom;
  const ticks = niceTicks(xMax - xMin, 4).map((t) => xMin + t);
  const tickMarks = ticks.map((tick) => {
    const x = dim.margin.left + ((tick - xMin) / (xMax - xMin || 1)) * innerW;
    return `<text x="${x.toFixed(1)}" y="${(dim.margin.top + innerH + 14).toFixed(1)}" class="axis-tick" text-anchor="middle">${escText(formatNumber(tick))}</text>`;
  }).join('');
  const label = xLabel
    ? `<text x="${(dim.margin.left + innerW / 2).toFixed(1)}" y="${(dim.height - 4).toFixed(1)}" class="axis-label" text-anchor="middle">${escText(xLabel)}</text>`
    : '';
  return tickMarks + label;
}

function niceMax(values: number[]): number {
  if (values.length === 0) return 1;
  const max = Math.max(...values);
  if (max <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  const ratio = max / magnitude;
  if (ratio < 1.5) return 1.5 * magnitude;
  if (ratio < 3) return 3 * magnitude;
  if (ratio < 7) return 7 * magnitude;
  return 10 * magnitude;
}

function niceTicks(yMax: number, count: number): number[] {
  const step = yMax / count;
  const result: number[] = [];
  for (let i = 1; i <= count; i += 1) result.push(step * i);
  return result;
}

function formatNumber(value: number): string {
  if (value === 0) return '0';
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatBytes(bytes: number): string {
  if (bytes <= 0 || !Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const exp = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))));
  const value = bytes / Math.pow(1024, exp);
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[exp]}`;
}

function escAttr(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function escText(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}
