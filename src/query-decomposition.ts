import { callChatCompletion } from './llm-client.js';
import type { HybridChunk } from './hybrid-retrieval.js';
import { chunkIdFromMetadata } from './rrf.js';
import { DiskTieredDecompositionCache } from './decomposition-cache.js';
import type { DecompositionCache } from './decomposition-cache.js';
import { resolveLlmProvider } from './config/llm-provider.js';

export const QUERY_DECOMPOSITION_SCHEMA_VERSION = 'kb.search.query-decomposition.v1';

export type QueryDecompositionStopReason =
  | 'sufficient'
  | 'exhausted_subqueries'
  | 'max_iterations'
  | 'max_subqueries'
  | 'max_total_candidates'
  | 'timeout';

export interface QueryDecompositionBudget {
  maxSubqueries: number;
  maxIterations: number;
  maxTotalCandidates: number;
  timeoutMs: number;
}

export interface QuerySufficiencyJudgment {
  sufficient: boolean;
  missingAspects: string[];
}

export interface QueryDecompositionProvider {
  name: string;
  decompose(query: string): Promise<string[]>;
  judgeSufficiency(
    query: string,
    evidence: readonly QueryDecompositionEvidence[],
    history: readonly QueryDecompositionSubqueryTrace[],
  ): Promise<QuerySufficiencyJudgment>;
}

export interface QueryDecompositionEvidence {
  id: string;
  source: string | null;
  chunkIndex: number | null;
  score: number | null;
  firstSeenSubquery: string;
  retrieverQueryCount: number;
  content: string;
  metadata: Record<string, unknown>;
}

export interface QueryDecompositionSubqueryTrace {
  iteration: number;
  query: string;
  resultCount: number;
  newEvidenceCount: number;
  redundantEvidenceCount: number;
  evidenceIds: string[];
  missingAspects: string[];
  elapsedMs: number;
}

export interface QueryDecompositionTrace {
  schemaVersion: typeof QUERY_DECOMPOSITION_SCHEMA_VERSION;
  provider: string;
  originalQuery: string;
  budgets: QueryDecompositionBudget;
  subqueries: QueryDecompositionSubqueryTrace[];
  evidence: QueryDecompositionEvidence[];
  missingAspects: string[];
  stopReason: QueryDecompositionStopReason;
  retrievalCalls: number;
  elapsedMs: number;
}

export interface QueryDecompositionResult {
  results: HybridChunk[];
  trace: QueryDecompositionTrace;
}

export interface QueryDecompositionRunOptions {
  query: string;
  k: number;
  budget: QueryDecompositionBudget;
  provider: QueryDecompositionProvider;
  retrieveSubquery(query: string, remainingCandidateBudget: number): Promise<HybridChunk[]>;
  nowMs?: () => number;
}

export interface LocalLlmQueryDecomposerOptions {
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  cache?: DecompositionCache;
}

const PROVIDER_TIMEOUT = Symbol('query-decomposition-provider-timeout');

const DEFAULT_QUERY_DECOMPOSITION_BUDGET: QueryDecompositionBudget = {
  maxSubqueries: 4,
  maxIterations: 4,
  maxTotalCandidates: 80,
  timeoutMs: 30_000,
};

const STOPWORDS = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
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
  'who',
  'why',
  'with',
  'would',
]);

export function defaultQueryDecompositionBudget(
  overrides: Partial<QueryDecompositionBudget> = {},
): QueryDecompositionBudget {
  return validateQueryDecompositionBudget({ ...DEFAULT_QUERY_DECOMPOSITION_BUDGET, ...overrides });
}

export function validateQueryDecompositionBudget(budget: QueryDecompositionBudget): QueryDecompositionBudget {
  assertPositiveInteger(budget.maxSubqueries, 'maxSubqueries');
  assertPositiveInteger(budget.maxIterations, 'maxIterations');
  assertPositiveInteger(budget.maxTotalCandidates, 'maxTotalCandidates');
  assertPositiveInteger(budget.timeoutMs, 'timeoutMs');
  return budget;
}

export function createRuleBasedQueryDecomposer(): QueryDecompositionProvider {
  return {
    name: 'rule',
    async decompose(query) {
      return ruleBasedSubqueries(query);
    },
    async judgeSufficiency(query, evidence) {
      const planned = ruleBasedSubqueries(query);
      const missingAspects = missingAspectsForEvidence(planned, evidence);
      return { sufficient: missingAspects.length === 0, missingAspects };
    },
  };
}

