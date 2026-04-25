// RFC 013 §4.13.5 — render a comparison HTML report from two BenchmarkReports
// + a CrossModelResult. Hydrates `report-template.html` via plain string
// substitution (no Handlebars / no React). Output is fully self-contained:
// inline CSS, inline SVG, no external assets.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { BenchmarkReport } from '../types.js';
import { renderBarChart, renderLegend, renderLineChart, renderStackedBar } from './chart.js';

export interface CrossModelQueryResult {
  query: string;
  jaccard: number;
  topK_a: { doc: string; score: number }[];
  topK_b: { doc: string; score: number }[];
}

export interface CrossModelAggregate {
  jaccard_p50: number;
  jaccard_p95: number;
  spearman_p50: number;
  overlap_doc_count: number;
  per_query: CrossModelQueryResult[];
}

export interface CostBreakdownPair {
  model_a_usd: number;
  model_b_usd: number;
  source: 'rule-of-thumb' | 'api-usage';
  last_verified: string;
}

export interface RenderInput {
  reportA: BenchmarkReport;
  reportB: BenchmarkReport;
  modelA: { id: string; name: string };
  modelB: { id: string; name: string };
  fixture: { profile: string; chunks: number };
  crossModel: CrossModelAggregate;
  cost: CostBreakdownPair;
  generatedAt: string;
}

const COLOR_A = '#1f77b4';
const COLOR_B = '#ff7f0e';

interface SummaryRow {
  metric: string;
  a: string;
  b: string;
  winner: 'A' | 'B' | 'tie' | 'na';
  detail?: string;
}

export async function renderReport(input: RenderInput): Promise<string> {
  const template = await loadTemplate();
  const summaryRows = buildSummaryRows(input);
  const recommendationRows = buildRecommendation(input);
  const queryDetails = buildQueryDetails(input);

  const warmChart = renderBarChart(
    [
      { label: 'p50', values: warmBars(input, 'p50_ms') },
      { label: 'p95', values: warmBars(input, 'p95_ms') },
      { label: 'p99', values: warmBars(input, 'p99_ms') },
    ],
    { yLabel: 'ms' },
  );

  const batchLatencyChart = input.reportA.scenarios.batch_query && input.reportB.scenarios.batch_query
    ? renderBatchLatencyChart(input)
    : '<p class="meta">batch-query scenario not present in both reports</p>';

  const throughputChart = input.reportA.scenarios.batch_query && input.reportB.scenarios.batch_query
    ? renderThroughputChart(input)
    : '<p class="meta">batch-query scenario not present in both reports</p>';

  const storageChart = input.reportA.scenarios.index_storage && input.reportB.scenarios.index_storage
    ? renderStorageChart(input)
    : '<p class="meta">index-storage scenario not present in both reports</p>';

  const meta = formatMeta(input);

  return template
    .replace(/\{\{TITLE\}\}/g, escHtml(`Embedding model comparison: ${input.modelA.id} vs ${input.modelB.id}`))
    .replace('{{META}}', meta)
    .replace('{{LEGEND}}', renderLegend([
      { name: `A — ${input.modelA.id}`, color: COLOR_A },
      { name: `B — ${input.modelB.id}`, color: COLOR_B },
    ]))
    .replace('{{SUMMARY_ROWS}}', summaryRows.map(rowHtml).join(''))
    .replace('{{CHART_WARM}}', warmChart)
    .replace('{{CHART_BATCH_LATENCY}}', batchLatencyChart)
    .replace('{{CHART_THROUGHPUT}}', throughputChart)
    .replace('{{CHART_STORAGE}}', storageChart)
    .replace('{{QUERY_COUNT}}', String(input.crossModel.per_query.length))
    .replace('{{QUERY_DETAILS}}', queryDetails)
    .replace('{{RECOMMENDATION_TABLE}}', recommendationRows)
    .replace('{{COST_LAST_VERIFIED}}', escHtml(input.cost.last_verified || 'unknown'));
}

