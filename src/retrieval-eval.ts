import * as path from 'path';
import { minimatch } from 'minimatch';
import type { FaissIndexManager } from './FaissIndexManager.js';
import type { ScoredDocument } from './formatter.js';
import {
  resolveAutoSearchMode,
  type AutoSearchModeDecision,
  type EffectiveSearchMode,
  type SearchMode,
  type Staleness,
} from './search-core.js';
import { LexicalIndex, lexicalIndexFilePath, type LexicalSearchResult } from './lexical-index.js';
import {
  fuseHybridResults,
  hybridFetchK,
  listLexicalKbs,
} from './hybrid-retrieval.js';
import { applyRerankerIfEnabled, resolveRerankerConfig } from './reranker.js';
import {
  KB_RETRIEVAL_VIEWS_ENV,
  RETRIEVAL_VIEW_KINDS,
  formatRetrievalViews,
  parseRetrievalViews,
  type RetrievalViewKind,
} from './retrieval-views.js';
import { withWriteLock } from './write-lock.js';

export type StalePolicy = 'allow_stale' | 'fresh' | 'stale';

export interface ExpectedMetadataRule {
  path: string;
  equals: unknown;
}

export interface RelevanceJudgment {
  source: string;
  relevance: number;
  groups?: string[];
}

export interface RetrievalEvalRankedMetrics {
  k: number;
  judgedRelevantCount: number;
  retrievedRelevantCount: number;
  ndcgAt10: number;
  mrrAt10: number;
  recallAtK: number;
  precisionAtK: number;
  map: number;
  mapAtK: number;
  hitRate: number;
}

export interface RetrievalEvalSourceDiversityMetrics {
  k: number;
  resultCount: number;
  uniqueSourceCountAtK: number;
  duplicateSourceGroupsAtK: number;
  maxSourceShareAtK: number;
}

export interface RetrievalEvalIntentDiversityMetrics {
  k: number;
  groupCount: number;
  retrievedGroupCountAtK: number;
  intentRecallAtK: number;
  alphaNdcgAtK: number;
}

export interface RetrievalEvalDiversityMetrics {
  source: RetrievalEvalSourceDiversityMetrics;
  intent?: RetrievalEvalIntentDiversityMetrics;
}

export interface RetrievalEvalAggregateRankedMetrics {
  judgedCaseCount: number;
  ndcgAt10: number;
  mrrAt10: number;
  recallAtK: number;
  precisionAtK: number;
  map: number;
  mapAtK: number;
  hitRate: number;
}

export interface RetrievalEvalAggregateDiversityMetrics {
  source: {
    caseCount: number;
    uniqueSourceCountAtK: number;
    duplicateSourceGroupsAtK: number;
    maxSourceShareAtK: number;
  };
  intent?: {
    caseCount: number;
    intentRecallAtK: number;
    alphaNdcgAtK: number;
  };
}

export interface RetrievalEvalCase {
  name: string;
  query: string;
  kb?: string;
  k?: number;
  threshold?: number;
  mode?: SearchMode;
  retrievalViews?: RetrievalViewKind[];
  gate?: boolean;
  requiredSources: string[];
  forbiddenSources: string[];
  expectedMetadata: ExpectedMetadataRule[];
  expectedGateVerdict?: ExpectedGateVerdict;
  relevanceJudgments?: RelevanceJudgment[];
  maxDuplicateGroups?: number;
  stalePolicy: StalePolicy;
}

export interface ExpectedGateVerdict {
  state: 'bypassed' | 'empty-index' | 'injected' | 'no-relevant-context';
  provenance?: 'human-labeled' | 'judge-suggested';
  verification?: 'verified' | 'unverified';
}

export interface RetrievalEvalCaseInput {
  name?: string;
  query: string;
  kb?: string;
  k?: number;
  threshold?: number;
  mode?: SearchMode;
  retrieval_views?: string;
  retrievalViews?: string;
  gate?: boolean;
  required_sources?: string[];
  forbidden_sources?: string[];
  relevant_sources?: Array<string | { source?: unknown; relevance?: unknown }>;
  judgments?: Record<string, unknown> | Array<string | { source?: unknown; relevance?: unknown }>;
  expected_metadata?: Record<string, unknown> | Array<Record<string, unknown>>;
  expected_gate_verdict?: string | {
    state?: unknown;
    provenance?: unknown;
    verification?: unknown;
  };
  max_duplicate_groups?: number;
  stale_policy?: StalePolicy | { expect?: StalePolicy };
}

export interface RetrievalEvalFixture {
  gate: boolean;
  mode?: SearchMode;
  cases: RetrievalEvalCase[];
}

export interface RetrievalEvalCaseResult {
  name: string;
  query: string;
  kb?: string;
  requestedMode: SearchMode;
  effectiveMode: EffectiveSearchMode;
  autoMode?: AutoSearchModeDecision;
  gate: boolean;
  expectedGateVerdict?: ExpectedGateVerdict;
  passed: boolean;
  failures: string[];
  warnings: string[];
  resultCount: number;
  duplicateGroups: number;
  diversityMetrics: RetrievalEvalDiversityMetrics;
  rankedMetrics?: RetrievalEvalRankedMetrics;
}

export interface RetrievalEvalReport {
  cases: RetrievalEvalCaseResult[];
  total: number;
  passed: number;
  failed: number;
  gateFailed: number;
  expectedGateVerdictWarnings: number;
  diversityMetrics: RetrievalEvalAggregateDiversityMetrics;
  rankedMetrics?: RetrievalEvalAggregateRankedMetrics;
}

export interface RetrievalEvalSearchContext {
  manager: Pick<FaissIndexManager, 'similaritySearch'>;
  defaultK: number;
  defaultThreshold: number;
  retrieveLexical?: (
    query: string,
    k: number,
    scopedKb?: string,
    retrievalViews?: RetrievalViewKind[],
  ) => Promise<ScoredDocument[]>;
}

export interface RetrievalEvalSearchResult {
  results: ScoredDocument[];
  requestedMode: SearchMode;
  effectiveMode: EffectiveSearchMode;
  autoMode?: AutoSearchModeDecision;
  gateVerdictState?: ExpectedGateVerdict['state'];
}