export function createLocalLlmQueryDecomposer(
  fallback: QueryDecompositionProvider = createRuleBasedQueryDecomposer(),
  options: LocalLlmQueryDecomposerOptions = {},
): QueryDecompositionProvider {
  const cache = options.cache ?? new DiskTieredDecompositionCache();
  return {
    name: 'local-llm',
    async decompose(query) {
      const endpoint = resolveLocalLlmEndpoint(options);
      if (endpoint === null) return fallback.decompose(query);
      const model = resolveLocalLlmModel(options);
      const cached = cache.get(model, query);
      if (cached !== null) return cached;
      try {
        const result = await callChatCompletion({
          endpoint,
          model,
          operation: 'ask',
          temperature: 0,
          timeoutMs: options.timeoutMs ?? 30_000,
          retry: false,
          messages: [
            {
              role: 'system',
              content: 'Return strict JSON: {"subqueries":["..."]}. Split multi-hop retrieval questions into concise evidence-seeking subqueries.',
            },
            { role: 'user', content: query },
          ],
        });
        const parsed = parseLlmSubqueries(result.content);
        if (parsed.length === 0) return fallback.decompose(query);
        cache.set(model, query, parsed);
        return parsed;
      } catch {
        // Local LLM decomposition is best-effort; endpoint errors degrade to the
        // deterministic rule provider so opt-in retrieval stays usable offline.
        return fallback.decompose(query);
      }
    },
    async judgeSufficiency(query, evidence, history) {
      const endpoint = resolveLocalLlmEndpoint(options);
      if (endpoint === null) return fallback.judgeSufficiency(query, evidence, history);
      try {
        const result = await callChatCompletion({
          endpoint,
          model: options.model ?? process.env.KB_DECOMPOSE_LLM_MODEL ?? process.env.KB_LLM_MODEL,
          operation: 'ask',
          temperature: 0,
          timeoutMs: options.timeoutMs ?? 30_000,
          retry: false,
          messages: [
            {
              role: 'system',
              content: 'Return strict JSON: {"sufficient":boolean,"missing_aspects":["..."]}. Judge whether the evidence set, as a set, covers the question.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                query,
                subqueries: history.map((entry) => entry.query),
                evidence: evidence.slice(0, 20).map((entry) => ({
                  id: entry.id,
                  source: entry.source,
                  text: entry.content.slice(0, 800),
                })),
              }),
            },
          ],
        });
        const parsed = parseLlmSufficiency(result.content);
        return parsed ?? fallback.judgeSufficiency(query, evidence, history);
      } catch {
        // Local LLM sufficiency is best-effort for the same offline path as
        // decompose(): keep the bounded loop deterministic on provider failure.
        return fallback.judgeSufficiency(query, evidence, history);
      }
    },
  };
}

export async function runQueryDecomposition(
  options: QueryDecompositionRunOptions,
): Promise<QueryDecompositionResult> {
  const budget = validateQueryDecompositionBudget(options.budget);
  assertPositiveInteger(options.k, 'k');
  const now = options.nowMs ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + budget.timeoutMs;
  const decomposed = await callProviderWithinDeadline(
    () => options.provider.decompose(options.query),
    now,
    deadline,
  );
  if (decomposed.timedOut) {
    return emptyQueryDecompositionResult(options, budget, startedAt, now, 'timeout');
  }
  const rawSubqueries = decomposed.value;
  const subqueries = dedupeQueries([options.query, ...rawSubqueries]).slice(0, budget.maxSubqueries);
  const evidenceById = new Map<string, QueryDecompositionEvidence>();
  const history: QueryDecompositionSubqueryTrace[] = [];
  let stopReason: QueryDecompositionStopReason = 'exhausted_subqueries';
  let missingAspects: string[] = [];
  let retrievalCalls = 0;
  let totalCandidates = 0;

  for (const subquery of subqueries) {
    if (history.length >= budget.maxIterations) {
      stopReason = 'max_iterations';
      break;
    }
    if (now() >= deadline) {
      stopReason = 'timeout';
      break;
    }
    if (totalCandidates >= budget.maxTotalCandidates) {
      stopReason = 'max_total_candidates';
      break;
    }

    const iterationStartedAt = now();
    const remaining = Math.max(1, budget.maxTotalCandidates - totalCandidates);
    const perSubqueryLimit = Math.max(1, Math.ceil(budget.maxTotalCandidates / subqueries.length));
    const retrieved = (await options.retrieveSubquery(subquery, Math.min(remaining, perSubqueryLimit)))
      .slice(0, Math.min(remaining, perSubqueryLimit));
    retrievalCalls += 1;
    totalCandidates += retrieved.length;

    const evidenceIds: string[] = [];
    let newEvidenceCount = 0;
    let redundantEvidenceCount = 0;
    for (const candidate of retrieved) {
      const id = chunkIdFromMetadata(candidate.metadata);
      evidenceIds.push(id);
      const existing = evidenceById.get(id);
      if (existing !== undefined) {
        existing.retrieverQueryCount += 1;
        redundantEvidenceCount += 1;
        continue;
      }
      evidenceById.set(id, evidenceFromChunk(candidate, id, subquery));
      newEvidenceCount += 1;
    }

    const judgmentResult = await callProviderWithinDeadline(
      () => options.provider.judgeSufficiency(
        options.query,
        Array.from(evidenceById.values()),
        history,
      ),
      now,
      deadline,
    );
    if (judgmentResult.timedOut) {
      stopReason = 'timeout';
      history.push({
        iteration: history.length + 1,
        query: subquery,
        resultCount: retrieved.length,
        newEvidenceCount,
        redundantEvidenceCount,
        evidenceIds,
        missingAspects,
        elapsedMs: Math.max(0, now() - iterationStartedAt),
      });
      break;
    }
    const judgment = judgmentResult.value;
    missingAspects = judgment.missingAspects;
    history.push({
      iteration: history.length + 1,
      query: subquery,
      resultCount: retrieved.length,
      newEvidenceCount,
      redundantEvidenceCount,
      evidenceIds,
      missingAspects,
      elapsedMs: Math.max(0, now() - iterationStartedAt),
    });
    if (judgment.sufficient) {
      stopReason = 'sufficient';
      break;
    }
    if (totalCandidates >= budget.maxTotalCandidates) {
      stopReason = 'max_total_candidates';
      break;
    }
  }

  if (stopReason === 'exhausted_subqueries' && subqueries.length >= budget.maxSubqueries && history.length < rawSubqueries.length + 1) {
    stopReason = 'max_subqueries';
  }

  const evidence = Array.from(evidenceById.values());
  return {
    results: evidenceToResults(rankEvidenceForResults(evidence, options.query)).slice(0, options.k),
    trace: {
      schemaVersion: QUERY_DECOMPOSITION_SCHEMA_VERSION,
      provider: options.provider.name,
      originalQuery: options.query,
      budgets: budget,
      subqueries: history,
      evidence,
      missingAspects,
      stopReason,
      retrievalCalls,
      elapsedMs: Math.max(0, now() - startedAt),
    },
  };
}

