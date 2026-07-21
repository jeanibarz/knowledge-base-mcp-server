import { createHash } from 'crypto';
import type { Document } from '@langchain/core/documents';
import { emitCanonicalLog, type CanonicalProcess, type CanonicalSearchMode } from './canonical-log.js';
import { resolveRelevanceGateConfig, type RelevanceGateConfig } from './config/relevance-gate.js';
import { applyInjectionGuard } from './injection-guard.js';
import { chunkIdFromMetadata } from './rrf.js';
import { computeAutoThreshold } from './search-core.js';
import {
  judgeRelevance,
  type RelevanceJudgeCandidate,
  type RelevanceJudgeResult,
} from './relevance-judge.js';
import {
  RELEVANCE_GATE_SCHEMA_VERSION,
  type RelevanceGateVerdict,
} from './relevance-gate-schema.js';
import { relevanceGateMetrics } from './relevance-gate-metrics.js';
import { llmCallMetrics, type LlmCallMetrics } from './metrics.js';
import {
  excludesLlmContext,
  normalizeKbSensitivityPolicy,
  readLlmContextPolicy,
} from './sensitivity-policy.js';

export type RelevanceGateOverride = 'on' | 'off' | undefined;

export interface RelevanceGateCandidate extends Document {
  score?: number;
}

export interface RelevanceGateInput<T extends RelevanceGateCandidate = RelevanceGateCandidate> {
  query: string;
  taskContext?: string;
  candidates: T[];
  denseDistanceById?: ReadonlyMap<string, number>;
  lexicalHitIds?: ReadonlySet<string>;
  gateOverride?: RelevanceGateOverride;
  config?: RelevanceGateConfig;
  fetchImpl?: typeof fetch;
  process?: CanonicalProcess;
  /** Optional workflow-metrics override; production uses the process singleton. */
  llmMetrics?: LlmCallMetrics;
}

export interface RelevanceGateResult<T extends RelevanceGateCandidate = RelevanceGateCandidate> {
  results: T[];
  verdict: RelevanceGateVerdict;
  observability: RelevanceGateObservability;
}

export interface RelevanceGateCanonicalInput {
  process: CanonicalProcess;
  query: string;
  taskContext?: string;
  kbScope?: string | null;
  searchMode: CanonicalSearchMode;
  verdict: RelevanceGateVerdict;
  observability?: RelevanceGateObservability;
}

export interface RelevanceGateObservability {
  task_context_sha: string | null;
  query_sha: string;
  floor: number;
  judge_model: string | null;
  judge_prompt_hash: string | null;
  shuffled_order: string[];
  degraded: boolean;
  degrade_reason: string | null;
  judge_skipped: string | null;
  candidates: RelevanceGateCandidateReproduction[];
}

export interface RelevanceGateCandidateReproduction {
  id: string;
  content_sha: string;
  decision: 'kept' | 'dropped';
  stage: string | null;
  reason: string | null;
}

interface CandidateRow<T extends RelevanceGateCandidate> {
  id: string;
  result: T;
  originalIndex: number;
}

interface DropRecord {
  id: string;
  stage: string;
  reason: string;
}

interface CandidatePartition<T extends RelevanceGateCandidate> {
  rows: CandidateRow<T>[];
  policyExcludedRows: CandidateRow<T>[];
  gateRows: CandidateRow<T>[];
  lexicalHitIds: Set<string>;
}

interface CachedGateDecision {
  verdict: RelevanceGateVerdict;
  resultIds: Set<string>;
  observability: RelevanceGateObservability;
}

/** Default process-LRU cap for gate verdicts under long-lived `kb serve` (#899). */
export const DEFAULT_GATE_VERDICT_CACHE_MAX = 256;

/**
 * Maximum retained verdict-cache entries. Reads `KB_GATE_VERDICT_CACHE_MAX`;
 * non-finite / negative values fall back to the default; `0` disables caching.
 */
export function resolveGateVerdictCacheMax(
  raw: string | undefined = process.env.KB_GATE_VERDICT_CACHE_MAX,
): number {
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_GATE_VERDICT_CACHE_MAX;
  return Math.floor(parsed);
}

