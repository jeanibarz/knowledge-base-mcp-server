import type { SearchResultDocument } from './FaissIndexManager.js';
import { chunkIdFromMetadata } from './rrf.js';

export const ADVANCED_RETRIEVAL_SCHEMA_VERSION = 'kb.search.advanced-retrieval.v1';

export type AdvancedRetrievalMode = 'diverse' | 'contrastive' | 'composed';

export type AdvancedQueryRole = 'primary' | 'plus' | 'anti_query' | 'minus';

export interface AdvancedQueryComponent {
  role: AdvancedQueryRole;
  query: string;
  weight: number;
  retrieved: number;
}

export interface AdvancedRetrievalOptions {
  k: number;
  candidateK: number;
  diverse: boolean;
  plusQueries: string[];
  antiQueries: string[];
  minusQueries: string[];
  scopedKb?: string;
  threshold?: number;
}

export interface AdvancedRetrievalPool {
  role: AdvancedQueryRole;
  query: string;
  weight?: number;
  results: SearchResultDocument[];
}

export interface AdvancedResultSignal {
  chunk_id: string;
  source: string | null;
  positive_support: number;
  negative_similarity: number;
  diversity_penalty: number;
  advanced_score: number;
  component_ranks: Record<string, number>;
}

export interface AdvancedRetrievalMetadata {
  schema_version: typeof ADVANCED_RETRIEVAL_SCHEMA_VERSION;
  mode: AdvancedRetrievalMode;
  read_only: true;
  candidate_pool_k: number;
  constraints: {
    kb: string | null;
    threshold: number | null;
    requires_positive_support: true;
    anti_query_guard: 'negative-only candidates ignored; no raw farthest-neighbor search';
  };
  query_components: AdvancedQueryComponent[];
  scoring: {
    positive_rank_weight: number;
    negative_rank_penalty: number;
    diversity_penalty: number;
    source_duplicate_penalty: number;
  };
  result_signals: AdvancedResultSignal[];
}

interface Candidate {
  id: string;
  doc: SearchResultDocument;
  source: string | null;
  firstSeen: number;
  bestScore: number;
  primaryRank: number | null;
  positiveSupport: number;
  negativeSimilarity: number;
  componentRanks: Record<string, number>;
}

interface ScoredCandidate {
  candidate: Candidate;
  baseScore: number;
  diversityPenalty: number;
  advancedScore: number;
}

const POSITIVE_RANK_WEIGHT = 1;
const NEGATIVE_RANK_PENALTY = 1.25;
const DIVERSITY_PENALTY = 0.28;
const SOURCE_DUPLICATE_PENALTY = 0.35;
const DEFAULT_COMPONENT_WEIGHT = 1;

export function hasAdvancedRetrieval(options: {
  diverse: boolean;
  plusQueries: readonly string[];
  antiQueries: readonly string[];
  minusQueries: readonly string[];
}): boolean {
  return options.diverse
    || options.plusQueries.length > 0
    || options.antiQueries.length > 0
    || options.minusQueries.length > 0;
}

export function computeAdvancedCandidateK(k: number): number {
  return Math.max(k, Math.min(Math.max(k * 4, 20), 100));
}

export function applyAdvancedRetrieval(
  pools: AdvancedRetrievalPool[],
  options: AdvancedRetrievalOptions,
): { results: SearchResultDocument[]; metadata: AdvancedRetrievalMetadata } {
  const mode = resolveAdvancedMode(options);
  const candidates = collectCandidates(pools);
  const ranked = rankCandidates(candidates, options.diverse);
  const selected = ranked.slice(0, options.k);
  const results = selected.map((entry) => entry.candidate.doc);
  return {
    results,
    metadata: {
      schema_version: ADVANCED_RETRIEVAL_SCHEMA_VERSION,
      mode,
      read_only: true,
      candidate_pool_k: options.candidateK,
      constraints: {
        kb: options.scopedKb ?? null,
        threshold: options.threshold ?? null,
        requires_positive_support: true,
        anti_query_guard: 'negative-only candidates ignored; no raw farthest-neighbor search',
      },
      query_components: buildQueryComponents(pools),
      scoring: {
        positive_rank_weight: POSITIVE_RANK_WEIGHT,
        negative_rank_penalty: NEGATIVE_RANK_PENALTY,
        diversity_penalty: options.diverse ? DIVERSITY_PENALTY : 0,
        source_duplicate_penalty: options.diverse ? SOURCE_DUPLICATE_PENALTY : 0,
      },
      result_signals: selected.map(toResultSignal),
    },
  };
}

export function filterAdvancedRetrievalMetadata(
  metadata: AdvancedRetrievalMetadata,
  results: readonly SearchResultDocument[],
): AdvancedRetrievalMetadata {
  const keptIds = new Set(
    results.map((result) => chunkIdFromMetadata(result.metadata as Record<string, unknown>)),
  );
  return {
    ...metadata,
    result_signals: metadata.result_signals.filter((signal) => keptIds.has(signal.chunk_id)),
  };
}

function resolveAdvancedMode(options: AdvancedRetrievalOptions): AdvancedRetrievalMode {
  if (options.plusQueries.length > 0 || options.minusQueries.length > 0) return 'composed';
  if (options.antiQueries.length > 0) return 'contrastive';
  return 'diverse';
}