function emptyQueryDecompositionResult(
  options: QueryDecompositionRunOptions,
  budget: QueryDecompositionBudget,
  startedAt: number,
  now: () => number,
  stopReason: QueryDecompositionStopReason,
): QueryDecompositionResult {
  return {
    results: [],
    trace: {
      schemaVersion: QUERY_DECOMPOSITION_SCHEMA_VERSION,
      provider: options.provider.name,
      originalQuery: options.query,
      budgets: budget,
      subqueries: [],
      evidence: [],
      missingAspects: [],
      stopReason,
      retrievalCalls: 0,
      elapsedMs: Math.max(0, now() - startedAt),
    },
  };
}

export function queryDecompositionTraceToJson(trace: QueryDecompositionTrace): Record<string, unknown> {
  return {
    schema_version: trace.schemaVersion,
    provider: trace.provider,
    original_query: trace.originalQuery,
    budgets: {
      max_subqueries: trace.budgets.maxSubqueries,
      max_iterations: trace.budgets.maxIterations,
      max_total_candidates: trace.budgets.maxTotalCandidates,
      timeout_ms: trace.budgets.timeoutMs,
    },
    subqueries: trace.subqueries.map((entry) => ({
      iteration: entry.iteration,
      query: entry.query,
      result_count: entry.resultCount,
      new_evidence_count: entry.newEvidenceCount,
      redundant_evidence_count: entry.redundantEvidenceCount,
      evidence_ids: entry.evidenceIds,
      missing_aspects: entry.missingAspects,
      elapsed_ms: entry.elapsedMs,
    })),
    evidence_groups: trace.evidence.map((entry) => ({
      id: entry.id,
      source: entry.source,
      chunk_index: entry.chunkIndex,
      score: entry.score,
      first_seen_subquery: entry.firstSeenSubquery,
      retriever_query_count: entry.retrieverQueryCount,
    })),
    missing_aspects: trace.missingAspects,
    stop_reason: trace.stopReason,
    retrieval_calls: trace.retrievalCalls,
    elapsed_ms: trace.elapsedMs,
  };
}

function evidenceFromChunk(candidate: HybridChunk, id: string, firstSeenSubquery: string): QueryDecompositionEvidence {
  return {
    id,
    source: sourceKey(candidate.metadata),
    chunkIndex: chunkIndex(candidate.metadata),
    score: typeof candidate.score === 'number' ? candidate.score : null,
    firstSeenSubquery,
    retrieverQueryCount: 1,
    content: candidate.pageContent,
    metadata: candidate.metadata,
  };
}