/**
 * Bounded LRU over insertion order. Map keeps insertion order; get/set re-touch
 * so recently used entries survive eviction under `kb serve`.
 */
class VerdictCacheLru {
  private readonly values = new Map<string, CachedGateDecision>();
  private maxEntries: number;

  constructor(maxEntries: number = resolveGateVerdictCacheMax()) {
    this.maxEntries = maxEntries;
  }

  get size(): number {
    return this.values.size;
  }

  get(key: string): CachedGateDecision | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: CachedGateDecision): void {
    if (this.maxEntries <= 0) return;
    if (this.values.has(key)) this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  clear(): void {
    this.values.clear();
  }

  setMaxEntries(maxEntries: number): void {
    this.maxEntries = maxEntries;
    if (this.maxEntries <= 0) {
      this.values.clear();
      return;
    }
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }
}

const verdictCache = new VerdictCacheLru();

/** Clears the process-global verdict cache (and optionally retunes the cap) for tests. */
export function __resetRelevanceGateVerdictCacheForTests(options?: {
  maxEntries?: number;
}): void {
  if (options?.maxEntries !== undefined) {
    verdictCache.setMaxEntries(options.maxEntries);
  } else {
    verdictCache.setMaxEntries(resolveGateVerdictCacheMax());
  }
  verdictCache.clear();
}

/** Process-global verdict-cache size; for tests only. */
export function __getRelevanceGateVerdictCacheSizeForTests(): number {
  return verdictCache.size;
}