export interface RetrievalEvalScaffoldOptions {
  query: string;
  kb?: string;
  k: number;
  threshold?: number;
  mode?: SearchMode;
  maxRequiredSources?: number;
  staleness?: Staleness;
}

export interface RetrievalEvalScaffoldFixtureInput {
  gate: false;
  cases: RetrievalEvalScaffoldCaseInput[];
}

export interface RetrievalEvalScaffoldCaseInput {
  name: string;
  query: string;
  kb?: string;
  k: number;
  threshold?: number;
  mode?: SearchMode;
  required_sources: string[];
  expected_metadata?: Record<string, unknown>;
  stale_policy: StalePolicy;
}

const DEFAULT_SCAFFOLD_REQUIRED_SOURCES = 3;
const SCAFFOLD_METADATA_PATHS = [
  'frontmatter.status',
  'frontmatter.owner',
  'frontmatter.review_status',
  'frontmatter.review.status',
  'frontmatter.type',
  'frontmatter.category',
  'frontmatter.topic',
] as const;

export function normalizeRetrievalEvalFixture(input: unknown): RetrievalEvalFixture {
  if (!isRecord(input)) {
    throw new Error('fixture must be an object with a cases array');
  }
  const gate = readOptionalBoolean(input, 'gate') ?? false;
  const rawCases = input.cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error('fixture cases must be a non-empty array');
  }
  return {
    gate,
    ...readOptionalSearchMode(input, 'mode', 'fixture'),
    cases: rawCases.map((raw, idx) => normalizeCase(raw, idx + 1)),
  };
}

export function buildRetrievalEvalScaffoldFixture(
  results: readonly ScoredDocument[],
  options: RetrievalEvalScaffoldOptions,
): RetrievalEvalScaffoldFixtureInput {
  const requiredSources = selectRequiredSources(
    results,
    options.maxRequiredSources ?? DEFAULT_SCAFFOLD_REQUIRED_SOURCES,
  );
  const expectedMetadata = selectExpectedMetadata(results, new Set(requiredSources));
  const fixture: RetrievalEvalScaffoldFixtureInput = {
    gate: false,
    cases: [{
      name: scaffoldCaseName(options.query),
      query: options.query,
      ...(options.kb !== undefined ? { kb: options.kb } : {}),
      k: options.k,
      ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      required_sources: requiredSources,
      ...(Object.keys(expectedMetadata).length > 0 ? { expected_metadata: expectedMetadata } : {}),
      stale_policy: scaffoldStalePolicy(options.staleness),
    }],
  };
  normalizeRetrievalEvalFixture(fixture);
  return fixture;
}

export async function retrieveForRetrievalEvalCase(
  fixtureCase: RetrievalEvalCase,
  context: RetrievalEvalSearchContext,
  requestedMode: SearchMode,
): Promise<RetrievalEvalSearchResult> {
  const mode = resolveRetrievalEvalMode(requestedMode, fixtureCase.query);
  let results: ScoredDocument[];
  if (mode.effectiveMode === 'dense') {
    results = await retrieveDense(fixtureCase, context);
  } else if (mode.effectiveMode === 'lexical') {
    results = await (context.retrieveLexical ?? retrieveLexical)(
      fixtureCase.query,
      fixtureCase.k ?? context.defaultK,
      fixtureCase.kb,
      retrievalViewsForCase(fixtureCase),
    );
  } else {
    results = await retrieveHybrid(fixtureCase, context);
  }
  return { ...mode, results };
}

export function resolveRetrievalEvalMode(
  requestedMode: SearchMode,
  query: string,
): Omit<RetrievalEvalSearchResult, 'results'> {
  if (requestedMode !== 'auto') {
    return { requestedMode, effectiveMode: requestedMode };
  }
  const autoMode = resolveAutoSearchMode(query);
  return {
    requestedMode,
    effectiveMode: autoMode.mode,
    autoMode,
  };
}

export function evaluateRetrievalCase(
  fixtureCase: RetrievalEvalCase,
  results: readonly ScoredDocument[],
  staleness: Staleness,
  fixtureGate = false,
  search?: Omit<RetrievalEvalSearchResult, 'results'>,
): RetrievalEvalCaseResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const required of fixtureCase.requiredSources) {
    if (!results.some((doc) => documentMatchesSource(doc, required))) {
      failures.push(`missing required source: ${required}`);
    }
  }

  for (const forbidden of fixtureCase.forbiddenSources) {
    if (results.some((doc) => documentMatchesSource(doc, forbidden))) {
      failures.push(`forbidden source present: ${forbidden}`);
    }
  }

  for (const expected of fixtureCase.expectedMetadata) {
    if (!results.some((doc) => metadataMatchesRule(doc.metadata, expected))) {
      failures.push(`expected metadata not found: ${expected.path} = ${JSON.stringify(expected.equals)}`);
    }
  }

  const duplicateGroups = countDuplicateSourceGroups(results);
  if (
    fixtureCase.maxDuplicateGroups !== undefined &&
    duplicateGroups > fixtureCase.maxDuplicateGroups
  ) {
    failures.push(
      `duplicate source groups ${duplicateGroups} exceeds budget ${fixtureCase.maxDuplicateGroups}`,
    );
  }

  const stale = isStale(staleness);
  if (fixtureCase.stalePolicy === 'fresh' && stale) {
    failures.push('stale policy expected fresh results, but the index has modified/new files');
  } else if (fixtureCase.stalePolicy === 'stale' && !stale) {
    failures.push('stale policy expected stale results, but the index is fresh');
  } else if (fixtureCase.stalePolicy === 'allow_stale' && stale) {
    warnings.push('index has modified/new files, but stale_policy allows stale results');
  }

  const gate = fixtureCase.gate ?? fixtureGate;
  if (fixtureCase.expectedGateVerdict !== undefined) {
    if (search?.gateVerdictState === undefined) {
      warnings.push(
        `expected gate verdict ${fixtureCase.expectedGateVerdict.state} was not checked; retrieval path did not report a gate verdict`,
      );
    } else if (search.gateVerdictState !== fixtureCase.expectedGateVerdict.state) {
      warnings.push(
        `expected gate verdict ${fixtureCase.expectedGateVerdict.state}, got ${search.gateVerdictState}`,
      );
    }
    if (
      fixtureCase.expectedGateVerdict.provenance === 'judge-suggested' &&
      fixtureCase.expectedGateVerdict.verification === 'unverified'
    ) {
      warnings.push('expected gate verdict is judge-suggested and unverified');
    }
  }
  const rankedMetrics = computeRankedMetrics(fixtureCase, results);
  const diversityMetrics = computeDiversityMetrics(fixtureCase, results);
  return {
    name: fixtureCase.name,
    query: fixtureCase.query,
    ...(fixtureCase.kb !== undefined ? { kb: fixtureCase.kb } : {}),
    requestedMode: search?.requestedMode ?? 'dense',
    effectiveMode: search?.effectiveMode ?? 'dense',
    ...(search?.autoMode !== undefined ? { autoMode: search.autoMode } : {}),
    gate,
    ...(fixtureCase.expectedGateVerdict !== undefined
      ? { expectedGateVerdict: fixtureCase.expectedGateVerdict }
      : {}),
    passed: failures.length === 0,
    failures,
    warnings,
    resultCount: results.length,
    duplicateGroups,
    diversityMetrics,
    ...(rankedMetrics !== undefined ? { rankedMetrics } : {}),
  };
}

