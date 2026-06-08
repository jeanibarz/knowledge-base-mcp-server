import { createHash } from 'crypto';
import type { HybridChunk } from './hybrid-retrieval.js';
import { chunkIdFromMetadata } from './rrf.js';

export const HIGH_RECALL_CANDIDATE_SCHEMA_VERSION = 'kb.search.high-recall-candidates.v1';

export type HighRecallFilterReason =
  | 'duplicate_collapse'
  | 'source_diversity_cap'
  | 'anchor_filter';

export interface HighRecallFilterOptions {
  query: string;
  candidates: readonly HybridChunk[];
  k: number;
  candidatePoolK: number;
  denseDistanceById?: ReadonlyMap<string, number>;
  lexicalHitIds?: ReadonlySet<string>;
  sourceDiversityCap?: number;
  maxDiagnosticCandidates?: number;
}

export interface HighRecallCandidateDiagnostic {
  id: string;
  source: string | null;
  chunkIndex: number | null;
  retrievers: Array<'dense' | 'lexical'>;
  reason: HighRecallFilterReason;
}

export interface HighRecallCollapsedGroup {
  keptId: string;
  collapsedIds: string[];
  source: string | null;
  reason: 'duplicate_collapse';
}

export interface HighRecallFilterDiagnostics {
  schemaVersion: typeof HIGH_RECALL_CANDIDATE_SCHEMA_VERSION;
  enabled: true;
  candidatePoolK: number;
  finalK: number;
  sourceDiversityCap: number;
  queryAnchors: string[];
  preFilterCount: number;
  postFilterCount: number;
  collapsedGroups: HighRecallCollapsedGroup[];
  removed: HighRecallCandidateDiagnostic[];
  reasonCounts: Record<HighRecallFilterReason, number>;
  anchorFilterRelaxed: boolean;
  neighborExpansionMatches: number;
  recallCandidates: {
    dense: number;
    lexical: number;
    both: number;
  };
}

export interface HighRecallFilterResult {
  results: HybridChunk[];
  diagnostics: HighRecallFilterDiagnostics;
}

const DEFAULT_SOURCE_DIVERSITY_CAP = 3;
const DEFAULT_MAX_DIAGNOSTIC_CANDIDATES = 50;

const STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'also',
  'and',
  'are',
  'because',
  'before',
  'between',
  'but',
  'can',
  'could',
  'does',
  'for',
  'from',
  'has',
  'have',
  'how',
  'into',
  'not',
  'our',
  'that',
  'the',
  'their',
  'then',
  'there',
  'this',
  'through',
  'was',
  'what',
  'when',
  'where',
  'which',
  'with',
  'would',
]);

export function resolveCandidatePoolK(finalK: number, candidatePoolK: number | undefined): number | null {
  if (candidatePoolK === undefined) return null;
  assertPositiveInteger(finalK, 'k');
  assertPositiveInteger(candidatePoolK, 'candidatePoolK');
  if (candidatePoolK < finalK) {
    throw new Error(`candidatePoolK must be >= k (got candidatePoolK=${candidatePoolK}, k=${finalK})`);
  }
  return candidatePoolK;
}