export async function applyRelevanceGate<T extends RelevanceGateCandidate>(
  input: RelevanceGateInput<T>,
): Promise<RelevanceGateResult<T>> {
  const llmMetrics = input.llmMetrics ?? llmCallMetrics;
  const config = input.config ?? resolveRelevanceGateConfig();
  const enabled = input.gateOverride === 'on' || (config.enabled && input.gateOverride !== 'off');
  if (!enabled) {
    llmMetrics.recordCacheOutcome('gate', 'not_applicable');
    const verdict = buildVerdict({
      state: 'bypassed',
      inputCount: input.candidates.length,
      outputCount: input.candidates.length,
      emptyVerdictEnabled: config.emptyVerdictEnabled,
      judge: { status: 'not-run', reason: 'gate disabled' },
    });
    return {
      results: input.candidates,
      verdict,
      observability: buildObservability({
        query: input.query,
        taskContext: input.taskContext,
        config,
        rows: rowsForObservability(input.candidates),
        survivors: rowsForObservability(input.candidates),
        dropped: [],
        judge: verdict.judge,
      }),
    };
  }

  if (input.candidates.length === 0) {
    llmMetrics.recordCacheOutcome('gate', 'not_applicable');
    const verdict = buildVerdict({
      state: 'empty-index',
      inputCount: 0,
      outputCount: 0,
      emptyVerdictEnabled: config.emptyVerdictEnabled,
      judge: { status: 'not-run', reason: 'no candidates' },
    });
    relevanceGateMetrics.record(verdict, input.process);
    return {
      results: [],
      verdict,
      observability: buildObservability({
        query: input.query,
        taskContext: input.taskContext,
        config,
        rows: [],
        survivors: [],
        dropped: [],
        judge: verdict.judge,
      }),
    };
  }

  const hydratedCandidates = await hydrateSensitivityPoliciesFromSource(input.candidates);
  // A second read is deliberately immediately before cache-key construction
  // and lookup. A source may change while retrieval metadata is prepared; a
  // stale public verdict must never be replayed for newly protected content.
  const boundaryHydratedCandidates = await hydrateSensitivityPoliciesFromSource(hydratedCandidates);
  const effectiveInput: RelevanceGateInput<T> = {
    ...input,
    candidates: boundaryHydratedCandidates,
  };
  let {
    rows,
    policyExcludedRows,
    gateRows,
    lexicalHitIds,
  } = partitionCandidates(effectiveInput);

  let cacheKey = buildCacheKey(effectiveInput, config, lexicalHitIds);
  const cached = verdictCache.get(cacheKey);
  if (cached !== undefined) {
    llmMetrics.recordCacheOutcome('gate', 'hit');
    llmMetrics.recordAnswerImpact('gate', 'used');
    relevanceGateMetrics.record(cached.verdict, input.process);
    return {
      results: replayVerdict(effectiveInput.candidates, cached),
      verdict: cached.verdict,
      observability: cached.observability,
    };
  }

  // A missing verdict is a workflow cache miss even when the gate later
  // completes without invoking its optional LLM judge.
  llmMetrics.recordCacheOutcome('gate', 'miss');

  const dropped: DropRecord[] = [];
  let afterA1: CandidateRow<T>[] = [];
  const taskContext = normalizeTaskContext(input.taskContext);
  let survivors: CandidateRow<T>[];
  let judge: RelevanceGateVerdict['judge'];
  let judgePromptHash: string | null = null;
  let shuffledOrder: string[] = [];
  let lowConfidence = false;
  let state: RelevanceGateVerdict['state'] = 'injected';

  if (gateRows.length === 0) {
    survivors = [];
    judge = { status: 'skipped', reason: 'all candidates excluded by no_llm_context policy' };
  } else if (!hasTaskSignal(taskContext, config.minTaskContextTokens)) {
    afterA1 = applyA1(
      gateRows,
      effectiveInput.denseDistanceById,
      config.scoreFloor,
      dropped,
      lexicalHitIds,
    );
    survivors = applyA2(afterA1, dropped, effectiveInput.denseDistanceById);
    judge = { status: 'skipped', reason: 'task_context absent or too short' };
  } else if (config.judgeEndpoint === undefined) {
    afterA1 = applyA1(
      gateRows,
      effectiveInput.denseDistanceById,
      config.scoreFloor,
      dropped,
      lexicalHitIds,
    );
    survivors = applyA2(afterA1, dropped, effectiveInput.denseDistanceById);
    judge = { status: 'failed', reason: 'KB_GATE_LLM_ENDPOINT unset; degraded to A2' };
  } else {
    // Re-read immediately before the LLM path starts. The synchronous
    // partition and prompt-candidate construction that follow this await use
    // the latest observed policy, rather than the cache-preparation snapshot.
    effectiveInput.candidates = await hydrateSensitivityPoliciesFromSource(effectiveInput.candidates);
    ({ rows, policyExcludedRows, gateRows, lexicalHitIds } = partitionCandidates(effectiveInput));
    cacheKey = buildCacheKey(effectiveInput, config, lexicalHitIds);
    afterA1 = applyA1(
      gateRows,
      effectiveInput.denseDistanceById,
      config.scoreFloor,
      dropped,
      lexicalHitIds,
    );
    if (gateRows.length === 0) {
      survivors = [];
      judge = { status: 'skipped', reason: 'all candidates excluded by no_llm_context policy' };
    } else {
      const judged = await applyStageB({
        rows: afterA1,
        dropped,
        query: input.query,
        taskContext: guardTaskContext(taskContext),
        lexicalHitIds,
        config,
        seed: cacheKey,
        fetchImpl: input.fetchImpl,
        llmMetrics,
      });
      survivors = judged.survivors;
      judge = judged.judge;
      state = judged.state;
      if (judged.lowConfidence) lowConfidence = true;
      judgePromptHash = judged.judgePromptHash;
      shuffledOrder = judged.shuffledOrder;
      if (judged.degraded) {
        survivors = applyA2(afterA1, dropped, effectiveInput.denseDistanceById);
      }
    }
  }

  if (state !== 'no-relevant-context' && survivors.length === 0 && gateRows.length > 0) {
    const rescued = gateRows[0];
    survivors = [rescued];
    lowConfidence = true;
  }

  const outputRows = [...survivors, ...policyExcludedRows]
    .sort((a, b) => a.originalIndex - b.originalIndex);
  const results = outputRows.map((row) => row.result);
  const verdict = buildVerdict({
    state,
    lowConfidence,
    inputCount: effectiveInput.candidates.length,
    outputCount: results.length,
    dropped,
    judge,
    emptyVerdictEnabled: config.emptyVerdictEnabled,
  });
  const observability = buildObservability({
    query: input.query,
    taskContext: input.taskContext,
    config,
    rows,
    survivors: outputRows,
    dropped,
    judge,
    judgePromptHash,
    shuffledOrder,
  });
  relevanceGateMetrics.record(verdict, input.process);
  verdictCache.set(cacheKey, {
    verdict,
    resultIds: new Set(outputRows.map((row) => row.id)),
    observability,
  });
  return { results, verdict, observability };
}