export function summarizeRetrievalEval(results: RetrievalEvalCaseResult[]): RetrievalEvalReport {
  const failed = results.filter((r) => !r.passed).length;
  const rankedMetrics = summarizeRankedMetrics(results);
  const diversityMetrics = summarizeDiversityMetrics(results);
  return {
    cases: results,
    total: results.length,
    passed: results.length - failed,
    failed,
    gateFailed: results.filter((r) => r.gate && !r.passed).length,
    expectedGateVerdictWarnings: results.filter((r) =>
      r.expectedGateVerdict !== undefined &&
      r.warnings.some((warning) => warning.startsWith('expected gate verdict')),
    ).length,
    diversityMetrics,
    ...(rankedMetrics !== undefined ? { rankedMetrics } : {}),
  };
}

export function retrievalEvalExitCode(report: RetrievalEvalReport): number {
  return report.gateFailed > 0 ? 1 : 0;
}

export function formatRetrievalEvalMarkdown(report: RetrievalEvalReport): string {
  const lines = ['# kb eval', ''];
  for (const result of report.cases) {
    const status = result.passed ? 'PASS' : result.gate ? 'FAIL' : 'WARN';
    const scope = result.kb === undefined ? 'all KBs' : `kb=${result.kb}`;
    const mode = result.requestedMode === result.effectiveMode
      ? result.effectiveMode
      : `${result.requestedMode} -> ${result.effectiveMode}`;
    const ranked = result.rankedMetrics === undefined
      ? ''
      : `, ranked: ${formatRankedMetrics(result.rankedMetrics)}`;
    const diversity = `, diversity: ${formatDiversityMetrics(result.diversityMetrics)}`;
    const expectedGate = result.expectedGateVerdict === undefined
      ? ''
      : `, expected gate: ${result.expectedGateVerdict.state}`;
    lines.push(
      `- ${status} ${result.name} (${scope}, mode: ${mode}, ${result.resultCount} result(s), duplicate groups: ${result.duplicateGroups}${expectedGate}${ranked}${diversity})`,
    );
    for (const failure of result.failures) {
      lines.push(`  - ${failure}`);
    }
    for (const warning of result.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  lines.push('');
  lines.push(
    `Summary: ${report.passed}/${report.total} passed; ${report.failed} failed; ${report.gateFailed} gate failure(s); ${report.expectedGateVerdictWarnings} expected gate warning(s).`,
  );
  if (report.rankedMetrics !== undefined) {
    lines.push(`Ranked metrics: ${formatAggregateRankedMetrics(report.rankedMetrics)}.`);
  }
  lines.push(`Diversity metrics: ${formatAggregateDiversityMetrics(report.diversityMetrics)}.`);
  return `${lines.join('\n')}\n`;
}

function normalizeCase(raw: unknown, caseNumber: number): RetrievalEvalCase {
  if (!isRecord(raw)) {
    throw new Error(`case ${caseNumber} must be an object`);
  }
  const query = readRequiredString(raw, 'query', `case ${caseNumber}`);
  const kb = readOptionalString(raw, 'kb');
  const k = readOptionalPositiveInteger(raw, 'k');
  const threshold = readOptionalPositiveNumber(raw, 'threshold');
  const gate = readOptionalBoolean(raw, 'gate');
  const retrievalViewsRaw = readOptionalString(raw, 'retrieval_views') ?? readOptionalString(raw, 'retrievalViews');
  const retrievalViews = retrievalViewsRaw === undefined ? undefined : parseRetrievalViews(retrievalViewsRaw);
  const maxDuplicateGroups = readOptionalNonNegativeInteger(raw, 'max_duplicate_groups');
  const relevanceJudgments = normalizeRelevanceJudgments(raw, caseNumber);
  const expectedGateVerdict = normalizeExpectedGateVerdict(raw.expected_gate_verdict, caseNumber);
  return {
    name: readOptionalString(raw, 'name') ?? `case ${caseNumber}`,
    query,
    ...(kb !== undefined ? { kb } : {}),
    ...(k !== undefined ? { k } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...readOptionalSearchMode(raw, 'mode', `case ${caseNumber}`),
    ...(retrievalViews !== undefined && retrievalViews.length > 0 ? { retrievalViews } : {}),
    ...(gate !== undefined ? { gate } : {}),
    requiredSources: readOptionalStringArray(raw, 'required_sources') ?? [],
    forbiddenSources: readOptionalStringArray(raw, 'forbidden_sources') ?? [],
    expectedMetadata: normalizeExpectedMetadata(raw.expected_metadata, caseNumber),
    ...(expectedGateVerdict !== undefined ? { expectedGateVerdict } : {}),
    ...(relevanceJudgments.length > 0 ? { relevanceJudgments } : {}),
    ...(maxDuplicateGroups !== undefined ? { maxDuplicateGroups } : {}),
    stalePolicy: normalizeStalePolicy(raw.stale_policy, caseNumber),
  };
}

function normalizeExpectedGateVerdict(
  raw: unknown,
  caseNumber: number,
): ExpectedGateVerdict | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') {
    return { state: normalizeGateVerdictState(raw, `case ${caseNumber} expected_gate_verdict`) };
  }
  if (!isRecord(raw)) {
    throw new Error(`case ${caseNumber} expected_gate_verdict must be a string or object`);
  }
  const state = normalizeGateVerdictState(raw.state, `case ${caseNumber} expected_gate_verdict.state`);
  const provenance = normalizeGateVerdictProvenance(raw.provenance, caseNumber);
  const verification = normalizeGateVerdictVerification(raw.verification, caseNumber);
  return {
    state,
    ...(provenance !== undefined ? { provenance } : {}),
    ...(verification !== undefined ? { verification } : {}),
  };
}

function normalizeGateVerdictState(
  raw: unknown,
  context: string,
): ExpectedGateVerdict['state'] {
  if (
    raw === 'bypassed' ||
    raw === 'empty-index' ||
    raw === 'injected' ||
    raw === 'no-relevant-context'
  ) {
    return raw;
  }
  throw new Error(`${context} must be "bypassed", "empty-index", "injected", or "no-relevant-context"`);
}

function normalizeGateVerdictProvenance(
  raw: unknown,
  caseNumber: number,
): ExpectedGateVerdict['provenance'] | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'human-labeled' || raw === 'judge-suggested') return raw;
  throw new Error(`case ${caseNumber} expected_gate_verdict.provenance must be "human-labeled" or "judge-suggested"`);
}

