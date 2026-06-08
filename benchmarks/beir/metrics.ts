export interface Qrels {
  byQuery: Map<string, Map<string, number>>;
}

export interface RankedDocument {
  docId: string;
  score: number;
}

export interface QueryMetric {
  queryId: string;
  relevant: number;
  retrieved: number;
  ndcgAt10: number;
  mapAt100: number;
  // RFC 020 M0 — precision@10 is recorded alongside nDCG@10 because the
  // chunk-size sweep needs it: an oversized chunk can still hit the qrel
  // document (keeping nDCG/recall high) while diluting the fraction of the
  // top-10 that is actually relevant. Precision is what exposes that
  // chunk-boundary ↔ qrel-span mismatch.
  precisionAt10: number;
  recallAt10: number;
  recallAt100: number;
}

export interface AggregateMetrics {
  judgedQueries: number;
  ndcgAt10: number;
  mapAt100: number;
  precisionAt10: number;
  recallAt10: number;
  recallAt100: number;
}

export interface LatencySummary {
  queries: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
}

export function parseQrelsTsv(raw: string): Qrels {
  const byQuery = new Map<string, Map<string, number>>();
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    if (parts[0] === 'query-id' || parts[0] === 'query_id') continue;

    const queryId = parts[0];
    const docId = parts[1];
    const relevance = Number(parts[2]);
    if (!Number.isFinite(relevance)) {
      continue;
    }
    let docs = byQuery.get(queryId);
    if (docs === undefined) {
      docs = new Map();
      byQuery.set(queryId, docs);
    }
    docs.set(docId, relevance);
  }
  return { byQuery };
}

export function scoreQuery(
  queryId: string,
  ranking: readonly RankedDocument[],
  qrels: Qrels,
): QueryMetric | null {
  const labels = qrels.byQuery.get(queryId);
  if (labels === undefined) {
    return null;
  }
  const relevantEntries = [...labels.entries()].filter(([, relevance]) => relevance > 0);
  if (relevantEntries.length === 0) {
    return null;
  }

  const relevantDocIds = new Set(relevantEntries.map(([docId]) => docId));
  const relevanceByDoc = new Map(relevantEntries);
  const uniqueRanking = dedupeRanking(ranking);
  return {
    queryId,
    relevant: relevantDocIds.size,
    retrieved: uniqueRanking.length,
    ndcgAt10: roundMetric(ndcgAt(uniqueRanking, relevanceByDoc, 10)),
    mapAt100: roundMetric(averagePrecisionAt(uniqueRanking, relevantDocIds, 100)),
    precisionAt10: roundMetric(precisionAt(uniqueRanking, relevantDocIds, 10)),
    recallAt10: roundMetric(recallAt(uniqueRanking, relevantDocIds, 10)),
    recallAt100: roundMetric(recallAt(uniqueRanking, relevantDocIds, 100)),
  };
}

export function aggregateQueryMetrics(metrics: readonly QueryMetric[]): AggregateMetrics {
  return {
    judgedQueries: metrics.length,
    ndcgAt10: roundMetric(mean(metrics.map((metric) => metric.ndcgAt10))),
    mapAt100: roundMetric(mean(metrics.map((metric) => metric.mapAt100))),
    precisionAt10: roundMetric(mean(metrics.map((metric) => metric.precisionAt10))),
    recallAt10: roundMetric(mean(metrics.map((metric) => metric.recallAt10))),
    recallAt100: roundMetric(mean(metrics.map((metric) => metric.recallAt100))),
  };
}

export function summarizeLatencies(latenciesMs: readonly number[]): LatencySummary {
  return {
    queries: latenciesMs.length,
    p50Ms: percentile(latenciesMs, 50),
    p95Ms: percentile(latenciesMs, 95),
    p99Ms: percentile(latenciesMs, 99),
    meanMs: roundMetric(mean(latenciesMs)),
  };
}

export function formatTrecRun(
  rows: ReadonlyArray<{ queryId: string; ranking: readonly RankedDocument[] }>,
  runTag: string,
): string {
  const lines: string[] = [];
  for (const row of rows) {
    row.ranking.forEach((doc, index) => {
      const score = Number.isFinite(doc.score) ? doc.score : 0;
      lines.push(`${row.queryId} Q0 ${doc.docId} ${index + 1} ${score.toFixed(6)} ${runTag}`);
    });
  }
  return `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
}

function dedupeRanking(ranking: readonly RankedDocument[]): RankedDocument[] {
  const seen = new Set<string>();
  const out: RankedDocument[] = [];
  for (const item of ranking) {
    if (seen.has(item.docId)) continue;
    seen.add(item.docId);
    out.push(item);
  }
  return out;
}

function recallAt(ranking: readonly RankedDocument[], relevantDocIds: Set<string>, k: number): number {
  if (relevantDocIds.size === 0) return 0;
  let hits = 0;
  for (const item of ranking.slice(0, k)) {
    if (relevantDocIds.has(item.docId)) hits += 1;
  }
  return hits / relevantDocIds.size;
}

// Precision@k — fraction of the top-k retrieved documents that are relevant.
// The denominator is the cutoff `k`, not the number of results returned, so a
// short ranking is penalised for the empty slots (standard BEIR convention).
function precisionAt(ranking: readonly RankedDocument[], relevantDocIds: Set<string>, k: number): number {
  if (k <= 0) return 0;
  let hits = 0;
  for (const item of ranking.slice(0, k)) {
    if (relevantDocIds.has(item.docId)) hits += 1;
  }
  return hits / k;
}

function averagePrecisionAt(
  ranking: readonly RankedDocument[],
  relevantDocIds: Set<string>,
  k: number,
): number {
  if (relevantDocIds.size === 0) return 0;
  let hits = 0;
  let precisionSum = 0;
  ranking.slice(0, k).forEach((item, index) => {
    if (!relevantDocIds.has(item.docId)) return;
    hits += 1;
    precisionSum += hits / (index + 1);
  });
  return precisionSum / relevantDocIds.size;
}

function ndcgAt(
  ranking: readonly RankedDocument[],
  relevanceByDoc: Map<string, number>,
  k: number,
): number {
  const dcg = ranking.slice(0, k).reduce((sum, item, index) => {
    const relevance = relevanceByDoc.get(item.docId) ?? 0;
    return sum + discountedGain(relevance, index + 1);
  }, 0);
  const ideal = [...relevanceByDoc.values()]
    .sort((left, right) => right - left)
    .slice(0, k)
    .reduce((sum, relevance, index) => sum + discountedGain(relevance, index + 1), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

function discountedGain(relevance: number, rank: number): number {
  return (2 ** relevance - 1) / Math.log2(rank + 1);
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return roundMetric(sorted[index]);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}