export function emitRelevanceGateDecision(input: RelevanceGateCanonicalInput): void {
  if (input.verdict.state === 'bypassed') return;
  emitCanonicalLog({
    process: input.process,
    tool: input.process === 'mcp' ? 'relevance-gate.decision' : undefined,
    cmd: input.process === 'cli' ? 'relevance-gate.decision' : undefined,
    query: input.query,
    kb_scope: input.kbScope ?? null,
    search_mode: input.searchMode,
    result_count: input.verdict.output_count,
    took_ms: 0,
    gate: {
      state: input.verdict.state,
      input_count: input.verdict.input_count,
      output_count: input.verdict.output_count,
      low_confidence: input.verdict.low_confidence,
      task_context_sha: input.observability?.task_context_sha ?? hashNullable(input.taskContext),
      query_sha: input.observability?.query_sha ?? shortHash(input.query),
      candidates: input.observability?.candidates ?? [],
      judge_model: input.observability?.judge_model ?? input.verdict.judge.model ?? null,
      judge_prompt_hash: input.observability?.judge_prompt_hash ?? null,
      floor: input.observability?.floor ?? null,
      shuffled_order: input.observability?.shuffled_order ?? [],
      degraded: input.observability?.degraded ?? (input.verdict.judge.status === 'failed'),
      degrade_reason:
        input.observability?.degrade_reason ??
        (input.verdict.judge.status === 'failed' ? input.verdict.judge.reason ?? 'judge failed' : null),
      judge_skipped:
        input.observability?.judge_skipped ??
        (input.verdict.judge.status === 'skipped' ? input.verdict.judge.reason ?? 'skipped' : null),
    },
  });
}

export function formatGateVerdictFooter(verdict: RelevanceGateVerdict): string {
  if (verdict.state === 'bypassed') {
    return '> _Relevance gate: bypassed._';
  }
  const low = verdict.low_confidence ? '; low confidence' : '';
  const judge = verdict.judge.status === 'failed' ? '; judge degraded' : '';
  return `> _Relevance gate: ${verdict.state}; kept ${verdict.output_count}/${verdict.input_count}${low}${judge}._`;
}

export function formatGateDroppedList(verdict: RelevanceGateVerdict): string {
  const lines = ['> _Relevance gate dropped candidates:_'];
  if (verdict.dropped.length === 0) {
    lines.push('> - none');
    return lines.join('\n');
  }
  for (const drop of verdict.dropped) {
    lines.push(`> - ${drop.id} (${drop.stage}): ${drop.reason}`);
  }
  return lines.join('\n');
}

