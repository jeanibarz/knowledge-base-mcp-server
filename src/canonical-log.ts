import { createHash, randomBytes } from 'crypto';
import { logger } from './logger.js';
import { KBError, type KBErrorCode } from './errors.js';
import { ActiveModelResolutionError } from './active-model.js';
import type { QueryCacheOutcome, QueryCacheTelemetry } from './query-cache.js';
import { readKBSlowQueryMs } from './config/logging.js';
import type { DenseDegradationReason } from './search-core.js';

export const CANONICAL_SCHEMA_VERSION = 'kb-canonical.v1';

export type CanonicalProcess = 'mcp' | 'cli';
export type CanonicalCacheStatus = QueryCacheOutcome;
export type CanonicalSearchMode = 'dense' | 'lexical' | 'hybrid' | 'auto';
export type CanonicalErrorCategory =
  | 'configuration'
  | 'indexing'
  | 'provider'
  // RFC 017 — `external` for LLM-side issues that originate outside the
  // kb-mcp process boundary (e.g. llama-server unreachable, refusals,
  // malformed responses). Distinct from `provider` (the embedding
  // provider) and from `unknown` (catch-all) so monitoring can route
  // these alerts to LLM-runtime ops rather than kb-mcp.
  | 'external'
  | 'permissions'
  | 'input'
  | 'lock'
  | 'unknown';

export interface CanonicalError {
  code: string;
  category: CanonicalErrorCategory;
}

export interface CanonicalDegradedStage {
  stage: 'dense' | 'rerank' | 'gate';
  reason?: string;
}

export interface CanonicalGateStageInput {
  state: string;
  input_count: number;
  output_count: number;
  judge: {
    status: string;
    reason?: string;
  };
}

export interface CanonicalRerankStageInput {
  model: string;
  candidatesIn: number;
  cacheHits: number;
  degraded: boolean;
  degradeReason: string | null;
}

export interface CanonicalLogEvent {
  schema_version: typeof CANONICAL_SCHEMA_VERSION;
  ts: string;
  request_id: string;
  process: CanonicalProcess;
  event?: string;
  level?: 'warn';
  slow?: true;
  tool?: string;
  cmd?: string;
  model_id?: string;
  kb_scope?: string | null;
  query_sha256?: string;
  query_len_chars?: number;
  k?: number;
  threshold?: number;
  search_mode?: CanonicalSearchMode;
  result_count?: number;
  top_score?: number;
  top_sources?: string[];
  took_ms: number;
  embed_ms?: number;
  faiss_ms?: number;
  format_ms?: number;
  cache?: CanonicalCacheStatus;
  query_cache?: QueryCacheTelemetry;
  error?: CanonicalError;
  degraded?: true;
  degraded_stages?: CanonicalDegradedStage[];
  degrade_reason?: DenseDegradationReason;
  recovery_hint?: string;
  rerank?: Record<string, unknown>;
  gate?: Record<string, unknown>;
  secret_scan?: Record<string, unknown>;
  llm_provider?: string;
}

export type CanonicalLogInput = Omit<
  CanonicalLogEvent,
  'schema_version' | 'ts' | 'request_id' | 'query_sha256' | 'slow'
> & {
  request_id?: string;
  ts?: string;
  query?: string;
  query_sha256?: string;
};

const CANONICAL_FIELD_ORDER: readonly (keyof CanonicalLogEvent)[] = [
  'schema_version',
  'ts',
  'request_id',
  'process',
  'event',
  'level',
  'slow',
  'tool',
  'cmd',
  'model_id',
  'kb_scope',
  'query_sha256',
  'query_len_chars',
  'k',
  'threshold',
  'search_mode',
  'result_count',
  'top_score',
  'top_sources',
  'took_ms',
  'embed_ms',
  'faiss_ms',
  'format_ms',
  'cache',
  'query_cache',
  'error',
  'degraded',
  'degraded_stages',
  'degrade_reason',
  'recovery_hint',
  'rerank',
  'gate',
  'secret_scan',
  'llm_provider',
];

export function createCanonicalRequestId(): string {
  const now = Date.now().toString(36).padStart(8, '0');
  return `${now}${randomBytes(8).toString('hex')}`;
}

export function hashQuery(query: string): string {
  return createHash('sha256')
    .update(query.trim().replace(/\s+/g, ' '), 'utf-8')
    .digest('hex')
    .slice(0, 16);
}

