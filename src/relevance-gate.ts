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
}

export interface RelevanceGateResult<T extends RelevanceGateCandidate = RelevanceGateCandidate> {
  results: T[];
  verdict: RelevanceGateVerdict;
}

export interface RelevanceGateCanonicalInput {
  process: CanonicalProcess;
  query: string;
  kbScope?: string | null;
  searchMode: CanonicalSearchMode;
  verdict: RelevanceGateVerdict;
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
}

const verdictCache = new Map<string, CachedGateDecision>();

export async function applyRelevanceGate<T extends RelevanceGateCandidate>(
  input: RelevanceGateInput<T>,
): Promise<RelevanceGateResult<T>> {
  const config = input.config ?? resolveRelevanceGateConfig();
  const enabled = input.gateOverride === 'on' || (config.enabled && input.gateOverride !== 'off');
  if (!enabled) {
    return {
      results: input.candidates,
      verdict: buildVerdict({
        state: 'bypassed',
        inputCount: input.candidates.length,
        outputCount: input.candidates.length,
        emptyVerdictEnabled: config.emptyVerdictEnabled,
        judge: { status: 'not-run', reason: 'gate disabled' },
      }),
    };
  }

  if (input.candidates.length === 0) {
    return {
      results: [],
      verdict: buildVerdict({
        state: 'empty-index',
        inputCount: 0,
        outputCount: 0,
        emptyVerdictEnabled: config.emptyVerdictEnabled,
        judge: { status: 'not-run', reason: 'no candidates' },
      }),
    };
  }

  const cacheKey = buildCacheKey(input, config);
  const cached = verdictCache.get(cacheKey);
  if (cached !== undefined) {
    return {
      results: replayVerdict(input.candidates, cached),
      verdict: cached.verdict,
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
  verdictCache.set(cacheKey, {
    verdict,
    resultIds: new Set(survivors.map((row) => row.id)),
  });
  return { results, verdict };
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
    };
  }

  if (result.overall === 'partial') {
    return {
      survivors: input.rows,
      judge: { status: 'succeeded', model: result.model, reason: 'overall partial kept full set' },
      state: 'injected',
      lowConfidence: false,
      degraded: false,
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