function applyA1<T extends RelevanceGateCandidate>(
  rows: CandidateRow<T>[],
  denseDistanceById: ReadonlyMap<string, number> | undefined,
  scoreFloor: number,
  dropped: DropRecord[],
  lexicalHitIds: ReadonlySet<string>,
): CandidateRow<T>[] {
  const survivors: CandidateRow<T>[] = [];
  const stageDrops: DropRecord[] = [];
  for (const row of rows) {
    if (isLexicalOnlyRow(row, denseDistanceById, lexicalHitIds)) {
      // A lexical-only hit has no L2 distance. Keep it as independent lexical
      // evidence instead of silently treating its fused rank as a distance.
      survivors.push(row);
      continue;
    }
    const distance = denseDistanceById?.get(row.id);
    if (distance === undefined) {
      survivors.push(row);
      continue;
    }
    if (!Number.isFinite(distance)) {
      throw new Error(`relevance gate A1: non-finite dense distance for ${row.id}`);
    }
    if (distance > scoreFloor) {
      stageDrops.push({
        id: row.id,
        stage: 'A1-score-floor',
        reason: `dense distance ${distance.toFixed(4)} > floor ${scoreFloor}`,
      });
    } else {
      survivors.push(row);
    }
  }
  if (rows.length > 0 && survivors.length === 0) {
    const rescue = rows[0];
    dropped.push(...stageDrops.filter((drop) => drop.id !== rescue.id));
    return [rescue];
  }
  dropped.push(...stageDrops);
  return survivors;
}

function applyA2<T extends RelevanceGateCandidate>(
  rows: CandidateRow<T>[],
  dropped: DropRecord[],
  denseDistanceById?: ReadonlyMap<string, number>,
): CandidateRow<T>[] {
  if (rows.length <= 1) return rows;

  const scoredRows = denseDistanceById === undefined
    ? rows
    : rows.filter((row) => denseDistanceById.has(row.id));

  // A2's knee detector is defined over L2 distances. In hybrid mode, rows
  // without a dense distance are lexical-only (or otherwise unscored) and
  // must not distort that distribution with their fused-array position.
  if (scoredRows.length <= 1) return rows;

  const scored = scoredRows.map((row) => ({
    row,
    score:
      denseDistanceById === undefined
        ? typeof row.result.score === 'number'
          ? row.result.score
          : row.originalIndex
        : denseDistanceById.get(row.id)!,
  }));
  scored.sort((a, b) => a.score - b.score);
  const decision = computeAutoThreshold(scored.map((entry) => entry.score));
  const keepIds = new Set(scored.slice(0, Math.max(1, decision.kept)).map((entry) => entry.row.id));
  for (const entry of scored) {
    if (!keepIds.has(entry.row.id)) {
      dropped.push({
        id: entry.row.id,
        stage: 'A2-distribution-knee',
        reason: 'after score-distribution knee',
      });
    }
  }
  if (denseDistanceById === undefined) {
    return rows.filter((row) => keepIds.has(row.id));
  }
  return rows.filter((row) => !denseDistanceById.has(row.id) || keepIds.has(row.id));
}

function isLexicalOnlyRow<T extends RelevanceGateCandidate>(
  row: CandidateRow<T>,
  denseDistanceById: ReadonlyMap<string, number> | undefined,
  lexicalHitIds: ReadonlySet<string>,
): boolean {
  return denseDistanceById !== undefined
    && lexicalHitIds.has(row.id)
    && !denseDistanceById.has(row.id);
}