function normalizeGateVerdictVerification(
  raw: unknown,
  caseNumber: number,
): ExpectedGateVerdict['verification'] | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'verified' || raw === 'unverified') return raw;
  throw new Error(`case ${caseNumber} expected_gate_verdict.verification must be "verified" or "unverified"`);
}

async function retrieveDense(
  fixtureCase: RetrievalEvalCase,
  context: RetrievalEvalSearchContext,
): Promise<ScoredDocument[]> {
  const retrievalViews = retrievalViewsForCase(fixtureCase);
  return context.manager.similaritySearch(
    fixtureCase.query,
    fixtureCase.k ?? context.defaultK,
    fixtureCase.threshold ?? context.defaultThreshold,
    fixtureCase.kb,
    undefined,
    undefined,
    { retrievalViews },
  );
}

async function retrieveLexical(
  query: string,
  k: number,
  scopedKb?: string,
  retrievalViews?: RetrievalViewKind[],
): Promise<ScoredDocument[]> {
  const kbs = await listLexicalKbs(scopedKb);
  // The eval runner is strict about scope: a missing scoped KB is a fixture
  // bug worth surfacing, not silent dense-only fallback. The shared
  // `listLexicalKbs` returns `[]` for an unknown name (matching CLI/MCP), so
  // we replicate the prior eval-specific check here.
  if (scopedKb !== undefined && kbs.length === 0) {
    throw new Error(`KB not found: ${scopedKb}`);
  }
  const merged: LexicalSearchResult[] = [];
  for (const { kbName, kbPath } of kbs) {
    const index = await LexicalIndex.load(kbName, kbPath);
    if (index.numFiles() === 0) {
      await withWriteLock(
        path.dirname(lexicalIndexFilePath(kbName)),
        () => withRetrievalViewsForEvalIngest(retrievalViews, async () => {
          await index.refresh();
          await index.save();
        }),
      );
    }
    merged.push(...await index.query(query, k, { retrievalViews }));
  }
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, k).map(toScoredDocument);
}

async function retrieveHybrid(
  fixtureCase: RetrievalEvalCase,
  context: RetrievalEvalSearchContext,
): Promise<ScoredDocument[]> {
  const k = fixtureCase.k ?? context.defaultK;
  const fetchK = hybridFetchK(k);
  const retrieveLexicalFn = context.retrieveLexical ?? retrieveLexical;
  const retrievalViews = retrievalViewsForCase(fixtureCase);
  const [denseResults, lexicalResults] = await Promise.all([
    context.manager.similaritySearch(
      fixtureCase.query,
      fetchK,
      Number.POSITIVE_INFINITY,
      fixtureCase.kb,
      undefined,
      undefined,
      { retrievalViews },
    ),
    retrieveLexicalFn(fixtureCase.query, fetchK, fixtureCase.kb, retrievalViews),
  ]);
  // Pass the scoped KB so the RFC 020 §9 skip-rerank fallback (per-domain gate)
  // is honored here too, and the fused candidate depth matches the real config.
  const rerankConfig = resolveRerankerConfig(process.env, undefined, fixtureCase.kb);
  const fused = fuseHybridResults({
    denseResults,
    lexicalResults,
    k: rerankConfig.enabled ? Math.max(k, rerankConfig.topN) : k,
  });
  const reranked = await applyRerankerIfEnabled({
    query: fixtureCase.query,
    results: fused,
    k,
    config: rerankConfig,
    searchMode: 'hybrid',
    kbScope: fixtureCase.kb ?? null,
  });
  return reranked.results;
}

function retrievalViewsForCase(fixtureCase: RetrievalEvalCase): RetrievalViewKind[] | undefined {
  const raw = (fixtureCase as RetrievalEvalCase & { retrieval_views?: unknown }).retrievalViews
    ?? (fixtureCase as RetrievalEvalCase & { retrieval_views?: unknown }).retrieval_views;
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw.filter((value): value is RetrievalViewKind =>
    typeof value === 'string' && (RETRIEVAL_VIEW_KINDS as readonly string[]).includes(value),
  );
  if (typeof raw === 'string') {
    const parsed = parseRetrievalViews(raw);
    return parsed.length > 0 ? parsed : undefined;
  }
  return undefined;
}