async function loadTemplate(): Promise<string> {
  // The template is a static asset that lives in `benchmarks/compare/` in the
  // source tree but isn't copied to the build tree by tsc. Search both
  // locations so the renderer works whether invoked from the build output or
  // (in future) from a tsx run.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'report-template.html'),
    // Compiled-output path: build/benchmarks/compare/ → ../../../benchmarks/compare/
    path.join(here, '..', '..', '..', 'benchmarks', 'compare', 'report-template.html'),
    // Repo-root-relative fallback (works when CWD is the repo root):
    path.resolve(process.cwd(), 'benchmarks', 'compare', 'report-template.html'),
  ];
  for (const candidate of candidates) {
    try {
      return await fsp.readFile(candidate, 'utf-8');
    } catch {
      // try next
    }
  }
  throw new Error(`render: could not locate report-template.html in any of: ${candidates.join(', ')}`);
}

function buildSummaryRows(input: RenderInput): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const { reportA, reportB } = input;

  rows.push({
    metric: 'cold_index_ms',
    a: reportA.scenarios.cold_index.ms.toFixed(0),
    b: reportB.scenarios.cold_index.ms.toFixed(0),
    winner: lowerIsBetter(reportA.scenarios.cold_index.ms, reportB.scenarios.cold_index.ms),
    detail: detailRatio(reportA.scenarios.cold_index.ms, reportB.scenarios.cold_index.ms, 'lower'),
  });
  rows.push({
    metric: 'warm_query_p50_ms',
    a: reportA.scenarios.warm_query.p50_ms.toFixed(2),
    b: reportB.scenarios.warm_query.p50_ms.toFixed(2),
    winner: lowerIsBetter(reportA.scenarios.warm_query.p50_ms, reportB.scenarios.warm_query.p50_ms),
  });
  rows.push({
    metric: 'warm_query_p99_ms',
    a: reportA.scenarios.warm_query.p99_ms.toFixed(2),
    b: reportB.scenarios.warm_query.p99_ms.toFixed(2),
    winner: lowerIsBetter(reportA.scenarios.warm_query.p99_ms, reportB.scenarios.warm_query.p99_ms),
  });

  const batchA = reportA.scenarios.batch_query?.runs.find((r) => r.concurrency === 16);
  const batchB = reportB.scenarios.batch_query?.runs.find((r) => r.concurrency === 16);
  if (batchA && batchB) {
    rows.push({
      metric: 'batch_qps@16',
      a: batchA.qps_p50.toFixed(1),
      b: batchB.qps_p50.toFixed(1),
      winner: higherIsBetter(batchA.qps_p50, batchB.qps_p50),
    });
  }

  if (reportA.scenarios.index_storage && reportB.scenarios.index_storage) {
    const aMiB = reportA.scenarios.index_storage.total_bytes / 1024 / 1024;
    const bMiB = reportB.scenarios.index_storage.total_bytes / 1024 / 1024;
    rows.push({
      metric: 'total_storage_MiB',
      a: aMiB.toFixed(2),
      b: bMiB.toFixed(2),
      winner: aMiB === 0 && bMiB === 0 ? 'na' : lowerIsBetter(aMiB, bMiB),
    });
  }

  rows.push({
    metric: 'estimated_cost_usd',
    a: input.cost.model_a_usd.toFixed(4),
    b: input.cost.model_b_usd.toFixed(4),
    winner: input.cost.model_a_usd === input.cost.model_b_usd
      ? 'tie'
      : lowerIsBetter(input.cost.model_a_usd, input.cost.model_b_usd),
  });

  rows.push({
    metric: 'default_recall@10',
    a: reportA.scenarios.retrieval_quality.default_recall_at_10.toFixed(3),
    b: reportB.scenarios.retrieval_quality.default_recall_at_10.toFixed(3),
    winner: higherIsBetter(
      reportA.scenarios.retrieval_quality.default_recall_at_10,
      reportB.scenarios.retrieval_quality.default_recall_at_10,
    ),
  });

  rows.push({
    metric: 'jaccard_top10_p50',
    a: input.crossModel.jaccard_p50.toFixed(2),
    b: input.crossModel.jaccard_p50.toFixed(2),
    winner: 'na',
    detail: `cross-model agreement (lower = more disjoint)`,
  });

  return rows;
}