async function applyStageB<T extends RelevanceGateCandidate>(input: {
  rows: CandidateRow<T>[];
  dropped: DropRecord[];
  query: string;
  taskContext: string;
  lexicalHitIds: ReadonlySet<string>;
  config: RelevanceGateConfig;
  seed: string;
  fetchImpl?: typeof fetch;
  llmMetrics: LlmCallMetrics;
}): Promise<{
  survivors: CandidateRow<T>[];
  judge: RelevanceGateVerdict['judge'];
  state: RelevanceGateVerdict['state'];
  lowConfidence: boolean;
  degraded: boolean;
  judgePromptHash: string | null;
  shuffledOrder: string[];
}> {
  const judgedRows = input.rows.slice(0, input.config.judgeInputLimit);
  const overflowRows = input.rows.slice(input.config.judgeInputLimit);
  const judgeCandidates: RelevanceJudgeCandidate[] = judgedRows.map((row) => ({
    id: row.id,
    content: row.result.pageContent,
    metadata: row.result.metadata as Record<string, unknown>,
  }));

  let result: RelevanceJudgeResult;
  try {
    result = await judgeRelevance({
      endpoint: input.config.judgeEndpoint as string,
      model: input.config.judgeModel,
      timeoutMs: input.config.judgeTimeoutMs,
      query: input.query,
      taskContext: input.taskContext,
      candidates: judgeCandidates,
      seed: input.seed,
      fetchImpl: input.fetchImpl,
      beforeAttempt: async () => {
        const latest = await hydrateSensitivityPoliciesFromSource(
          judgedRows.map((row) => row.result),
        );
        if (latest.some((candidate) => excludesLlmContext(candidate.metadata as Record<string, unknown>))) {
          throw new RelevancePolicyBoundaryError();
        }
      },
    });
  } catch (err) {
    input.llmMetrics.recordAnswerImpact('gate', 'not_used');
    return {
      survivors: input.rows,
      judge: { status: 'failed', reason: `judge failed; degraded to A2: ${(err as Error).message}` },
      state: 'injected',
      lowConfidence: false,
      degraded: true,
      judgePromptHash: null,
      shuffledOrder: [],
    };
  }

  input.llmMetrics.recordAnswerImpact('gate', 'used');

  if (result.overall === 'partial') {
    return {
      survivors: input.rows,
      judge: { status: 'succeeded', model: result.model, reason: 'overall partial kept full set' },
      state: 'injected',
      lowConfidence: false,
      degraded: false,
      judgePromptHash: result.promptHash,
      shuffledOrder: result.shuffledIds,
    };
  }

  const hasLexicalHit = input.lexicalHitIds.size > 0;
  if (result.overall === 'no-relevant-context') {
    if (input.config.emptyVerdictEnabled && !hasLexicalHit) {
      for (const row of input.rows) {
        input.dropped.push({
          id: row.id,
          stage: 'B-empty-verdict',
          reason: 'judge found no relevant context',
        });
      }
      return {
        survivors: [],
        judge: { status: 'succeeded', model: result.model, reason: 'empty verdict accepted' },
        state: 'no-relevant-context',
        lowConfidence: false,
        degraded: false,
        judgePromptHash: result.promptHash,
        shuffledOrder: result.shuffledIds,
      };
    }
    const reason = input.config.emptyVerdictEnabled
      ? 'BM25 lexical hit vetoed empty verdict'
      : 'empty verdict disabled by configuration';
    return {
      survivors: input.rows,
      judge: { status: 'succeeded', model: result.model, reason },
      state: 'injected',
      lowConfidence: true,
      degraded: false,
      judgePromptHash: result.promptHash,
      shuffledOrder: result.shuffledIds,
    };
  }

  const keepIds = new Set(overflowRows.map((row) => row.id));
  for (const verdict of result.verdicts) {
    if (verdict.decision === 'keep') {
      keepIds.add(verdict.id);
    } else {
      input.dropped.push({
        id: verdict.id,
        stage: 'B-judge',
        reason: verdict.reason,
      });
    }
  }
  return {
    survivors: input.rows.filter((row) => keepIds.has(row.id)),
    judge: { status: 'succeeded', model: result.model },
    state: 'injected',
    lowConfidence: result.verdicts.some((verdict) => verdict.downgraded === true),
    degraded: false,
    judgePromptHash: result.promptHash,
    shuffledOrder: result.shuffledIds,
  };
}

class RelevancePolicyBoundaryError extends Error {
  constructor() {
    super('source policy excluded relevance-judge LLM work');
    this.name = 'RelevancePolicyBoundaryError';
  }
}

function replayVerdict<T extends RelevanceGateCandidate>(
  candidates: T[],
  cached: CachedGateDecision,
): T[] {
  if (cached.verdict.state === 'bypassed') return candidates;
  return candidates.filter((candidate) => {
    const id = chunkIdFromMetadata(candidate.metadata as Record<string, unknown>);
    return cached.resultIds.has(id);
  });
}