async function withRetrievalViewsForEvalIngest<T>(
  views: readonly RetrievalViewKind[] | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (views === undefined || views.length === 0) return fn();
  const previous = process.env[KB_RETRIEVAL_VIEWS_ENV];
  process.env[KB_RETRIEVAL_VIEWS_ENV] = formatRetrievalViews(views);
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[KB_RETRIEVAL_VIEWS_ENV];
    } else {
      process.env[KB_RETRIEVAL_VIEWS_ENV] = previous;
    }
  }
}

function toScoredDocument(result: LexicalSearchResult): ScoredDocument {
  return {
    pageContent: result.pageContent,
    metadata: result.metadata,
    score: result.score,
  };
}

function normalizeExpectedMetadata(raw: unknown, caseNumber: number): ExpectedMetadataRule[] {
  if (raw === undefined) return [];
  if (isRecord(raw)) {
    return Object.entries(raw).map(([path, equals]) => ({ path, equals }));
  }
  if (Array.isArray(raw)) {
    const rules: ExpectedMetadataRule[] = [];
    raw.forEach((entry, idx) => {
      if (!isRecord(entry)) {
        throw new Error(`case ${caseNumber} expected_metadata[${idx}] must be an object`);
      }
      for (const [path, equals] of Object.entries(entry)) {
        rules.push({ path, equals });
      }
    });
    return rules;
  }
  throw new Error(`case ${caseNumber} expected_metadata must be an object or array of objects`);
}

function normalizeRelevanceJudgments(
  raw: Record<string, unknown>,
  caseNumber: number,
): RelevanceJudgment[] {
  const entries: RelevanceJudgment[] = [];
  const relevantSources = raw.relevant_sources;
  const judgments = raw.judgments;

  if (relevantSources !== undefined) {
    entries.push(...normalizeJudgmentArray(relevantSources, caseNumber, 'relevant_sources'));
  }
  if (judgments !== undefined) {
    if (isRecord(judgments)) {
      for (const [source, rawJudgment] of Object.entries(judgments)) {
        entries.push(normalizeJudgmentObjectEntry(source, rawJudgment, caseNumber));
      }
    } else {
      entries.push(...normalizeJudgmentArray(judgments, caseNumber, 'judgments'));
    }
  }

  const deduped = new Map<string, RelevanceJudgment>();
  for (const entry of entries) {
    const existing = deduped.get(entry.source);
    if (existing === undefined || entry.relevance > existing.relevance) {
      deduped.set(entry.source, mergeJudgments(existing, entry));
    } else if (existing !== undefined) {
      deduped.set(entry.source, mergeJudgments(existing, entry));
    }
  }
  return Array.from(deduped.values());
}

function normalizeJudgmentObjectEntry(
  source: string,
  rawJudgment: unknown,
  caseNumber: number,
): RelevanceJudgment {
  const baseSource = validateJudgmentSource(source, caseNumber, 'judgments');
  if (!isRecord(rawJudgment)) {
    return {
      source: baseSource,
      relevance: validateJudgmentRelevance(rawJudgment, caseNumber, `judgments.${source}`),
    };
  }
  const groups = normalizeJudgmentGroups(rawJudgment, caseNumber, `judgments.${source}`);
  return {
    source: baseSource,
    relevance: validateJudgmentRelevance(
      rawJudgment.relevance ?? 1,
      caseNumber,
      `judgments.${source}.relevance`,
    ),
    ...(groups.length > 0 ? { groups } : {}),
  };
}

function normalizeJudgmentArray(
  raw: unknown,
  caseNumber: number,
  key: string,
): RelevanceJudgment[] {
  if (!Array.isArray(raw)) {
    throw new Error(`case ${caseNumber} ${key} must be an array or object`);
  }
  return raw.map((entry, idx) => {
    if (typeof entry === 'string') {
      return {
        source: validateJudgmentSource(entry, caseNumber, `${key}[${idx}]`),
        relevance: 1,
      };
    }
    if (!isRecord(entry)) {
      throw new Error(`case ${caseNumber} ${key}[${idx}] must be a source string or object`);
    }
    return {
      source: validateJudgmentSource(entry.source, caseNumber, `${key}[${idx}].source`),
      relevance: validateJudgmentRelevance(
        entry.relevance ?? 1,
        caseNumber,
        `${key}[${idx}].relevance`,
      ),
      ...(() => {
        const groups = normalizeJudgmentGroups(entry, caseNumber, `${key}[${idx}]`);
        return groups.length > 0 ? { groups } : {};
      })(),
    };
  });
}

function mergeJudgments(
  existing: RelevanceJudgment | undefined,
  incoming: RelevanceJudgment,
): RelevanceJudgment {
  if (existing === undefined) return incoming;
  const relevance = Math.max(existing.relevance, incoming.relevance);
  const groups = Array.from(new Set([...(existing.groups ?? []), ...(incoming.groups ?? [])]));
  return {
    source: incoming.source,
    relevance,
    ...(groups.length > 0 ? { groups } : {}),
  };
}

function validateJudgmentSource(value: unknown, caseNumber: number, key: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`case ${caseNumber} ${key} must be a non-empty source string`);
  }
  return value;
}

function validateJudgmentRelevance(value: unknown, caseNumber: number, key: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`case ${caseNumber} ${key} must be a non-negative finite relevance number`);
  }
  return value;
}

function normalizeJudgmentGroups(
  input: Record<string, unknown>,
  caseNumber: number,
  key: string,
): string[] {
  const raw = input.groups ?? input.group ?? input.intents ?? input.intent;
  if (raw === undefined) return [];
  const values = typeof raw === 'string' ? [raw] : raw;
  if (
    !Array.isArray(values) ||
    values.some((entry) => typeof entry !== 'string' || entry.trim() === '')
  ) {
    throw new Error(`case ${caseNumber} ${key} groups/intents must be a non-empty string or string array`);
  }
  return Array.from(new Set(values));
}