function evidenceToResults(evidence: readonly QueryDecompositionEvidence[]): HybridChunk[] {
  return evidence.map((entry) => ({
    pageContent: entry.content,
    metadata: entry.metadata,
    ...(entry.score !== null ? { score: entry.score } : {}),
  }));
}

function rankEvidenceForResults(
  evidence: readonly QueryDecompositionEvidence[],
  originalQuery: string,
): QueryDecompositionEvidence[] {
  return evidence
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const leftOriginalOnly = left.entry.firstSeenSubquery === originalQuery && left.entry.retrieverQueryCount === 1;
      const rightOriginalOnly = right.entry.firstSeenSubquery === originalQuery && right.entry.retrieverQueryCount === 1;
      if (leftOriginalOnly !== rightOriginalOnly) return leftOriginalOnly ? 1 : -1;
      if (left.entry.retrieverQueryCount !== right.entry.retrieverQueryCount) {
        return right.entry.retrieverQueryCount - left.entry.retrieverQueryCount;
      }
      return left.index - right.index;
    })
    .map(({ entry }) => entry);
}

async function callProviderWithinDeadline<T>(
  call: () => Promise<T>,
  now: () => number,
  deadline: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  const remainingMs = deadline - now();
  if (remainingMs <= 0) return { timedOut: true };
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<typeof PROVIDER_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(PROVIDER_TIMEOUT), remainingMs);
    });
    const result = await Promise.race([call(), timeout]);
    if (result === PROVIDER_TIMEOUT) return { timedOut: true };
    return { timedOut: false, value: result };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function ruleBasedSubqueries(query: string): string[] {
  const normalized = query.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (normalized === '') return [];
  const pieces = normalized
    .split(/\s+(?:and|then|while|where|which|who|that|because|before|after)\s+/iu)
    .map((piece) => trimQuestion(piece))
    .filter((piece) => piece.length > 0);
  const out = pieces.length > 1 ? pieces : [normalized];

  const between = /\bbetween\s+(.+?)\s+and\s+(.+?)(?:[?.]|$)/iu.exec(normalized);
  if (between !== null) {
    out.push(between[1].trim());
    out.push(between[2].trim());
  }
  return dedupeQueries(out);
}

function missingAspectsForEvidence(
  subqueries: readonly string[],
  evidence: readonly QueryDecompositionEvidence[],
): string[] {
  const haystack = evidence
    .map((entry) => `${entry.content} ${entry.source ?? ''}`)
    .join(' ')
    .toLocaleLowerCase();
  return subqueries.filter((subquery) => {
    const anchors = anchorTerms(subquery);
    if (anchors.length === 0) return evidence.length === 0;
    return !anchors.some((anchor) => haystack.includes(anchor));
  });
}

function anchorTerms(text: string): string[] {
  const tokens = text.normalize('NFKC').match(/[\p{L}\p{N}_./:@+-]+/gu) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tokens) {
    const token = raw.toLocaleLowerCase();
    if (token.length < 3 || STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function parseLlmSubqueries(raw: string): string[] {
  const parsed = JSON.parse(extractJsonObject(raw)) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.subqueries)) return [];
  return dedupeQueries(parsed.subqueries.filter((item): item is string => typeof item === 'string'));
}

function parseLlmSufficiency(raw: string): QuerySufficiencyJudgment | null {
  const parsed = JSON.parse(extractJsonObject(raw)) as unknown;
  if (!isRecord(parsed) || typeof parsed.sufficient !== 'boolean') return null;
  const rawMissing = parsed.missing_aspects ?? parsed.missingAspects;
  const missingAspects = Array.isArray(rawMissing)
    ? rawMissing.filter((item): item is string => typeof item === 'string')
    : [];
  return { sufficient: parsed.sufficient, missingAspects };
}

function extractJsonObject(raw: string): string {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('LLM response did not contain a JSON object');
  return raw.slice(start, end + 1);
}

function resolveLocalLlmEndpoint(options: LocalLlmQueryDecomposerOptions): string | null {
  const raw = options.endpoint ?? process.env.KB_DECOMPOSE_LLM_ENDPOINT ?? process.env.KB_LLM_ENDPOINT;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.trim();
}

function resolveLocalLlmModel(options: LocalLlmQueryDecomposerOptions): string {
  return options.model ?? process.env.KB_DECOMPOSE_LLM_MODEL ?? resolveLlmProvider().model ?? 'local-model';
}

function dedupeQueries(queries: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const query of queries) {
    const normalized = trimQuestion(query);
    const key = normalized.toLocaleLowerCase();
    if (normalized === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function trimQuestion(query: string): string {
  return query.normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/^[,;: -]+|[,;: -]+$/g, '');
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

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