function partitionCandidates<T extends RelevanceGateCandidate>(
  input: RelevanceGateInput<T>,
): CandidatePartition<T> {
  const rows = input.candidates.map((candidate, originalIndex) => ({
    id: chunkIdFromMetadata(candidate.metadata as Record<string, unknown>),
    result: candidate,
    originalIndex,
  }));
  const policyExcludedRows = rows.filter((row) =>
    excludesLlmContext(row.result.metadata as Record<string, unknown>),
  );
  const gateRows = rows.filter((row) =>
    !excludesLlmContext(row.result.metadata as Record<string, unknown>),
  );
  const gateRowIds = new Set(gateRows.map((row) => row.id));
  const lexicalHitIds = new Set(
    Array.from(input.lexicalHitIds ?? []).filter((id) => gateRowIds.has(id)),
  );
  return { rows, policyExcludedRows, gateRows, lexicalHitIds };
}

function buildVerdict(input: {
  state: RelevanceGateVerdict['state'];
  lowConfidence?: boolean;
  inputCount: number;
  outputCount: number;
  dropped?: DropRecord[];
  judge: RelevanceGateVerdict['judge'];
  emptyVerdictEnabled: boolean;
}): RelevanceGateVerdict {
  return {
    schema_version: RELEVANCE_GATE_SCHEMA_VERSION,
    state: input.state,
    low_confidence: input.lowConfidence ?? false,
    input_count: input.inputCount,
    output_count: input.outputCount,
    dropped: input.dropped ?? [],
    judge: input.judge,
    empty_verdict_enabled: input.emptyVerdictEnabled,
  };
}

async function hydrateSensitivityPoliciesFromSource<T extends RelevanceGateCandidate>(
  candidates: T[],
): Promise<T[]> {
  const policyBySource = new Map<string, Promise<Awaited<ReturnType<typeof readLlmContextPolicy>>>>();

  return Promise.all(candidates.map(async (candidate) => {
    const metadata = candidate.metadata as Record<string, unknown>;
    const source = metadata.source;
    if (typeof source !== 'string' || source.trim().length === 0) {
      // Without a source path the current frontmatter policy cannot be
      // verified, so retain the result only as retrieval data and exclude it
      // from every LLM prompt.
      return excludesLlmContext(metadata)
        ? candidate
        : markLlmContextExcluded(candidate, metadata);
    }

    let sourcePolicyPromise = policyBySource.get(source);
    if (sourcePolicyPromise === undefined) {
      sourcePolicyPromise = readLlmContextPolicy(source);
      policyBySource.set(source, sourcePolicyPromise);
    }
    const sourcePolicy = await sourcePolicyPromise;

    if (!sourcePolicy.readable || !sourcePolicy.valid) {
      // A candidate whose source cannot be verified is preserved for retrieval
      // but excluded from every LLM prompt. This boundary must fail closed.
      return excludesLlmContext(metadata)
        ? candidate
        : markLlmContextExcluded(candidate, metadata);
    }

    const frontmatter = metadata.frontmatter;
    const frontmatterObject =
      frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter)
        ? frontmatter as Record<string, unknown>
        : {};
    if (sourcePolicy.policy === undefined && !Object.prototype.hasOwnProperty.call(frontmatterObject, 'kb_policy')) {
      return candidate;
    }
    const hydratedFrontmatter = { ...frontmatterObject };
    if (sourcePolicy.policy === undefined) {
      delete hydratedFrontmatter.kb_policy;
    } else {
      hydratedFrontmatter.kb_policy = sourcePolicy.policy;
    }
    return {
      ...candidate,
      metadata: {
        ...metadata,
        frontmatter: {
          ...hydratedFrontmatter,
        },
      },
    };
  }));
}

function markLlmContextExcluded<T extends RelevanceGateCandidate>(
  candidate: T,
  metadata: Record<string, unknown>,
): T {
  const frontmatter = metadata.frontmatter;
  const frontmatterObject =
    frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter)
      ? frontmatter as Record<string, unknown>
      : {};
  const existingPolicy = normalizeKbSensitivityPolicy(frontmatterObject.kb_policy) ?? {};
  return {
    ...candidate,
    metadata: {
      ...metadata,
      frontmatter: {
        ...frontmatterObject,
        kb_policy: {
          ...existingPolicy,
          no_llm_context: true,
        },
      },
    },
  };
}

