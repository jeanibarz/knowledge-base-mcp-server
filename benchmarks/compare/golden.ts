import * as fsp from 'fs/promises';

export type GoldenRelevance = 0 | 1 | 2 | 3;

export interface GoldenLabel {
  source: string;
  relevance: GoldenRelevance;
}

export type GoldenLabels = Record<string, GoldenLabel[]>;

export interface RankedSource {
  doc: string;
  score: number;
}

export interface GoldenModelQueryMetrics {
  hit_rate_at_10: number;
  map: number;
  map_at_10: number;
  mrr_at_10: number;
  ndcg_at_10: number;
  recall_at_5: number;
  recall_at_10: number;
  recall_at_20: number;
  unique_retrieved_count: number;
}

export interface GoldenAggregateMetrics {
  hit_rate_at_10: number;
  map: number;
  map_at_10: number;
  mrr_at_10: number;
  ndcg_at_10: number;
  recall_at_5: number;
  recall_at_10: number;
  recall_at_20: number;
}

export interface GoldenQueryDiagnostics {
  query: string;
  status: 'scored' | 'missing-labels' | 'no-positive-labels';
  relevant_source_count: number;
  labels: GoldenLabel[];
  model_a?: GoldenModelQueryMetrics;
  model_b?: GoldenModelQueryMetrics;
}

export interface GoldenQualityReport {
  schema: 'query-to-source-relevance';
  query_count: number;
  labelled_query_count: number;
  missing_query_count: number;
  no_positive_label_query_count: number;
  model_a: GoldenAggregateMetrics;
  model_b: GoldenAggregateMetrics;
  per_query: GoldenQueryDiagnostics[];
}

export async function loadGoldenFile(filePath: string): Promise<GoldenLabels> {
  const raw = await fsp.readFile(filePath, 'utf-8');
  try {
    return parseGoldenLabels(JSON.parse(raw) as unknown, filePath);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`${filePath}: invalid JSON: ${err.message}`);
    }
    throw err;
  }
}

export function parseGoldenLabels(value: unknown, label = 'golden'): GoldenLabels {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`${label}: expected an object mapping query strings to label arrays`);
  }

  const out: GoldenLabels = {};
  for (const [query, labels] of Object.entries(value)) {
    if (!query.trim()) {
      throw new Error(`${label}: query keys must be non-empty strings`);
    }
    if (!Array.isArray(labels)) {
      throw new Error(`${label}: "${query}" must map to an array of labels`);
    }

    const bySource = new Map<string, GoldenRelevance>();
    labels.forEach((entry, i) => {
      const parsed = parseLabel(entry, `${label}: "${query}"[${i}]`);
      const existing = bySource.get(parsed.source);
      bySource.set(parsed.source, existing === undefined ? parsed.relevance : maxRelevance(existing, parsed.relevance));
    });
    out[query] = Array.from(bySource.entries()).map(([source, relevance]) => ({ source, relevance }));
  }
  return out;
}

export function scoreGoldenQuality(
  labels: GoldenLabels,
  perQuery: { query: string; topK_a: RankedSource[]; topK_b: RankedSource[] }[],
): GoldenQualityReport {
  const diagnostics = perQuery.map((queryResult): GoldenQueryDiagnostics => {
    const queryLabels = labels[queryResult.query];
    if (!queryLabels) {
      return {
        query: queryResult.query,
        status: 'missing-labels',
        relevant_source_count: 0,
        labels: [],
      };
    }

    const relevantCount = queryLabels.filter((label) => label.relevance > 0).length;
    if (relevantCount === 0) {
      return {
        query: queryResult.query,
        status: 'no-positive-labels',
        relevant_source_count: 0,
        labels: queryLabels,
      };
    }

    return {
      query: queryResult.query,
      status: 'scored',
      relevant_source_count: relevantCount,
      labels: queryLabels,
      model_a: scoreRanking(queryLabels, queryResult.topK_a),
      model_b: scoreRanking(queryLabels, queryResult.topK_b),
    };
  });

  const scored = diagnostics.filter((q) => q.status === 'scored');
  return {
    schema: 'query-to-source-relevance',
    query_count: perQuery.length,
    labelled_query_count: scored.length,
    missing_query_count: diagnostics.filter((q) => q.status === 'missing-labels').length,
    no_positive_label_query_count: diagnostics.filter((q) => q.status === 'no-positive-labels').length,
    model_a: aggregate(scored.map((q) => q.model_a)),
    model_b: aggregate(scored.map((q) => q.model_b)),
    per_query: diagnostics,
  };
}

function parseLabel(entry: unknown, label: string): GoldenLabel {
  if (typeof entry === 'string') {
    if (!entry.trim()) {
      throw new Error(`${label}: source strings must be non-empty`);
    }
    return { source: entry, relevance: 1 };
  }

  if (!isRecord(entry)) {
    throw new Error(`${label}: expected { "source": string, "relevance": 0|1|2|3 }`);
  }
  const source = entry.source;
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error(`${label}: source must be a non-empty string`);
  }
  const relevance = entry.relevance;
  if (!isGoldenRelevance(relevance)) {
    throw new Error(`${label}: relevance must be one of 0, 1, 2, or 3`);
  }
  return { source, relevance };
}