export function normalizeCanonicalEvent(input: CanonicalLogInput): CanonicalLogEvent {
  const event: CanonicalLogEvent = {
    schema_version: CANONICAL_SCHEMA_VERSION,
    ts: input.ts ?? new Date().toISOString(),
    request_id: input.request_id ?? createCanonicalRequestId(),
    process: input.process,
    took_ms: Math.max(0, Math.round(input.took_ms)),
  };

  const slowQueryMs = readKBSlowQueryMs();
  if (slowQueryMs !== undefined && event.took_ms > slowQueryMs) {
    event.level = 'warn';
    event.slow = true;
  }

  assignIfDefined(event, 'tool', input.tool);
  assignIfDefined(event, 'event', input.event);
  assignIfDefined(event, 'level', input.level);
  assignIfDefined(event, 'cmd', input.cmd);
  assignIfDefined(event, 'model_id', input.model_id);
  assignIfDefined(event, 'kb_scope', input.kb_scope);
  assignIfDefined(event, 'query_sha256', input.query_sha256 ?? (input.query !== undefined ? hashQuery(input.query) : undefined));
  assignIfDefined(event, 'query_len_chars', input.query_len_chars ?? (input.query !== undefined ? input.query.length : undefined));
  assignIfDefined(event, 'k', input.k);
  assignIfDefined(event, 'threshold', input.threshold);
  assignIfDefined(event, 'search_mode', input.search_mode);
  assignIfDefined(event, 'result_count', input.result_count);
  assignIfDefined(event, 'top_score', input.top_score);
  assignIfDefined(event, 'top_sources', input.top_sources?.slice(0, 3));
  assignIfDefined(event, 'embed_ms', roundNonNegative(input.embed_ms));
  assignIfDefined(event, 'faiss_ms', roundNonNegative(input.faiss_ms));
  assignIfDefined(event, 'format_ms', roundNonNegative(input.format_ms));
  assignIfDefined(event, 'cache', input.cache);
  assignIfDefined(event, 'query_cache', input.query_cache);
  assignIfDefined(event, 'error', input.error);
  assignIfDefined(event, 'degrade_reason', input.degrade_reason);
  assignIfDefined(event, 'recovery_hint', input.recovery_hint);
  assignIfDefined(event, 'rerank', input.rerank);
  assignIfDefined(event, 'gate', input.gate);
  assignIfDefined(event, 'secret_scan', input.secret_scan);
  assignIfDefined(event, 'llm_provider', input.llm_provider);

  applyDegradationSummary(event, input.degraded);

  return event;
}

export function deriveDegradedStages(input: {
  degraded?: true;
  degrade_reason?: DenseDegradationReason;
  rerank?: Record<string, unknown>;
  gate?: Record<string, unknown>;
}): CanonicalDegradedStage[] {
  const stages: CanonicalDegradedStage[] = [];
  if (input.degraded === true || input.degrade_reason !== undefined) {
    stages.push({
      stage: 'dense',
      ...(input.degrade_reason !== undefined ? { reason: input.degrade_reason } : {}),
    });
  }
  addSubrecordDegradation(stages, 'rerank', input.rerank);
  addSubrecordDegradation(stages, 'gate', input.gate);
  return stages;
}

export function degradationSummaryFields(input: {
  degraded?: true;
  degrade_reason?: DenseDegradationReason;
  rerank?: Record<string, unknown>;
  gate?: Record<string, unknown>;
}): { degraded?: true; degraded_stages?: CanonicalDegradedStage[] } {
  const degradedStages = deriveDegradedStages(input);
  return degradedStages.length === 0
    ? {}
    : { degraded: true, degraded_stages: degradedStages };
}

export function canonicalGateStageRecord(
  verdict: CanonicalGateStageInput,
): Record<string, unknown> | undefined {
  if (verdict.state === 'bypassed') return undefined;
  const degraded = verdict.judge.status === 'failed';
  return {
    state: verdict.state,
    input_count: verdict.input_count,
    output_count: verdict.output_count,
    degraded,
    degrade_reason: degraded ? verdict.judge.reason ?? 'judge failed' : null,
  };
}

export function canonicalRerankStageRecord(
  result: CanonicalRerankStageInput,
): Record<string, unknown> | undefined {
  if (result.candidatesIn === 0) return undefined;
  return {
    model: result.model,
    candidates_in: result.candidatesIn,
    cache_hits: result.cacheHits,
    degraded: result.degraded,
    degrade_reason: result.degradeReason,
  };
}

export function stableCanonicalJson(event: CanonicalLogEvent): string {
  const ordered: Record<string, unknown> = {};
  for (const key of CANONICAL_FIELD_ORDER) {
    if (event[key] !== undefined) {
      ordered[key] = event[key];
    }
  }
  return JSON.stringify(ordered);
}