function buildCacheKey<T extends RelevanceGateCandidate>(
  input: RelevanceGateInput<T>,
  config: RelevanceGateConfig,
  lexicalHitIds: ReadonlySet<string>,
): string {
  const hash = createHash('sha256');
  hash.update(input.query);
  hash.update('\0');
  hash.update(input.taskContext ?? '');
  hash.update('\0');
  hash.update(JSON.stringify({
    floor: config.scoreFloor,
    limit: config.judgeInputLimit,
    endpoint: config.judgeEndpoint ?? '',
    model: config.judgeModel ?? '',
    empty: config.emptyVerdictEnabled,
  }));
  for (const lexicalId of Array.from(lexicalHitIds).sort()) {
    hash.update('\0lexical:');
    hash.update(lexicalId);
  }
  for (const candidate of input.candidates) {
    const id = chunkIdFromMetadata(candidate.metadata as Record<string, unknown>);
    hash.update('\0');
    hash.update(id);
    hash.update('\0');
    hash.update(String(input.denseDistanceById?.get(id) ?? ''));
    hash.update('\0');
    hash.update(candidate.pageContent);
    hash.update('\0policy_no_llm_context:');
    hash.update(String(excludesLlmContext(candidate.metadata as Record<string, unknown>)));
  }
  return hash.digest('hex');
}

function rowsForObservability<T extends RelevanceGateCandidate>(
  candidates: T[],
): CandidateRow<T>[] {
  return candidates.map((candidate, originalIndex) => ({
    id: chunkIdFromMetadata(candidate.metadata as Record<string, unknown>),
    result: candidate,
    originalIndex,
  }));
}

function buildObservability<T extends RelevanceGateCandidate>(input: {
  query: string;
  taskContext?: string;
  config: RelevanceGateConfig;
  rows: CandidateRow<T>[];
  survivors: CandidateRow<T>[];
  dropped: DropRecord[];
  judge: RelevanceGateVerdict['judge'];
  judgePromptHash?: string | null;
  shuffledOrder?: string[];
}): RelevanceGateObservability {
  const survivorIds = new Set(input.survivors.map((row) => row.id));
  const firstDropById = new Map<string, DropRecord>();
  for (const drop of input.dropped) {
    if (!firstDropById.has(drop.id)) firstDropById.set(drop.id, drop);
  }
  return {
    task_context_sha: hashNullable(input.taskContext),
    query_sha: shortHash(input.query),
    floor: input.config.scoreFloor,
    judge_model: input.judge.model ?? input.config.judgeModel ?? null,
    judge_prompt_hash: input.judgePromptHash ?? null,
    shuffled_order: input.shuffledOrder ?? [],
    degraded: input.judge.status === 'failed',
    degrade_reason: input.judge.status === 'failed' ? input.judge.reason ?? 'judge failed' : null,
    judge_skipped: input.judge.status === 'skipped' ? input.judge.reason ?? 'skipped' : null,
    candidates: input.rows.map((row) => {
      const drop = firstDropById.get(row.id);
      const kept = survivorIds.has(row.id);
      return {
        id: row.id,
        content_sha: shortHash(row.result.pageContent),
        decision: kept ? 'kept' : 'dropped',
        stage: kept ? null : drop?.stage ?? null,
        reason: kept ? null : drop?.reason ?? null,
      };
    }),
  };
}

function hashNullable(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  return shortHash(value);
}

function shortHash(value: string): string {
  return createHash('sha256')
    .update(value.trim().replace(/\s+/g, ' '), 'utf-8')
    .digest('hex')
    .slice(0, 16);
}

function normalizeTaskContext(taskContext: string | undefined): string {
  return (taskContext ?? '').slice(0, 2000).trim();
}

function guardTaskContext(taskContext: string): string {
  return applyInjectionGuard(taskContext, { source: 'task_context' }).content;
}

function hasTaskSignal(taskContext: string, minTokens: number): boolean {
  const tokens = taskContext.match(/\S+/g) ?? [];
  return tokens.length >= minTokens;
}