function rowHtml(row: SummaryRow): string {
  const winnerCell =
    row.winner === 'A' ? `<td class="winner">A${row.detail ? ` (${row.detail})` : ''}</td>` :
    row.winner === 'B' ? `<td class="winner">B${row.detail ? ` (${row.detail})` : ''}</td>` :
    row.winner === 'tie' ? `<td class="tie">tie</td>` :
    `<td class="tie">${escHtml(row.detail ?? 'N/A')}</td>`;
  return `<tr><td>${escHtml(row.metric)}</td><td>${escHtml(row.a)}</td><td>${escHtml(row.b)}</td>${winnerCell}</tr>`;
}

function lowerIsBetter(a: number, b: number): SummaryRow['winner'] {
  if (a === b) return 'tie';
  return a < b ? 'A' : 'B';
}
function higherIsBetter(a: number, b: number): SummaryRow['winner'] {
  if (a === b) return 'tie';
  return a > b ? 'A' : 'B';
}
function detailRatio(a: number, b: number, betterDirection: 'lower' | 'higher'): string {
  if (a === 0 || b === 0) return '';
  const winner = betterDirection === 'lower' ? Math.min(a, b) : Math.max(a, b);
  const loser = betterDirection === 'lower' ? Math.max(a, b) : Math.min(a, b);
  const ratio = betterDirection === 'lower' ? loser / winner : winner / loser;
  if (!Number.isFinite(ratio) || ratio < 1.05) return '';
  return `${ratio.toFixed(2)}× ${betterDirection === 'lower' ? 'faster' : 'higher'}`;
}

function warmBars(input: RenderInput, key: 'p50_ms' | 'p95_ms' | 'p99_ms') {
  return [
    { name: input.modelA.id, color: COLOR_A, value: input.reportA.scenarios.warm_query[key] },
    { name: input.modelB.id, color: COLOR_B, value: input.reportB.scenarios.warm_query[key] },
  ];
}

function renderBatchLatencyChart(input: RenderInput): string {
  const runsA = input.reportA.scenarios.batch_query!.runs;
  const runsB = input.reportB.scenarios.batch_query!.runs;
  // Use union of concurrencies; align by value
  const concurrencies = Array.from(new Set([...runsA.map((r) => r.concurrency), ...runsB.map((r) => r.concurrency)])).sort((x, y) => x - y);
  const buckets = concurrencies.map((c) => {
    const a = runsA.find((r) => r.concurrency === c);
    const b = runsB.find((r) => r.concurrency === c);
    return {
      label: `c=${c}`,
      values: [
        { name: `${input.modelA.id} p99`, color: COLOR_A, value: a?.latency_p99_ms ?? 0 },
        { name: `${input.modelB.id} p99`, color: COLOR_B, value: b?.latency_p99_ms ?? 0 },
      ],
    };
  });
  return renderBarChart(buckets, { yLabel: 'p99 ms' });
}

function renderThroughputChart(input: RenderInput): string {
  const seriesA = {
    name: input.modelA.id,
    color: COLOR_A,
    points: input.reportA.scenarios.batch_query!.runs.map((r) => ({ x: r.concurrency, y: r.qps_p50 })),
  };
  const seriesB = {
    name: input.modelB.id,
    color: COLOR_B,
    points: input.reportB.scenarios.batch_query!.runs.map((r) => ({ x: r.concurrency, y: r.qps_p50 })),
  };
  return renderLineChart([seriesA, seriesB], { xLabel: 'concurrency', yLabel: 'qps (p50)' });
}

function renderStorageChart(input: RenderInput): string {
  const sa = input.reportA.scenarios.index_storage!;
  const sb = input.reportB.scenarios.index_storage!;
  return renderStackedBar(
    [
      { label: input.modelA.id, segments: [
        { name: 'vector binary', color: COLOR_A, value: sa.vector_binary_bytes },
        { name: 'docstore', color: '#9ec5e7', value: sa.docstore_bytes },
      ] },
      { label: input.modelB.id, segments: [
        { name: 'vector binary', color: COLOR_B, value: sb.vector_binary_bytes },
        { name: 'docstore', color: '#ffc18a', value: sb.docstore_bytes },
      ] },
    ],
    { yLabel: 'bytes' },
  );
}