function computeRankedMetrics(
  fixtureCase: RetrievalEvalCase,
  results: readonly ScoredDocument[],
): RetrievalEvalRankedMetrics | undefined {
  const positiveJudgments = (fixtureCase.relevanceJudgments ?? []).filter((j) => j.relevance > 0);
  if (positiveJudgments.length === 0) return undefined;

  const k = fixtureCase.k ?? 10;
  const topK = results.slice(0, k);
  const retrievedAtK = matchedJudgmentIndexes(topK, positiveJudgments);

  return {
    k,
    judgedRelevantCount: positiveJudgments.length,
    retrievedRelevantCount: retrievedAtK.size,
    ndcgAt10: ndcgAt(results, positiveJudgments, 10),
    mrrAt10: reciprocalRankAt(results, positiveJudgments, 10),
    recallAtK: retrievedAtK.size / positiveJudgments.length,
    precisionAtK: retrievedAtK.size / k,
    map: averagePrecisionAt(results, positiveJudgments, results.length, positiveJudgments.length),
    mapAtK: averagePrecisionAt(topK, positiveJudgments, k, Math.min(positiveJudgments.length, k)),
    hitRate: retrievedAtK.size > 0 ? 1 : 0,
  };
}

function computeDiversityMetrics(
  fixtureCase: RetrievalEvalCase,
  results: readonly ScoredDocument[],
): RetrievalEvalDiversityMetrics {
  const k = fixtureCase.k ?? 10;
  return {
    source: computeSourceDiversityMetrics(results, k),
    ...(() => {
      const intent = computeIntentDiversityMetrics(fixtureCase, results, k);
      return intent === undefined ? {} : { intent };
    })(),
  };
}

function computeSourceDiversityMetrics(
  results: readonly ScoredDocument[],
  k: number,
): RetrievalEvalSourceDiversityMetrics {
  const topK = results.slice(0, k);
  const counts = countSources(topK);
  const maxCount = Math.max(0, ...Array.from(counts.values()));
  return {
    k,
    resultCount: topK.length,
    uniqueSourceCountAtK: counts.size,
    duplicateSourceGroupsAtK: Array.from(counts.values()).filter((count) => count > 1).length,
    maxSourceShareAtK: topK.length === 0 ? 0 : maxCount / topK.length,
  };
}

function computeIntentDiversityMetrics(
  fixtureCase: RetrievalEvalCase,
  results: readonly ScoredDocument[],
  k: number,
): RetrievalEvalIntentDiversityMetrics | undefined {
  const judgments = (fixtureCase.relevanceJudgments ?? [])
    .filter((judgment) => judgment.relevance > 0 && (judgment.groups?.length ?? 0) > 0);
  if (judgments.length === 0) return undefined;

  const allGroups = new Set(judgments.flatMap((judgment) => judgment.groups ?? []));
  const topK = results.slice(0, k);
  const retrievedGroups = new Set<string>();
  for (const doc of topK) {
    for (const group of groupsForDocument(doc, judgments)) retrievedGroups.add(group);
  }

  return {
    k,
    groupCount: allGroups.size,
    retrievedGroupCountAtK: retrievedGroups.size,
    intentRecallAtK: allGroups.size === 0 ? 0 : retrievedGroups.size / allGroups.size,
    alphaNdcgAtK: alphaNdcgAt(topK, judgments, k),
  };
}

function summarizeDiversityMetrics(
  results: readonly RetrievalEvalCaseResult[],
): RetrievalEvalAggregateDiversityMetrics {
  const sourceMetrics = results.map((result) => result.diversityMetrics.source);
  const intentMetrics = results
    .map((result) => result.diversityMetrics.intent)
    .filter((metrics): metrics is RetrievalEvalIntentDiversityMetrics => metrics !== undefined);
  return {
    source: {
      caseCount: sourceMetrics.length,
      uniqueSourceCountAtK: meanOrZero(sourceMetrics.map((m) => m.uniqueSourceCountAtK)),
      duplicateSourceGroupsAtK: meanOrZero(sourceMetrics.map((m) => m.duplicateSourceGroupsAtK)),
      maxSourceShareAtK: meanOrZero(sourceMetrics.map((m) => m.maxSourceShareAtK)),
    },
    ...(intentMetrics.length > 0 ? {
      intent: {
        caseCount: intentMetrics.length,
        intentRecallAtK: mean(intentMetrics.map((m) => m.intentRecallAtK)),
        alphaNdcgAtK: mean(intentMetrics.map((m) => m.alphaNdcgAtK)),
      },
    } : {}),
  };
}

function summarizeRankedMetrics(
  results: readonly RetrievalEvalCaseResult[],
): RetrievalEvalAggregateRankedMetrics | undefined {
  const judged = results
    .map((result) => result.rankedMetrics)
    .filter((metrics): metrics is RetrievalEvalRankedMetrics => metrics !== undefined);
  if (judged.length === 0) return undefined;
  return {
    judgedCaseCount: judged.length,
    ndcgAt10: mean(judged.map((m) => m.ndcgAt10)),
    mrrAt10: mean(judged.map((m) => m.mrrAt10)),
    recallAtK: mean(judged.map((m) => m.recallAtK)),
    precisionAtK: mean(judged.map((m) => m.precisionAtK)),
    map: mean(judged.map((m) => m.map)),
    mapAtK: mean(judged.map((m) => m.mapAtK)),
    hitRate: mean(judged.map((m) => m.hitRate)),
  };
}

function matchedJudgmentIndexes(
  results: readonly ScoredDocument[],
  judgments: readonly RelevanceJudgment[],
): Set<number> {
  const matched = new Set<number>();
  for (const doc of results) {
    const index = bestMatchingJudgmentIndex(doc, judgments);
    if (index !== undefined) matched.add(index);
  }
  return matched;
}

function groupsForDocument(
  doc: ScoredDocument,
  judgments: readonly RelevanceJudgment[],
): string[] {
  const groups = new Set<string>();
  for (const judgment of judgments) {
    if (!documentMatchesSource(doc, judgment.source)) continue;
    for (const group of judgment.groups ?? []) groups.add(group);
  }
  return Array.from(groups);
}