export function emitCanonicalLog(input: CanonicalLogInput): void {
  logger.canonical(stableCanonicalJson(normalizeCanonicalEvent(input)));
}

export function classifyCanonicalError(error: unknown): CanonicalError {
  if (error instanceof ActiveModelResolutionError) {
    return { code: 'ACTIVE_MODEL_UNRESOLVED', category: 'configuration' };
  }
  if (error instanceof KBError) {
    return { code: error.code, category: categoryForKBError(error.code) };
  }
  const code = typeof (error as { code?: unknown } | undefined)?.code === 'string'
    ? String((error as { code: string }).code)
    : 'INTERNAL';
  return { code, category: 'unknown' };
}

export function canonicalErrorFromToolResult(result: {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}): CanonicalError | undefined {
  if (result.isError !== true) return undefined;
  const text = result.content?.find((entry) => entry.type === 'text' && typeof entry.text === 'string')?.text;
  if (text === undefined) return { code: 'INTERNAL', category: 'unknown' };
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; category?: unknown } };
    const code = typeof parsed.error?.code === 'string' ? parsed.error.code : 'INTERNAL';
    const category = typeof parsed.error?.category === 'string'
      ? normalizeErrorCategory(parsed.error.category)
      : categoryForCode(code);
    return { code, category };
  } catch {
    return { code: 'INTERNAL', category: 'unknown' };
  }
}

function categoryForCode(code: string): CanonicalErrorCategory {
  return isKBErrorCode(code) ? categoryForKBError(code) : 'unknown';
}

function categoryForKBError(code: KBErrorCode): CanonicalErrorCategory {
  switch (code) {
    case 'INDEX_NOT_INITIALIZED':
    case 'CORRUPT_INDEX':
      return 'indexing';
    case 'PROVIDER_AUTH':
      return 'configuration';
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_TIMEOUT':
      return 'provider';
    case 'KB_NOT_FOUND':
      return 'configuration';
    case 'PERMISSION_DENIED':
      return 'permissions';
    case 'VALIDATION':
      return 'input';
    case 'INTERNAL':
      return 'unknown';
    // RFC 017 — contextual-retrieval failure taxonomy.
    case 'PREFACE_LLM_FAILURE':
      return 'external';
    case 'PREFACE_SIDECAR_CORRUPT':
      return 'indexing';
    case 'REINDEX_LOCK_HELD':
      return 'lock';
    case 'REINDEX_BUDGET_EXCEEDED':
      return 'input';
  }
}

function isKBErrorCode(code: string): code is KBErrorCode {
  return [
    'INDEX_NOT_INITIALIZED',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_TIMEOUT',
    'PROVIDER_AUTH',
    'KB_NOT_FOUND',
    'PERMISSION_DENIED',
    'CORRUPT_INDEX',
    'VALIDATION',
    'INTERNAL',
    'PREFACE_LLM_FAILURE',
    'PREFACE_SIDECAR_CORRUPT',
    'REINDEX_LOCK_HELD',
    'REINDEX_BUDGET_EXCEEDED',
  ].includes(code);
}

function normalizeErrorCategory(raw: string): CanonicalErrorCategory {
  if ([
    'configuration',
    'indexing',
    'provider',
    'external',
    'permissions',
    'input',
    'lock',
    'unknown',
  ].includes(raw)) {
    return raw as CanonicalErrorCategory;
  }
  return 'unknown';
}

function assignIfDefined<K extends keyof CanonicalLogEvent>(
  event: CanonicalLogEvent,
  key: K,
  value: CanonicalLogEvent[K] | undefined,
): void {
  if (value !== undefined) {
    event[key] = value;
  }
}

function roundNonNegative(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(0, Math.round(value));
}

function applyDegradationSummary(event: CanonicalLogEvent, explicitDegraded: true | undefined): void {
  const summary = degradationSummaryFields({
    degraded: explicitDegraded,
    degrade_reason: event.degrade_reason,
    rerank: event.rerank,
    gate: event.gate,
  });
  assignIfDefined(event, 'degraded', summary.degraded);
  assignIfDefined(event, 'degraded_stages', summary.degraded_stages);
}

function addSubrecordDegradation(
  stages: CanonicalDegradedStage[],
  stage: CanonicalDegradedStage['stage'],
  record: Record<string, unknown> | undefined,
): void {
  if (record?.degraded !== true) return;
  const reason = stringRecordField(record, 'degrade_reason')
    ?? stringRecordField(record, 'degradeReason')
    ?? stringRecordField(record, 'reason');
  stages.push({
    stage,
    ...(reason !== undefined && reason !== '' ? { reason } : {}),
  });
}

function stringRecordField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}