function buildQueryDetails(input: RenderInput): string {
  if (input.crossModel.per_query.length === 0) {
    return '<p class="meta">no per-query results captured</p>';
  }
  // Cap to 50 to keep the HTML reasonable
  const items = input.crossModel.per_query.slice(0, 50);
  return items.map((q) => {
    const overlap = new Set(
      q.topK_a.map((x) => x.doc).filter((doc) => q.topK_b.some((y) => y.doc === doc)),
    );
    const list = (results: { doc: string; score: number }[]) => results.slice(0, 5).map((r) => {
      const cls = overlap.has(r.doc) ? 'doc overlap' : 'doc';
      return `<div class="${cls}">${escHtml(r.doc)} <span class="meta">(${r.score.toFixed(3)})</span></div>`;
    }).join('');
    return `<details class="query-detail">
<summary>j=${q.jaccard.toFixed(2)} • ${escHtml(q.query.slice(0, 80))}${q.query.length > 80 ? '…' : ''}</summary>
<div class="results">
  <div><strong>A</strong>${list(q.topK_a)}</div>
  <div><strong>B</strong>${list(q.topK_b)}</div>
</div>
</details>`;
  }).join('');
}

interface RecommendationAxis {
  axis: string;
  pick: 'A' | 'B' | 'none';
  reason: string;
}