function buildQueryComponents(pools: AdvancedRetrievalPool[]): AdvancedQueryComponent[] {
  return pools.map((pool) => ({
    role: pool.role,
    query: pool.query,
    weight: pool.weight ?? DEFAULT_COMPONENT_WEIGHT,
    retrieved: pool.results.length,
  }));
}

function collectCandidates(pools: AdvancedRetrievalPool[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  let firstSeen = 0;

  for (const pool of pools) {
    const roleWeight = pool.weight ?? DEFAULT_COMPONENT_WEIGHT;
    const positive = isPositiveRole(pool.role);
    pool.results.forEach((doc, index) => {
      if (doc.pageContent.trim() === '') return;
      const id = chunkIdFromMetadata(doc.metadata as Record<string, unknown>);
      const rank = index + 1;
      let candidate = byId.get(id);
      if (candidate === undefined) {
        if (!positive) return;
        candidate = {
          id,
          doc,
          source: sourceFromMetadata(doc.metadata as Record<string, unknown>),
          firstSeen,
          bestScore: doc.score,
          primaryRank: pool.role === 'primary' ? rank : null,
          positiveSupport: 0,
          negativeSimilarity: 0,
          componentRanks: {},
        };
        firstSeen += 1;
        byId.set(id, candidate);
      }
      if (positive && doc.score < candidate.bestScore) {
        candidate.bestScore = doc.score;
        candidate.doc = doc;
      }
      if (pool.role === 'primary') {
        candidate.primaryRank = candidate.primaryRank === null ? rank : Math.min(candidate.primaryRank, rank);
      }
      const componentKey = `${pool.role}:${pool.query}`;
      candidate.componentRanks[componentKey] = Math.min(candidate.componentRanks[componentKey] ?? rank, rank);
      const contribution = roleWeight * reciprocalRank(rank);
      if (positive) {
        candidate.positiveSupport += contribution;
      } else {
        candidate.negativeSimilarity = Math.max(candidate.negativeSimilarity, contribution);
      }
    });
  }

  return Array.from(byId.values()).filter((candidate) => candidate.positiveSupport > 0);
}

function rankCandidates(candidates: Candidate[], diverse: boolean): ScoredCandidate[] {
  const remaining = candidates
    .map((candidate) => ({
      candidate,
      baseScore: baseScore(candidate),
      diversityPenalty: 0,
      advancedScore: baseScore(candidate),
    }))
    .sort(compareScoredCandidates);
  if (!diverse) return remaining;

  const selected: ScoredCandidate[] = [];
  while (remaining.length > 0) {
    let bestIndex = 0;
    let best: ScoredCandidate | null = null;
    for (let index = 0; index < remaining.length; index += 1) {
      const current = remaining[index];
      const diversityPenalty = computeDiversityPenalty(current.candidate, selected.map((entry) => entry.candidate));
      const scored = {
        ...current,
        diversityPenalty,
        advancedScore: current.baseScore - diversityPenalty,
      };
      if (best === null || compareScoredCandidates(scored, best) < 0) {
        best = scored;
        bestIndex = index;
      }
    }
    selected.push(best!);
    remaining.splice(bestIndex, 1);
  }
  return selected;
}

function baseScore(candidate: Candidate): number {
  return candidate.positiveSupport * POSITIVE_RANK_WEIGHT
    - candidate.negativeSimilarity * NEGATIVE_RANK_PENALTY;
}

function computeDiversityPenalty(candidate: Candidate, selected: Candidate[]): number {
  let penalty = 0;
  for (const chosen of selected) {
    if (candidate.source !== null && candidate.source === chosen.source) {
      penalty = Math.max(penalty, SOURCE_DUPLICATE_PENALTY);
    }
    penalty = Math.max(
      penalty,
      tokenJaccard(candidate.doc.pageContent, chosen.doc.pageContent) * DIVERSITY_PENALTY,
    );
  }
  return penalty;
}

function compareScoredCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
  if (a.advancedScore !== b.advancedScore) return b.advancedScore - a.advancedScore;
  const aPrimary = a.candidate.primaryRank ?? Number.POSITIVE_INFINITY;
  const bPrimary = b.candidate.primaryRank ?? Number.POSITIVE_INFINITY;
  if (aPrimary !== bPrimary) return aPrimary - bPrimary;
  if (a.candidate.bestScore !== b.candidate.bestScore) return a.candidate.bestScore - b.candidate.bestScore;
  return a.candidate.firstSeen - b.candidate.firstSeen;
}

function toResultSignal(entry: ScoredCandidate): AdvancedResultSignal {
  return {
    chunk_id: entry.candidate.id,
    source: entry.candidate.source,
    positive_support: roundSignal(entry.candidate.positiveSupport),
    negative_similarity: roundSignal(entry.candidate.negativeSimilarity),
    diversity_penalty: roundSignal(entry.diversityPenalty),
    advanced_score: roundSignal(entry.advancedScore),
    component_ranks: entry.candidate.componentRanks,
  };
}

function isPositiveRole(role: AdvancedQueryRole): boolean {
  return role === 'primary' || role === 'plus';
}

function reciprocalRank(rank: number): number {
  return 1 / rank;
}

function sourceFromMetadata(metadata: Record<string, unknown>): string | null {
  if (typeof metadata.relativePath === 'string') return metadata.relativePath;
  if (typeof metadata.source === 'string') return metadata.source;
  return null;
}

function tokenJaccard(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_]+/u)
      .filter((token) => token.length >= 3),
  );
}

function roundSignal(value: number): number {
  return Number(value.toFixed(6));
}
