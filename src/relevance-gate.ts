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

interface CachedGateDecision {
  verdict: RelevanceGateVerdict;
  resultIds: Set<string>;
  observability: RelevanceGateObservability;
}

const verdictCache = new Map<string, CachedGateDecision>();

export async function applyRelevanceGate<T extends RelevanceGateCandidate>(
  input: RelevanceGateInput<T>,
): Promise<RelevanceGateResult<T>> {
  const config = input.config ?? resolveRelevanceGateConfig();
  const enabled = input.gateOverride === 'on' || (config.enabled && input.gateOverride !== 'off');
  if (!enabled) {
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

  const cacheKey = buildCacheKey(input, config);
  const cached = verdictCache.get(cacheKey);
  if (cached !== undefined) {
    relevanceGateMetrics.record(cached.verdict, input.process);
    return {
      results: replayVerdict(input.candidates, cached),
      verdict: cached.verdict,
      observability: cached.observability,
    };
  }

  const rows = input.candidates.map((candidate, originalIndex) => ({
    id: chunkIdFromMetadata(candidate.metadata as Record<string, unknown>),
    result: candidate,
    originalIndex,
  }));
  const dropped: DropRecord[] = [];
  const afterA1 = applyA1(rows, input.denseDistanceById, config.scoreFloor, dropped);
  const taskContext = normalizeTaskContext(input.taskContext);
  const lexicalHitIds = input.lexicalHitIds ?? new Set<string>();
  let survivors: CandidateRow<T>[];
  let judge: RelevanceGateVerdict['judge'];
  let judgePromptHash: string | null = null;
  let shuffledOrder: string[] = [];
  let lowConfidence = false;
  let state: RelevanceGateVerdict['state'] = 'injected';

  if (!hasTaskSignal(taskContext, config.minTaskContextTokens)) {
    survivors = applyA2(afterA1, dropped, input.denseDistanceById);
    judge = { status: 'skipped', reason: 'task_context absent or too short' };
  } else if (config.judgeEndpoint === undefined) {
    survivors = applyA2(afterA1, dropped, input.denseDistanceById);
    judge = { status: 'failed', reason: 'KB_GATE_LLM_ENDPOINT unset; degraded to A2' };
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
    });
    survivors = judged.survivors;
    judge = judged.judge;
    state = judged.state;
    if (judged.lowConfidence) lowConfidence = true;
    judgePromptHash = judged.judgePromptHash;
    shuffledOrder = judged.shuffledOrder;
    if (judged.degraded) {
      survivors = applyA2(afterA1, dropped, input.denseDistanceById);
    }
  }

  if (state !== 'no-relevant-context' && survivors.length === 0) {
    const rescued = rows[0];
    survivors = [rescued];
    lowConfidence = true;
  }

  const results = survivors
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((row) => row.result);
  const verdict = buildVerdict({
    state,
    lowConfidence,
    inputCount: input.candidates.length,
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
    survivors,
    dropped,
    judge,
    judgePromptHash,
    shuffledOrder,
  });
  relevanceGateMetrics.record(verdict, input.process);
  verdictCache.set(cacheKey, {
    verdict,
    resultIds: new Set(survivors.map((row) => row.id)),
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
): CandidateRow<T>[] {
  const survivors: CandidateRow<T>[] = [];
  const stageDrops: DropRecord[] = [];
  for (const row of rows) {
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
  const scored = rows.map((row) => ({
    row,
    score:
      denseDistanceById === undefined
        ? typeof row.result.score === 'number'
          ? row.result.score
          : row.originalIndex
        : denseDistanceById.get(row.id) ?? row.originalIndex,
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
  return rows.filter((row) => keepIds.has(row.id));
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
    });
  } catch (err) {
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

function buildCacheKey<T extends RelevanceGateCandidate>(
  input: RelevanceGateInput<T>,
  config: RelevanceGateConfig,
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
  for (const lexicalId of Array.from(input.lexicalHitIds ?? []).sort()) {
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
