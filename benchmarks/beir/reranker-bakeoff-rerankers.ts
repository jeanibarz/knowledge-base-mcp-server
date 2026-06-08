import { tokenize } from './late-interaction.js';

export const RERANKER_BAKEOFF_SCHEMA_VERSION = 'kb.beir.reranker-bakeoff-reranker.v1';
export const RERANKER_BAKEOFF_TOP_N = 50;

export type BenchmarkRerankerMode =
  | 'hybrid+listwise-rerank'
  | 'hybrid+hard-negative-rerank'
  | 'hybrid+adaptive-rerank';

export type BenchmarkRerankerStrategy =
  | 'listwise-attention'
  | 'hard-negative-head'
  | 'adaptive-listwise-attention';

export interface BenchmarkRerankCandidate {
  pageContent?: string;
  metadata: Record<string, unknown>;
  score: number;
}

export interface BenchmarkRerankerQueryReport {
  schema_version: typeof RERANKER_BAKEOFF_SCHEMA_VERSION;
  enabled: true;
  strategy: BenchmarkRerankerStrategy;
  model: string;
  top_n: number;
  candidates_in: number;
  candidates_reranked: number;
  skipped: boolean;
  skip_reason: string | null;
  latency_ms: number;
  ambiguity: {
    top_overlap: number;
    second_overlap: number;
    gap: number;
  };
}

export interface BenchmarkRerankerSummary {
  schema_version: 'kb.beir.reranker-bakeoff-summary.v1';
  enabled: true;
  strategy: BenchmarkRerankerStrategy;
  model: string;
  top_n: number;
  queries: number;
  mean_candidates_in: number;
  mean_candidates_reranked: number;
  skipped_queries: number;
  mean_latency_ms: number;
}

export function isBenchmarkRerankerMode(mode: string): mode is BenchmarkRerankerMode {
  return mode === 'hybrid+listwise-rerank' ||
    mode === 'hybrid+hard-negative-rerank' ||
    mode === 'hybrid+adaptive-rerank';
}

function benchmarkRerankerStrategyForMode(mode: BenchmarkRerankerMode): BenchmarkRerankerStrategy {
  switch (mode) {
    case 'hybrid+listwise-rerank':
      return 'listwise-attention';
    case 'hybrid+hard-negative-rerank':
      return 'hard-negative-head';
    case 'hybrid+adaptive-rerank':
      return 'adaptive-listwise-attention';
  }
}

export function rerankWithBenchmarkReranker<T extends BenchmarkRerankCandidate>(input: {
  mode: BenchmarkRerankerMode;
  query: string;
  candidates: readonly T[];
  topN?: number;
}): { results: T[]; report: BenchmarkRerankerQueryReport } {
  const started = process.hrtime.bigint();
  const strategy = benchmarkRerankerStrategyForMode(input.mode);
  const topN = Math.min(input.topN ?? RERANKER_BAKEOFF_TOP_N, input.candidates.length);
  const block = input.candidates.slice(0, topN);
  const tail = input.candidates.slice(topN);
  const ambiguity = computeAmbiguity(input.query, block);

  if (strategy === 'adaptive-listwise-attention' && !shouldRerankAdaptively(input.query, ambiguity, block.length)) {
    return {
      results: input.candidates.slice(),
      report: buildQueryReport({
        strategy,
        topN,
        candidatesIn: input.candidates.length,
        candidatesReranked: 0,
        skipped: true,
        skipReason: 'low_ambiguity',
        ambiguity,
        started,
      }),
    };
  }

  const scored = block.map((candidate, index) => ({
    candidate,
    index,
    score: strategy === 'hard-negative-head'
      ? hardNegativeHeadScore(input.query, candidate, index, block.length)
      : listwiseAttentionScore(input.query, candidate, index, block),
  }));
  scored.sort((left, right) => right.score - left.score || left.index - right.index);

  return {
    results: [...scored.map((row) => row.candidate), ...tail],
    report: buildQueryReport({
      strategy,
      topN,
      candidatesIn: input.candidates.length,
      candidatesReranked: block.length,
      skipped: false,
      skipReason: null,
      ambiguity,
      started,
    }),
  };
}

export function summarizeBenchmarkRerankerReports(
  reports: readonly BenchmarkRerankerQueryReport[],
): BenchmarkRerankerSummary | null {
  if (reports.length === 0) return null;
  const first = reports[0];
  return {
    schema_version: 'kb.beir.reranker-bakeoff-summary.v1',
    enabled: true,
    strategy: first.strategy,
    model: first.model,
    top_n: first.top_n,
    queries: reports.length,
    mean_candidates_in: mean(reports.map((r) => r.candidates_in)),
    mean_candidates_reranked: mean(reports.map((r) => r.candidates_reranked)),
    skipped_queries: reports.filter((r) => r.skipped).length,
    mean_latency_ms: mean(reports.map((r) => r.latency_ms)),
  };
}

function buildQueryReport(input: {
  strategy: BenchmarkRerankerStrategy;
  topN: number;
  candidatesIn: number;
  candidatesReranked: number;
  skipped: boolean;
  skipReason: string | null;
  ambiguity: BenchmarkRerankerQueryReport['ambiguity'];
  started: bigint;
}): BenchmarkRerankerQueryReport {
  return {
    schema_version: RERANKER_BAKEOFF_SCHEMA_VERSION,
    enabled: true,
    strategy: input.strategy,
    model: modelId(input.strategy),
    top_n: input.topN,
    candidates_in: input.candidatesIn,
    candidates_reranked: input.candidatesReranked,
    skipped: input.skipped,
    skip_reason: input.skipReason,
    latency_ms: Number(elapsedMs(input.started).toFixed(3)),
    ambiguity: input.ambiguity,
  };
}