function alphaNdcgAt(
  results: readonly ScoredDocument[],
  judgments: readonly RelevanceJudgment[],
  cutoff: number,
  alpha = 0.5,
): number {
  const dcg = alphaDcg(results.map((doc) => groupsForDocument(doc, judgments)), cutoff, alpha);
  const ideal = idealAlphaDcg(judgments, cutoff, alpha);
  return ideal === 0 ? 0 : dcg / ideal;
}

function alphaDcg(
  groupSets: readonly string[][],
  cutoff: number,
  alpha: number,
): number {
  const seenByGroup = new Map<string, number>();
  let dcg = 0;
  for (let idx = 0; idx < Math.min(groupSets.length, cutoff); idx += 1) {
    let gain = 0;
    for (const group of groupSets[idx]) {
      const seen = seenByGroup.get(group) ?? 0;
      gain += (1 - alpha) ** seen;
    }
    for (const group of groupSets[idx]) {
      seenByGroup.set(group, (seenByGroup.get(group) ?? 0) + 1);
    }
    dcg += gain / Math.log2(idx + 2);
  }
  return dcg;
}

function idealAlphaDcg(
  judgments: readonly RelevanceJudgment[],
  cutoff: number,
  alpha: number,
): number {
  const remaining = judgments
    .map((judgment) => Array.from(new Set(judgment.groups ?? [])))
    .filter((groups) => groups.length > 0);
  const chosen: string[][] = [];
  const seenByGroup = new Map<string, number>();
  while (chosen.length < cutoff && remaining.length > 0) {
    let bestIdx = 0;
    let bestGain = Number.NEGATIVE_INFINITY;
    remaining.forEach((groups, idx) => {
      const gain = groups.reduce((sum, group) => {
        const seen = seenByGroup.get(group) ?? 0;
        return sum + ((1 - alpha) ** seen);
      }, 0);
      if (gain > bestGain) {
        bestGain = gain;
        bestIdx = idx;
      }
    });
    const [next] = remaining.splice(bestIdx, 1);
    chosen.push(next);
    for (const group of next) {
      seenByGroup.set(group, (seenByGroup.get(group) ?? 0) + 1);
    }
  }
  return alphaDcg(chosen, cutoff, alpha);
}

function reciprocalRankAt(
  results: readonly ScoredDocument[],
  judgments: readonly RelevanceJudgment[],
  cutoff: number,
): number {
  const seen = new Set<number>();
  for (let idx = 0; idx < Math.min(results.length, cutoff); idx += 1) {
    const match = bestMatchingJudgmentIndex(results[idx], judgments, seen);
    if (match !== undefined) return 1 / (idx + 1);
  }
  return 0;
}

function averagePrecisionAt(
  results: readonly ScoredDocument[],
  judgments: readonly RelevanceJudgment[],
  cutoff: number,
  denominator: number,
): number {
  if (denominator === 0) return 0;
  const seen = new Set<number>();
  let retrievedRelevant = 0;
  let precisionSum = 0;
  for (let idx = 0; idx < Math.min(results.length, cutoff); idx += 1) {
    const match = bestMatchingJudgmentIndex(results[idx], judgments, seen);
    if (match === undefined) continue;
    seen.add(match);
    retrievedRelevant += 1;
    precisionSum += retrievedRelevant / (idx + 1);
  }
  return precisionSum / denominator;
}