export function applyHighRecallCandidateFilters(input: HighRecallFilterOptions): HighRecallFilterResult {
  assertPositiveInteger(input.k, 'k');
  assertPositiveInteger(input.candidatePoolK, 'candidatePoolK');
  if (input.candidatePoolK < input.k) {
    throw new Error(`candidatePoolK must be >= k (got candidatePoolK=${input.candidatePoolK}, k=${input.k})`);
  }
  const sourceDiversityCap = input.sourceDiversityCap ?? DEFAULT_SOURCE_DIVERSITY_CAP;
  assertPositiveInteger(sourceDiversityCap, 'sourceDiversityCap');
  const maxDiagnostics = input.maxDiagnosticCandidates ?? DEFAULT_MAX_DIAGNOSTIC_CANDIDATES;
  assertPositiveInteger(maxDiagnostics, 'maxDiagnosticCandidates');

  const candidates = input.candidates.slice(0, input.candidatePoolK);
  const queryAnchors = extractAnchorTerms(input.query);
  const reasonCounts: Record<HighRecallFilterReason, number> = {
    duplicate_collapse: 0,
    source_diversity_cap: 0,
    anchor_filter: 0,
  };
  const removed: HighRecallCandidateDiagnostic[] = [];
  const collapsedGroups: HighRecallCollapsedGroup[] = [];
  const duplicateByFingerprint = new Map<string, { id: string; source: string | null }>();
  const sourceCounts = new Map<string, number>();
  const dedupedAndCapped: HybridChunk[] = [];

  const recordRemoval = (candidate: HybridChunk, reason: HighRecallFilterReason): void => {
    reasonCounts[reason] += 1;
    if (removed.length >= maxDiagnostics) return;
    removed.push(candidateDiagnostic(candidate, reason, input));
  };

  for (const candidate of candidates) {
    const fingerprint = duplicateFingerprint(candidate);
    const duplicate = duplicateByFingerprint.get(fingerprint);
    if (duplicate !== undefined) {
      recordRemoval(candidate, 'duplicate_collapse');
      const existing = collapsedGroups.find((group) => group.keptId === duplicate.id);
      const id = chunkIdFromMetadata(candidate.metadata);
      if (existing !== undefined) {
        existing.collapsedIds.push(id);
      } else {
        collapsedGroups.push({
          keptId: duplicate.id,
          collapsedIds: [id],
          source: duplicate.source,
          reason: 'duplicate_collapse',
        });
      }
      continue;
    }
    duplicateByFingerprint.set(fingerprint, {
      id: chunkIdFromMetadata(candidate.metadata),
      source: sourceKey(candidate.metadata),
    });

    const source = sourceKey(candidate.metadata) ?? '<unknown>';
    const sourceCount = sourceCounts.get(source) ?? 0;
    if (sourceCount >= sourceDiversityCap && dedupedAndCapped.length >= input.k) {
      recordRemoval(candidate, 'source_diversity_cap');
      continue;
    }
    sourceCounts.set(source, sourceCount + 1);
    dedupedAndCapped.push(candidate);
  }

  let anchorFilterRelaxed = false;
  let neighborExpansionMatches = 0;
  let filtered = dedupedAndCapped;
  if (queryAnchors.length > 0) {
    const anchoredKeys = anchoredChunkKeys(dedupedAndCapped, queryAnchors, input);
    const anchoredOrNeighbor = dedupedAndCapped.filter((candidate) => {
      const key = sourceChunkKey(candidate.metadata);
      if (key === null) return isAnchoredCandidate(candidate, queryAnchors, input);
      if (anchoredKeys.has(key)) return true;
      if (isNeighborOfAnchoredChunk(key, anchoredKeys)) {
        neighborExpansionMatches += 1;
        return true;
      }
      return isAnchoredCandidate(candidate, queryAnchors, input);
    });
    if (anchoredOrNeighbor.length >= Math.min(input.k, dedupedAndCapped.length)) {
      const keptIds = new Set(anchoredOrNeighbor.map((candidate) => chunkIdFromMetadata(candidate.metadata)));
      for (const candidate of dedupedAndCapped) {
        if (!keptIds.has(chunkIdFromMetadata(candidate.metadata))) {
          recordRemoval(candidate, 'anchor_filter');
        }
      }
      filtered = anchoredOrNeighbor;
    } else {
      anchorFilterRelaxed = true;
    }
  }

  const diagnostics: HighRecallFilterDiagnostics = {
    schemaVersion: HIGH_RECALL_CANDIDATE_SCHEMA_VERSION,
    enabled: true,
    candidatePoolK: input.candidatePoolK,
    finalK: input.k,
    sourceDiversityCap,
    queryAnchors,
    preFilterCount: candidates.length,
    postFilterCount: filtered.length,
    collapsedGroups,
    removed,
    reasonCounts,
    anchorFilterRelaxed,
    neighborExpansionMatches,
    recallCandidates: countRetrieverProvenance(candidates, input),
  };

  return { results: filtered, diagnostics };
}