function modelId(strategy: BenchmarkRerankerStrategy): string {
  switch (strategy) {
    case 'listwise-attention':
      return 'qr-style-token-attention-v1';
    case 'hard-negative-head':
      return 'hard-negative-boundary-head-sim-v1';
    case 'adaptive-listwise-attention':
      return 'adaptive-qr-style-token-attention-v1';
  }
}

function listwiseAttentionScore(
  query: string,
  candidate: BenchmarkRerankCandidate,
  index: number,
  candidates: readonly BenchmarkRerankCandidate[],
): number {
  const queryTokens = uniqueTokens(query);
  const candidateTokens = uniqueTokens(candidate.pageContent ?? '');
  const candidateTokenSets = candidates.map((c) => uniqueTokens(c.pageContent ?? ''));
  const idf = computeCandidateIdf(candidateTokenSets);
  const overlap = weightedOverlap(queryTokens, candidateTokens, idf);
  const queryWeight = sumTokenWeights(queryTokens, idf);
  const coverage = queryTokens.size === 0 || queryWeight === 0 ? 0 : overlap / queryWeight;
  const centrality = mean(candidateTokenSets.map((tokens) => jaccard(candidateTokens, tokens)));
  const rankPrior = 1 / (1 + index);
  const lengthPenalty = Math.min(Math.abs(candidateTokens.size - 80) / 300, 0.25);
  // Deterministic prototype heuristic: reward query coverage, candidate-set
  // centrality, and original-rank confidence while lightly penalizing outlier
  // length. These weights are benchmark knobs, not trained model parameters.
  return 0.62 * coverage + 0.22 * centrality + 0.16 * rankPrior - lengthPenalty;
}

function hardNegativeHeadScore(query: string, candidate: BenchmarkRerankCandidate, index: number, total: number): number {
  const queryTokens = uniqueTokens(query);
  const body = candidate.pageContent ?? '';
  const candidateTokens = uniqueTokens(body);
  const title = typeof candidate.metadata.title === 'string' ? candidate.metadata.title : '';
  const titleTokens = uniqueTokens(title);
  const overlap = queryTokens.size === 0 ? 0 : intersectionSize(queryTokens, candidateTokens) / queryTokens.size;
  const titleOverlap = queryTokens.size === 0 ? 0 : intersectionSize(queryTokens, titleTokens) / queryTokens.size;
  const missingTerms = Math.max(0, queryTokens.size - intersectionSize(queryTokens, candidateTokens)) / Math.max(queryTokens.size, 1);
  const scienceCue = /\b(citation|experiment|evidence|study|dataset|analysis|hypothesis|method)\b/i.test(body) ? 1 : 0;
  const negationCue = /\b(not|never|without|fails?|rejects?|contradicts?)\b/i.test(body) ? 1 : 0;
  const rankPrior = total <= 1 ? 1 : 1 - index / (total - 1);
  const lengthPenalty = Math.min(Math.max(candidateTokens.size - 220, 0) / 600, 0.35);
  // Simulated boundary classifier over hand-built hard-negative features:
  // query/title overlap and scientific evidence cues lift candidates, while
  // missing terms, negation cues, and long distractors push them down.
  return 1.42 * overlap + 0.35 * titleOverlap + 0.18 * scienceCue + 0.12 * rankPrior - 0.35 * missingTerms - 0.12 * negationCue - lengthPenalty;
}

function shouldRerankAdaptively(
  query: string,
  ambiguity: BenchmarkRerankerQueryReport['ambiguity'],
  candidates: number,
): boolean {
  if (candidates < 2) return false;
  const queryLength = uniqueTokens(query).size;
  if (queryLength >= 6) return true;
  if (ambiguity.top_overlap === 0) return true;
  // Skip when the leading candidate has a clear lexical-evidence gap; rerank
  // when evidence is missing or the top candidates are close enough to be
  // ambiguous.
  return ambiguity.gap <= 0.15;
}

function computeAmbiguity(
  query: string,
  candidates: readonly BenchmarkRerankCandidate[],
): BenchmarkRerankerQueryReport['ambiguity'] {
  const queryTokens = uniqueTokens(query);
  const overlaps = candidates
    .map((candidate) => {
      const candidateTokens = uniqueTokens(candidate.pageContent ?? '');
      return queryTokens.size === 0 ? 0 : intersectionSize(queryTokens, candidateTokens) / queryTokens.size;
    })
    .sort((a, b) => b - a);
  const top = overlaps[0] ?? 0;
  const second = overlaps[1] ?? 0;
  return {
    top_overlap: Number(top.toFixed(6)),
    second_overlap: Number(second.toFixed(6)),
    gap: Number((top - second).toFixed(6)),
  };
}

function uniqueTokens(text: string): Set<string> {
  return new Set(tokenize(text).filter((token) => token.length > 1));
}

function computeCandidateIdf(tokenSets: readonly Set<string>[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const tokens of tokenSets) {
    for (const token of tokens) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const docs = Math.max(tokenSets.length, 1);
  const idf = new Map<string, number>();
  for (const [token, count] of df) idf.set(token, Math.log(1 + (docs + 1) / (count + 1)));
  return idf;
}

function weightedOverlap(left: Set<string>, right: Set<string>, weights: Map<string, number>): number {
  let total = 0;
  for (const token of left) {
    if (right.has(token)) total += weights.get(token) ?? 1;
  }
  return total;
}

function sumTokenWeights(tokens: Set<string>, weights: Map<string, number>): number {
  let total = 0;
  for (const token of tokens) total += weights.get(token) ?? 1;
  return total;
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  const intersection = intersectionSize(left, right);
  return intersection / (left.size + right.size - intersection);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6));
}

function elapsedMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}