function ndcgAt(
  results: readonly ScoredDocument[],
  judgments: readonly RelevanceJudgment[],
  cutoff: number,
): number {
  const seen = new Set<number>();
  let dcg = 0;
  for (let idx = 0; idx < Math.min(results.length, cutoff); idx += 1) {
    const match = bestMatchingJudgmentIndex(results[idx], judgments, seen);
    if (match === undefined) continue;
    seen.add(match);
    dcg += gradedGain(judgments[match].relevance) / Math.log2(idx + 2);
  }

  const ideal = judgments
    .map((judgment) => judgment.relevance)
    .sort((a, b) => b - a)
    .slice(0, cutoff)
    .reduce((sum, relevance, idx) => sum + (gradedGain(relevance) / Math.log2(idx + 2)), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

function bestMatchingJudgmentIndex(
  doc: ScoredDocument,
  judgments: readonly RelevanceJudgment[],
  exclude: ReadonlySet<number> = new Set(),
): number | undefined {
  let bestIndex: number | undefined;
  let bestRelevance = Number.NEGATIVE_INFINITY;
  judgments.forEach((judgment, idx) => {
    if (exclude.has(idx) || !documentMatchesSource(doc, judgment.source)) return;
    if (judgment.relevance > bestRelevance) {
      bestIndex = idx;
      bestRelevance = judgment.relevance;
    }
  });
  return bestIndex;
}

function gradedGain(relevance: number): number {
  return (2 ** relevance) - 1;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanOrZero(values: readonly number[]): number {
  return values.length === 0 ? 0 : mean(values);
}

function formatRankedMetrics(metrics: RetrievalEvalRankedMetrics): string {
  return [
    `nDCG@10=${formatMetric(metrics.ndcgAt10)}`,
    `MRR@10=${formatMetric(metrics.mrrAt10)}`,
    `Recall@${metrics.k}=${formatMetric(metrics.recallAtK)}`,
    `Precision@${metrics.k}=${formatMetric(metrics.precisionAtK)}`,
    `MAP=${formatMetric(metrics.map)}`,
    `MAP@${metrics.k}=${formatMetric(metrics.mapAtK)}`,
    `HitRate@${metrics.k}=${formatMetric(metrics.hitRate)}`,
  ].join(', ');
}

function formatDiversityMetrics(metrics: RetrievalEvalDiversityMetrics): string {
  return [
    `unique-source@${metrics.source.k}=${metrics.source.uniqueSourceCountAtK}`,
    `max-source-share@${metrics.source.k}=${formatMetric(metrics.source.maxSourceShareAtK)}`,
    `duplicate-groups@${metrics.source.k}=${metrics.source.duplicateSourceGroupsAtK}`,
    ...(metrics.intent === undefined ? [] : [
      `intent-recall@${metrics.intent.k}=${formatMetric(metrics.intent.intentRecallAtK)}`,
      `alpha-nDCG@${metrics.intent.k}=${formatMetric(metrics.intent.alphaNdcgAtK)}`,
    ]),
  ].join(', ');
}

function formatAggregateRankedMetrics(metrics: RetrievalEvalAggregateRankedMetrics): string {
  return [
    `nDCG@10=${formatMetric(metrics.ndcgAt10)}`,
    `MRR@10=${formatMetric(metrics.mrrAt10)}`,
    `Recall@k=${formatMetric(metrics.recallAtK)}`,
    `Precision@k=${formatMetric(metrics.precisionAtK)}`,
    `MAP=${formatMetric(metrics.map)}`,
    `MAP@k=${formatMetric(metrics.mapAtK)}`,
    `HitRate=${formatMetric(metrics.hitRate)}`,
    `judged cases=${metrics.judgedCaseCount}`,
  ].join(', ');
}

function formatAggregateDiversityMetrics(metrics: RetrievalEvalAggregateDiversityMetrics): string {
  return [
    `unique-source@k=${formatMetric(metrics.source.uniqueSourceCountAtK)}`,
    `max-source-share@k=${formatMetric(metrics.source.maxSourceShareAtK)}`,
    `duplicate-groups@k=${formatMetric(metrics.source.duplicateSourceGroupsAtK)}`,
    `cases=${metrics.source.caseCount}`,
    ...(metrics.intent === undefined ? [] : [
      `intent-recall@k=${formatMetric(metrics.intent.intentRecallAtK)}`,
      `alpha-nDCG@k=${formatMetric(metrics.intent.alphaNdcgAtK)}`,
      `intent cases=${metrics.intent.caseCount}`,
    ]),
  ].join(', ');
}

function formatMetric(value: number): string {
  return value.toFixed(3);
}

function readOptionalSearchMode(
  input: Record<string, unknown>,
  key: string,
  context: string,
): { mode?: SearchMode } {
  const value = input[key];
  if (value === undefined) return {};
  if (value === 'dense' || value === 'lexical' || value === 'hybrid' || value === 'auto') {
    return { mode: value };
  }
  throw new Error(`${context} ${key} must be "dense", "lexical", "hybrid", or "auto"`);
}

function normalizeStalePolicy(raw: unknown, caseNumber: number): StalePolicy {
  if (raw === undefined) return 'allow_stale';
  const candidate = isRecord(raw) ? raw.expect : raw;
  if (candidate === 'allow_stale' || candidate === 'fresh' || candidate === 'stale') {
    return candidate;
  }
  throw new Error(
    `case ${caseNumber} stale_policy must be "allow_stale", "fresh", or "stale"`,
  );
}

function documentMatchesSource(doc: ScoredDocument, pattern: string): boolean {
  return sourceIdentities(doc).some((source) => sourceMatches(source, pattern));
}

function sourceIdentities(doc: ScoredDocument): string[] {
  const metadata = doc.metadata as Record<string, unknown>;
  const candidates = [metadata.source, metadata.relativePath];
  return candidates.filter((candidate): candidate is string =>
    typeof candidate === 'string' && candidate.trim() !== '');
}

function sourceMatches(source: string, pattern: string): boolean {
  if (source === pattern) return true;
  if (source.endsWith(`/${pattern}`)) return true;
  return minimatch(source, pattern, { dot: true });
}

function countDuplicateSourceGroups(results: readonly ScoredDocument[]): number {
  return Array.from(countSources(results).values()).filter((count) => count > 1).length;
}

function countSources(results: readonly ScoredDocument[]): Map<string, number> {
  const counts = new Map<string, number>();
  results.forEach((doc, idx) => {
    const key = sourceIdentities(doc)[0] ?? `(unknown source ${idx + 1})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return counts;
}

function selectRequiredSources(
  results: readonly ScoredDocument[],
  maxRequiredSources: number,
): string[] {
  if (maxRequiredSources <= 0) return [];
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const doc of results) {
    const source = portableSourceIdentity(doc);
    if (source === undefined || seen.has(source)) continue;
    selected.push(source);
    seen.add(source);
    if (selected.length >= maxRequiredSources) break;
  }
  return selected;
}

function portableSourceIdentity(doc: ScoredDocument): string | undefined {
  const metadata = doc.metadata as Record<string, unknown>;
  const relativePath = metadata.relativePath;
  if (typeof relativePath === 'string' && relativePath.trim() !== '') {
    return relativePath;
  }
  return sourceIdentities(doc)[0];
}

function selectExpectedMetadata(
  results: readonly ScoredDocument[],
  requiredSources: ReadonlySet<string>,
): Record<string, unknown> {
  const expected: Record<string, unknown> = {};
  for (const doc of results) {
    const source = portableSourceIdentity(doc);
    if (source === undefined || !requiredSources.has(source)) continue;
    for (const dotPath of SCAFFOLD_METADATA_PATHS) {
      if (dotPath in expected) continue;
      const value = readPath(doc.metadata, dotPath);
      if (isMetadataScaffoldValue(value)) expected[dotPath] = value;
    }
  }
  return expected;
}

function isMetadataScaffoldValue(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function scaffoldStalePolicy(staleness: Staleness | undefined): StalePolicy {
  if (staleness === undefined) return 'allow_stale';
  return isStale(staleness) ? 'allow_stale' : 'fresh';
}

function scaffoldCaseName(query: string): string {
  const compact = query.trim().replace(/\s+/g, ' ');
  return `scaffold - ${compact.slice(0, 60)}`;
}

function metadataMatchesRule(metadata: unknown, rule: ExpectedMetadataRule): boolean {
  return deepEqual(readPath(metadata, rule.path), rule.equals);
}

function readPath(input: unknown, dotPath: string): unknown {
  let current = input;
  for (const segment of dotPath.split('.')) {
    if (!isRecord(current) || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isStale(s: Staleness): boolean {
  return s.modifiedFiles + s.newFiles > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequiredString(
  input: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${context} requires non-empty ${key}`);
  }
  return value;
}

function readOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
  return value;
}

function readOptionalStringArray(
  input: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  return value;
}

function readOptionalPositiveInteger(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function readOptionalNonNegativeInteger(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

function readOptionalPositiveNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }
  return value;
}