export function highRecallDiagnosticsToJson(
  diagnostics: HighRecallFilterDiagnostics,
): Record<string, unknown> {
  return {
    schema_version: diagnostics.schemaVersion,
    enabled: diagnostics.enabled,
    candidate_pool_k: diagnostics.candidatePoolK,
    final_k: diagnostics.finalK,
    source_diversity_cap: diagnostics.sourceDiversityCap,
    query_anchors: diagnostics.queryAnchors,
    pre_filter_count: diagnostics.preFilterCount,
    post_filter_count: diagnostics.postFilterCount,
    collapsed_groups: diagnostics.collapsedGroups.map((group) => ({
      kept_id: group.keptId,
      collapsed_ids: group.collapsedIds,
      source: group.source,
      reason: group.reason,
    })),
    removed: diagnostics.removed.map((candidate) => ({
      id: candidate.id,
      source: candidate.source,
      chunk_index: candidate.chunkIndex,
      retrievers: candidate.retrievers,
      reason: candidate.reason,
    })),
    reason_counts: diagnostics.reasonCounts,
    anchor_filter_relaxed: diagnostics.anchorFilterRelaxed,
    neighbor_expansion_matches: diagnostics.neighborExpansionMatches,
    recall_candidates: diagnostics.recallCandidates,
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function extractAnchorTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const tokens = text.normalize('NFKC').match(/[\p{L}\p{N}_./:@+-]+/gu) ?? [];
  for (const raw of tokens) {
    const token = raw.toLocaleLowerCase();
    if (token.length < 3) continue;
    if (STOPWORDS.has(token)) continue;
    if (!/[\p{L}\p{N}]/u.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function candidateDiagnostic(
  candidate: HybridChunk,
  reason: HighRecallFilterReason,
  input: Pick<HighRecallFilterOptions, 'denseDistanceById' | 'lexicalHitIds'>,
): HighRecallCandidateDiagnostic {
  const id = chunkIdFromMetadata(candidate.metadata);
  return {
    id,
    source: sourceKey(candidate.metadata),
    chunkIndex: chunkIndex(candidate.metadata),
    retrievers: retrieversForId(id, input),
    reason,
  };
}

function countRetrieverProvenance(
  candidates: readonly HybridChunk[],
  input: Pick<HighRecallFilterOptions, 'denseDistanceById' | 'lexicalHitIds'>,
): HighRecallFilterDiagnostics['recallCandidates'] {
  let dense = 0;
  let lexical = 0;
  let both = 0;
  for (const candidate of candidates) {
    const retrievers = retrieversForId(chunkIdFromMetadata(candidate.metadata), input);
    if (retrievers.includes('dense')) dense += 1;
    if (retrievers.includes('lexical')) lexical += 1;
    if (retrievers.length === 2) both += 1;
  }
  return { dense, lexical, both };
}

function retrieversForId(
  id: string,
  input: Pick<HighRecallFilterOptions, 'denseDistanceById' | 'lexicalHitIds'>,
): Array<'dense' | 'lexical'> {
  const out: Array<'dense' | 'lexical'> = [];
  if (input.denseDistanceById?.has(id)) out.push('dense');
  if (input.lexicalHitIds?.has(id)) out.push('lexical');
  return out;
}

function anchoredChunkKeys(
  candidates: readonly HybridChunk[],
  queryAnchors: readonly string[],
  input: Pick<HighRecallFilterOptions, 'denseDistanceById' | 'lexicalHitIds'>,
): Set<string> {
  const keys = new Set<string>();
  for (const candidate of candidates) {
    if (!isAnchoredCandidate(candidate, queryAnchors, input)) continue;
    const key = sourceChunkKey(candidate.metadata);
    if (key !== null) keys.add(key);
  }
  return keys;
}

function isAnchoredCandidate(
  candidate: HybridChunk,
  queryAnchors: readonly string[],
  input: Pick<HighRecallFilterOptions, 'denseDistanceById' | 'lexicalHitIds'>,
): boolean {
  const id = chunkIdFromMetadata(candidate.metadata);
  if (input.lexicalHitIds?.has(id)) return true;
  const text = `${candidate.pageContent} ${sourceKey(candidate.metadata) ?? ''}`.toLocaleLowerCase();
  return queryAnchors.some((anchor) => text.includes(anchor));
}

function isNeighborOfAnchoredChunk(key: string, anchoredKeys: ReadonlySet<string>): boolean {
  const splitAt = key.lastIndexOf('#');
  if (splitAt < 0) return false;
  const source = key.slice(0, splitAt);
  const index = Number(key.slice(splitAt + 1));
  if (!Number.isSafeInteger(index)) return false;
  return anchoredKeys.has(`${source}#${index - 1}`) || anchoredKeys.has(`${source}#${index + 1}`);
}

function sourceChunkKey(metadata: Record<string, unknown>): string | null {
  const source = sourceKey(metadata);
  const index = chunkIndex(metadata);
  if (source === null || index === null) return null;
  return `${source}#${index}`;
}

function duplicateFingerprint(candidate: HybridChunk): string {
  const source = sourceKey(candidate.metadata) ?? '';
  const normalizedContent = candidate.pageContent
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
  return createHash('sha1').update(source).update('\0').update(normalizedContent).digest('hex');
}

function sourceKey(metadata: Record<string, unknown>): string | null {
  const relativePath = metadata.relativePath;
  if (typeof relativePath === 'string' && relativePath.length > 0) return relativePath;
  const source = metadata.source;
  if (typeof source === 'string' && source.length > 0) return source;
  return null;
}

function chunkIndex(metadata: Record<string, unknown>): number | null {
  const raw = metadata.chunkIndex;
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}