function buildRecommendation(input: RenderInput): string {
  const axes: RecommendationAxis[] = [];
  const { reportA, reportB } = input;

  // single-query latency: A's p99 is 25%+ lower than B's
  const p99A = reportA.scenarios.warm_query.p99_ms;
  const p99B = reportB.scenarios.warm_query.p99_ms;
  axes.push(latencyAxis('single-query latency (warm p99)', p99A, p99B, 0.25));

  // batch throughput: qps@16 40%+ higher
  const batchA = reportA.scenarios.batch_query?.runs.find((r) => r.concurrency === 16);
  const batchB = reportB.scenarios.batch_query?.runs.find((r) => r.concurrency === 16);
  if (batchA && batchB) {
    axes.push(throughputAxis('batch throughput (qps @ c=16)', batchA.qps_p50, batchB.qps_p50, 0.40));
  }

  // cost: 30%+ lower
  axes.push(costAxis(input.cost.model_a_usd, input.cost.model_b_usd, 0.30));

  // storage: bytes/vector 33%+ lower
  if (reportA.scenarios.index_storage && reportB.scenarios.index_storage) {
    const bvA = reportA.scenarios.index_storage.bytes_per_vector;
    const bvB = reportB.scenarios.index_storage.bytes_per_vector;
    if (bvA > 0 && bvB > 0) {
      axes.push(storageAxis(bvA, bvB, 0.33));
    }
  }

  // recall: 5%+ higher
  const recallA = reportA.scenarios.retrieval_quality.default_recall_at_10;
  const recallB = reportB.scenarios.retrieval_quality.default_recall_at_10;
  axes.push(recallAxis(recallA, recallB, 0.05));

  // diversity (no winner)
  axes.push({
    axis: 'result diversity',
    pick: 'none',
    reason: `Jaccard p50 = ${input.crossModel.jaccard_p50.toFixed(2)} ⇒ ~${Math.round((1 - input.crossModel.jaccard_p50) * 100)}% non-overlap; consider RRF if both are useful.`,
  });

  const rows = axes.map((a) => {
    const cellPick = a.pick === 'none'
      ? `<td class="pick none">—</td>`
      : `<td class="pick">${a.pick}</td>`;
    return `<tr><td>${escHtml(a.axis)}</td>${cellPick}<td style="text-align:left">${escHtml(a.reason)}</td></tr>`;
  }).join('');

  return `<table>
<thead><tr><th>If you optimise for…</th><th>Pick</th><th style="text-align:left">Reason</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

function latencyAxis(label: string, a: number, b: number, threshold: number): RecommendationAxis {
  if (a === 0 && b === 0) return { axis: label, pick: 'none', reason: 'no measurements' };
  const winner = a < b ? 'A' : 'B';
  const winnerVal = Math.min(a, b);
  const loserVal = Math.max(a, b);
  const ratio = (loserVal - winnerVal) / loserVal;
  return ratio >= threshold
    ? { axis: label, pick: winner, reason: `${winner === 'A' ? "A's" : "B's"} p99 is ${(ratio * 100).toFixed(0)}% lower (threshold ${(threshold * 100).toFixed(0)}%).` }
    : { axis: label, pick: 'none', reason: `gap (${(ratio * 100).toFixed(0)}%) below threshold (${(threshold * 100).toFixed(0)}%) — call it a tie.` };
}

function throughputAxis(label: string, a: number, b: number, threshold: number): RecommendationAxis {
  if (a === 0 && b === 0) return { axis: label, pick: 'none', reason: 'no measurements' };
  const winner = a > b ? 'A' : 'B';
  const winnerVal = Math.max(a, b);
  const loserVal = Math.min(a, b);
  const ratio = loserVal === 0 ? 1 : (winnerVal - loserVal) / loserVal;
  return ratio >= threshold
    ? { axis: label, pick: winner, reason: `${winner === 'A' ? "A's" : "B's"} qps is ${(ratio * 100).toFixed(0)}% higher (threshold ${(threshold * 100).toFixed(0)}%).` }
    : { axis: label, pick: 'none', reason: `gap (${(ratio * 100).toFixed(0)}%) below threshold.` };
}

function costAxis(a: number, b: number, threshold: number): RecommendationAxis {
  if (a === 0 && b === 0) return { axis: 'cost per re-embed', pick: 'none', reason: 'both free → tie.' };
  const winner = a < b ? 'A' : 'B';
  const winnerVal = Math.min(a, b);
  const loserVal = Math.max(a, b);
  if (winnerVal === 0) return { axis: 'cost per re-embed', pick: winner, reason: `${winner} is free; the other costs $${loserVal.toFixed(4)}.` };
  const ratio = (loserVal - winnerVal) / loserVal;
  return ratio >= threshold
    ? { axis: 'cost per re-embed', pick: winner, reason: `${winner === 'A' ? "A's" : "B's"} cost is ${(ratio * 100).toFixed(0)}% lower.` }
    : { axis: 'cost per re-embed', pick: 'none', reason: `gap (${(ratio * 100).toFixed(0)}%) below threshold.` };
}

function storageAxis(a: number, b: number, threshold: number): RecommendationAxis {
  const winner = a < b ? 'A' : 'B';
  const winnerVal = Math.min(a, b);
  const loserVal = Math.max(a, b);
  const ratio = (loserVal - winnerVal) / loserVal;
  return ratio >= threshold
    ? { axis: 'storage at 10× growth', pick: winner, reason: `${winner === 'A' ? "A's" : "B's"} bytes/vector is ${(ratio * 100).toFixed(0)}% lower.` }
    : { axis: 'storage at 10× growth', pick: 'none', reason: `gap (${(ratio * 100).toFixed(0)}%) below threshold.` };
}

function recallAxis(a: number, b: number, threshold: number): RecommendationAxis {
  if (a === 0 && b === 0) return { axis: 'recall@10', pick: 'none', reason: 'no labelled queries.' };
  const winner = a > b ? 'A' : 'B';
  const winnerVal = Math.max(a, b);
  const loserVal = Math.min(a, b);
  const diff = winnerVal - loserVal;
  return diff >= threshold
    ? { axis: 'recall@10 (if labelled)', pick: winner, reason: `${winner === 'A' ? "A's" : "B's"} recall is ${(diff * 100).toFixed(1)}pp higher.` }
    : { axis: 'recall@10', pick: 'none', reason: `gap (${(diff * 100).toFixed(1)}pp) below threshold (${(threshold * 100).toFixed(0)}pp).` };
}

function formatMeta(input: RenderInput): string {
  const a = input.reportA;
  return `Generated ${escHtml(input.generatedAt)} • ` +
    `node ${escHtml(a.node_version)} • ${escHtml(a.os)}-${escHtml(a.arch)} • ` +
    `git <code>${escHtml(a.git_sha)}</code> • ` +
    `provider A=<code>${escHtml(a.provider)}</code>, B=<code>${escHtml(input.reportB.provider)}</code> • ` +
    `fixture=${escHtml(input.fixture.profile)} (${input.fixture.chunks} chunks)`;
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