function scoreRanking(labels: GoldenLabel[], ranking: RankedSource[]): GoldenModelQueryMetrics {
  const uniqueRanking = dedupeRanking(ranking).slice(0, 20);
  const relevanceBySource = new Map(labels.map((label) => [label.source, label.relevance]));
  const relevantSources = labels.filter((label) => label.relevance > 0).map((label) => label.source);
  const relevantSourceSet = new Set(relevantSources);

  return {
    hit_rate_at_10: hitRateAt(uniqueRanking, relevantSourceSet, 10),
    map: averagePrecisionAt(uniqueRanking, relevantSourceSet, 20),
    map_at_10: averagePrecisionAt(uniqueRanking, relevantSourceSet, 10),
    mrr_at_10: reciprocalRankAt(uniqueRanking, relevantSourceSet, 10),
    ndcg_at_10: ndcgAt(uniqueRanking, relevanceBySource, 10),
    recall_at_5: recallAt(uniqueRanking, relevantSourceSet, 5),
    recall_at_10: recallAt(uniqueRanking, relevantSourceSet, 10),
    recall_at_20: recallAt(uniqueRanking, relevantSourceSet, 20),
    unique_retrieved_count: uniqueRanking.length,
  };
}

function dedupeRanking(ranking: RankedSource[]): RankedSource[] {
  const seen = new Set<string>();
  const out: RankedSource[] = [];
  for (const item of ranking) {
    if (seen.has(item.doc)) continue;
    seen.add(item.doc);
    out.push(item);
  }
  return out;
}

function recallAt(ranking: RankedSource[], relevantSources: Set<string>, k: number): number {
  if (relevantSources.size === 0) return 0;
  const hits = new Set<string>();
  ranking.slice(0, k).forEach((item) => {
    if (relevantSources.has(item.doc)) hits.add(item.doc);
  });
  return roundMetric(hits.size / relevantSources.size);
}

function hitRateAt(ranking: RankedSource[], relevantSources: Set<string>, k: number): number {
  return ranking.slice(0, k).some((item) => relevantSources.has(item.doc)) ? 1 : 0;
}

function reciprocalRankAt(ranking: RankedSource[], relevantSources: Set<string>, k: number): number {
  const rank = ranking.slice(0, k).findIndex((item) => relevantSources.has(item.doc));
  return rank === -1 ? 0 : roundMetric(1 / (rank + 1));
}

function averagePrecisionAt(ranking: RankedSource[], relevantSources: Set<string>, k: number): number {
  if (relevantSources.size === 0 || k <= 0) return 0;
  let hitCount = 0;
  let precisionSum = 0;
  ranking.slice(0, k).forEach((item, i) => {
    if (!relevantSources.has(item.doc)) return;
    hitCount += 1;
    precisionSum += hitCount / (i + 1);
  });
  return roundMetric(precisionSum / Math.min(relevantSources.size, k));
}

function ndcgAt(ranking: RankedSource[], relevanceBySource: Map<string, GoldenRelevance>, k: number): number {
  const dcg = ranking.slice(0, k).reduce((sum, item, i) => {
    const relevance = relevanceBySource.get(item.doc) ?? 0;
    return sum + dcgGain(relevance, i + 1);
  }, 0);
  const ideal = Array.from(relevanceBySource.values())
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce<number>((sum, relevance, i) => sum + dcgGain(relevance, i + 1), 0);
  return ideal === 0 ? 0 : roundMetric(dcg / ideal);
}

function dcgGain(relevance: GoldenRelevance, rank: number): number {
  return (2 ** relevance - 1) / Math.log2(rank + 1);
}

function aggregate(metrics: Array<GoldenModelQueryMetrics | undefined>): GoldenAggregateMetrics {
  const present = metrics.filter((metric): metric is GoldenModelQueryMetrics => metric !== undefined);
  return {
    hit_rate_at_10: meanMetric(present, 'hit_rate_at_10'),
    map: meanMetric(present, 'map'),
    map_at_10: meanMetric(present, 'map_at_10'),
    mrr_at_10: meanMetric(present, 'mrr_at_10'),
    ndcg_at_10: meanMetric(present, 'ndcg_at_10'),
    recall_at_5: meanMetric(present, 'recall_at_5'),
    recall_at_10: meanMetric(present, 'recall_at_10'),
    recall_at_20: meanMetric(present, 'recall_at_20'),
  };
}

function meanMetric(metrics: GoldenModelQueryMetrics[], key: keyof GoldenAggregateMetrics): number {
  if (metrics.length === 0) return 0;
  return roundMetric(metrics.reduce((sum, metric) => sum + metric[key], 0) / metrics.length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGoldenRelevance(value: unknown): value is GoldenRelevance {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3;
}

function maxRelevance(a: GoldenRelevance, b: GoldenRelevance): GoldenRelevance {
  return (a > b ? a : b) as GoldenRelevance;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}
