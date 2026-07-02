import { existsSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CANONICAL_SCHEMA_VERSION, type CanonicalLogEvent } from './canonical-log.js';
import { type DelimitedOutputFormat, renderRecords } from './cli-shared.js';

export const LOGS_HELP = `kb logs — inspect historical canonical request logs

Usage:
  kb logs --slow [--min-ms=<n>] [--limit=<n>] [--file=<path>] [--format=md|json|csv|tsv|ndjson]
  kb logs --degraded [--limit=<n>] [--file=<path>] [--format=md|json|csv|tsv|ndjson]
  kb logs --summary [--limit=<n>] [--file=<path>] [--format=md|json|csv|tsv|ndjson]
  kb logs recent [--slow] [--degraded] [--min-ms=<n>] [--limit=<n>] [--file=<path>] [--format=md|json|csv|tsv|ndjson]
  kb logs show --request-id=<id> [--file=<path>] [--format=md|json|csv|tsv|ndjson]
  kb logs show --query-sha=<hash> [--file=<path>] [--format=md|json|csv|tsv|ndjson]

Reads mixed text/canonical log files, keeps only \`kb-canonical.v1\` JSON lines,
and summarizes request ids, query hashes, timings, errors, cache state, gate
fields, rerank fields, top sources, and recovery hints.

The --summary view aggregates the whole log into a post-hoc report: request
counts by outcome and error code/category, latency percentiles (p50/p95/p99)
over took_ms, and the top-N slowest queries.

Options:
  --file=<path>         Log file to read. Defaults to LOG_FILE, then known
                        local log paths if they exist.
  --format=md|json|csv|tsv|ndjson
                        Output format (default: md). Delimited formats emit
                        event rows; summary emits one aggregate row.
  --limit=<n>           Number of recent canonical events to show, or top-N
                        slowest queries for --summary (default: 20).
  --slow                Show only events marked slow, or events matching
                        --min-ms when that filter is supplied.
  --degraded            Show only events with aggregate degraded=true.
  --min-ms=<n>          Minimum took_ms for the slow view; implies --slow.
  --summary             Aggregate the whole log into a diagnostics report.
  --request-id=<id>     Show canonical events for one request id.
  --query-sha=<hash>    Show canonical events for one query_sha256 value.
  --help, -h            Show this help.

Examples:
  kb logs recent
  kb logs --slow
  kb logs --degraded
  kb logs --summary
  kb logs --summary --limit=5 --format=json
  kb logs recent --slow --min-ms=1000
  kb logs recent --limit=5 --format=json
  kb logs show --request-id=maw6d3qfabcd1234
  kb logs show --query-sha=0123456789abcdef
`;

const LOGS_SCHEMA_VERSION = 'kb.logs.v1';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;

type LogsAction = 'recent' | 'show' | 'summary';
type LogsFormat = 'md' | 'json' | DelimitedOutputFormat;

export interface LogsArgs {
  action: LogsAction;
  format: LogsFormat;
  file?: string;
  limit: number;
  slow: boolean;
  degraded: boolean;
  minMs?: number;
  requestId?: string;
  querySha?: string;
}

export interface ParsedCanonicalLogs {
  events: CanonicalLogRecord[];
  scannedLineCount: number;
  ignoredLineCount: number;
  malformedCanonicalLineCount: number;
}

export type CanonicalLogRecord = CanonicalLogEvent & Record<string, unknown>;

interface LogsPayload {
  schema_version: typeof LOGS_SCHEMA_VERSION;
  action: LogsAction;
  source: string;
  filters: {
    request_id?: string;
    query_sha256?: string;
    slow?: true;
    degraded?: true;
    min_ms?: number;
  };
  scanned_line_count: number;
  canonical_event_count: number;
  ignored_line_count: number;
  malformed_canonical_line_count: number;
  slow_event_count: number;
  degraded_event_count: number;
  result_count: number;
  events: CanonicalLogSummary[];
  summary?: LogsAggregate;
}

interface LogsAggregate {
  total_requests: number;
  outcomes: {
    success: number;
    error: number;
  };
  by_error_code: Record<string, number>;
  by_error_category: Record<string, number>;
  latency_ms: LatencyStats | null;
  slowest: SlowestQuery[];
}

interface LatencyStats {
  count: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

interface SlowestQuery {
  request_id?: string;
  query_sha256?: string;
  took_ms: number;
  ts?: string;
  cmd?: string;
  error_code?: string;
}

interface CanonicalLogSummary {
  ts?: string;
  request_id?: string;
  process?: string;
  event?: string;
  cmd?: string;
  tool?: string;
  model_id?: string;
  kb_scope?: string | null;
  query_sha256?: string;
  took_ms?: number;
  slow?: true;
  degraded?: true;
  degraded_stages?: CanonicalLogSummaryDegradedStage[];
  timings: {
    embed_ms?: number;
    faiss_ms?: number;
    format_ms?: number;
  };
  cache?: string;
  query_cache?: unknown;
  result_count?: number;
  top_score?: number;
  top_sources?: string[];
  error?: unknown;
  recovery_hint?: string;
  gate?: unknown;
  rerank?: Record<string, unknown>;
}

interface CanonicalLogSummaryDegradedStage {
  stage: string;
  reason?: string;
}

export interface RunLogsDeps {
  readFile: (filePath: string) => string;
  exists: (filePath: string) => boolean;
  env: NodeJS.ProcessEnv;
  cwd: () => string;
  homedir: () => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_DEPS: RunLogsDeps = {
  readFile: (filePath) => readFileSync(filePath, 'utf-8'),
  exists: (filePath) => existsSync(filePath),
  env: process.env,
  cwd: () => process.cwd(),
  homedir: () => os.homedir(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runLogs(rest: string[], deps: RunLogsDeps = DEFAULT_DEPS): Promise<number> {
  let args: LogsArgs;
  try {
    args = parseLogsArgs(rest);
  } catch (err) {
    deps.stderr(`kb logs: ${(err as Error).message}\n`);
    return 2;
  }

  const source = resolveLogFile(args, deps);
  if (source === null) {
    const message = 'no log file found; pass --file=<path> or set LOG_FILE';
    if (args.format === 'json') {
      deps.stdout(`${JSON.stringify({
        schema_version: LOGS_SCHEMA_VERSION,
        error: { code: 'LOG_FILE_NOT_FOUND', message },
      }, null, 2)}\n`);
    } else {
      deps.stderr(`kb logs: ${message}\n`);
    }
    return 2;
  }

  let parsed: ParsedCanonicalLogs;
  try {
    parsed = parseCanonicalLogLines(deps.readFile(source));
  } catch (err) {
    const message = (err as Error).message;
    if (args.format === 'json') {
      deps.stdout(`${JSON.stringify({
        schema_version: LOGS_SCHEMA_VERSION,
        source,
        error: { code: 'LOG_READ_FAILED', message },
      }, null, 2)}\n`);
    } else {
      deps.stderr(`kb logs: failed to read ${source}: ${message}\n`);
    }
    return 1;
  }

  const events = selectEvents(parsed.events, args);
  const payload = buildLogsPayload(args, source, parsed, events);
  deps.stdout(formatLogsOutput(payload, args.format));
  return 0;
}

export function parseLogsArgs(rest: string[]): LogsArgs {
  if (rest.length === 0) {
    throw new Error('missing action: expected recent or show');
  }
  let action: LogsAction;
  let optionStart = 1;
  if (rest[0] === 'recent' || rest[0] === 'show' || rest[0] === 'summary') {
    action = rest[0];
  } else if (rest[0] === '--summary') {
    action = 'summary';
    optionStart = 0;
  } else if (
    rest[0] === '--slow' ||
    rest[0] === '--degraded' ||
    rest[0] === '--min-ms' ||
    rest[0].startsWith('--min-ms=')
  ) {
    action = 'recent';
    optionStart = 0;
  } else {
    throw new Error(`unknown action: ${JSON.stringify(rest[0])}`);
  }

  const out: LogsArgs = { action, format: 'md', limit: DEFAULT_LIMIT, slow: false, degraded: false };
  for (let index = optionStart; index < rest.length; index++) {
    const raw = rest[index];
    if (raw.startsWith('--file=')) {
      const value = raw.slice('--file='.length);
      if (value === '') throw new Error('empty --file value');
      out.file = value;
      continue;
    }
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (!isLogsFormat(value)) {
        throw new Error(`invalid --format: ${raw}`);
      }
      out.format = value;
      continue;
    }
    if (raw.startsWith('--limit=')) {
      out.limit = parseLimit(raw.slice('--limit='.length));
      continue;
    }
    if (raw === '--summary') {
      out.action = 'summary';
      continue;
    }
    if (raw === '--slow') {
      out.slow = true;
      continue;
    }
    if (raw === '--degraded') {
      out.degraded = true;
      continue;
    }
    if (raw === '--min-ms') {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('missing --min-ms value');
      out.minMs = parseMinMs(value);
      out.slow = true;
      index++;
      continue;
    }
    if (raw.startsWith('--min-ms=')) {
      out.minMs = parseMinMs(raw.slice('--min-ms='.length));
      out.slow = true;
      continue;
    }
    if (raw.startsWith('--request-id=')) {
      const value = raw.slice('--request-id='.length);
      if (value === '') throw new Error('empty --request-id value');
      out.requestId = value;
      continue;
    }
    if (raw.startsWith('--query-sha=')) {
      const value = raw.slice('--query-sha='.length);
      if (value === '') throw new Error('empty --query-sha value');
      out.querySha = value;
      continue;
    }
    if (raw.startsWith('--query-sha256=')) {
      const value = raw.slice('--query-sha256='.length);
      if (value === '') throw new Error('empty --query-sha256 value');
      out.querySha = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }

  if (out.action !== 'show') {
    if (out.requestId !== undefined || out.querySha !== undefined) {
      throw new Error(`${out.action} does not accept --request-id or --query-sha; use \`kb logs show\``);
    }
  } else if ((out.requestId === undefined) === (out.querySha === undefined)) {
    throw new Error('show requires exactly one of --request-id or --query-sha');
  }
  return out;
}

function isLogsFormat(value: string): value is LogsFormat {
  return value === 'md' || value === 'json' || value === 'csv' || value === 'tsv' || value === 'ndjson';
}

export function parseCanonicalLogLines(text: string): ParsedCanonicalLogs {
  const events: CanonicalLogRecord[] = [];
  let ignoredLineCount = 0;
  let malformedCanonicalLineCount = 0;
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!trimmed.includes(`"schema_version":"${CANONICAL_SCHEMA_VERSION}"`) &&
        !trimmed.includes(`"schema_version": "${CANONICAL_SCHEMA_VERSION}"`)) {
      ignoredLineCount++;
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isCanonicalLogRecord(parsed)) {
        events.push(parsed);
      } else {
        ignoredLineCount++;
      }
    } catch {
      malformedCanonicalLineCount++;
    }
  }

  return {
    events,
    scannedLineCount: lines.filter((line) => line.trim() !== '').length,
    ignoredLineCount,
    malformedCanonicalLineCount,
  };
}

function parseLimit(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid --limit: --limit=${raw}`);
  }
  const value = Number(raw);
  if (value < 1 || value > MAX_LIMIT) {
    throw new Error(`--limit must be between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

function parseMinMs(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid --min-ms: --min-ms=${raw}`);
  }
  const value = Number(raw);
  if (value < 1) {
    throw new Error('--min-ms must be at least 1');
  }
  return value;
}

function resolveLogFile(args: LogsArgs, deps: RunLogsDeps): string | null {
  if (args.file !== undefined) {
    return expandPath(args.file, deps);
  }
  if (deps.env.LOG_FILE !== undefined && deps.env.LOG_FILE !== '') {
    return expandPath(deps.env.LOG_FILE, deps);
  }
  for (const candidate of defaultLogPaths(deps)) {
    if (deps.exists(candidate)) return candidate;
  }
  return null;
}

function defaultLogPaths(deps: RunLogsDeps): string[] {
  const stateHome = deps.env.XDG_STATE_HOME && deps.env.XDG_STATE_HOME !== ''
    ? deps.env.XDG_STATE_HOME
    : path.join(deps.homedir(), '.local', 'state');
  return [
    path.join(stateHome, 'knowledge-base-mcp-server', 'knowledge-base.log'),
    path.join(stateHome, 'knowledge-base-mcp-server', 'kb.log'),
    path.join(deps.cwd(), 'logs', 'knowledge-base.log'),
    path.join(deps.cwd(), 'knowledge-base.log'),
  ];
}

function expandPath(filePath: string, deps: RunLogsDeps): string {
  if (filePath === '~') return deps.homedir();
  if (filePath.startsWith('~/')) return path.join(deps.homedir(), filePath.slice(2));
  return path.resolve(deps.cwd(), filePath);
}

function selectEvents(events: CanonicalLogRecord[], args: LogsArgs): CanonicalLogRecord[] {
  if (args.action === 'summary') return [];
  const base = args.action === 'recent'
    ? events
    : args.requestId !== undefined
      ? events.filter((event) => event.request_id === args.requestId)
      : events.filter((event) => event.query_sha256 === args.querySha);
  let filtered = args.slow ? base.filter((event) => matchesSlowFilter(event, args)) : base;
  if (args.degraded) {
    filtered = filtered.filter((event) => event.degraded === true);
  }
  return args.action === 'recent' ? filtered.slice(-args.limit) : filtered;
}

function matchesSlowFilter(event: CanonicalLogRecord, args: LogsArgs): boolean {
  if (args.minMs !== undefined) {
    const tookMs = numberField(event.took_ms);
    return tookMs !== undefined && tookMs >= args.minMs;
  }
  return event.slow === true;
}

function buildLogsPayload(
  args: LogsArgs,
  source: string,
  parsed: ParsedCanonicalLogs,
  events: CanonicalLogRecord[],
): LogsPayload {
  return {
    schema_version: LOGS_SCHEMA_VERSION,
    action: args.action,
    source,
    filters: {
      ...(args.requestId !== undefined ? { request_id: args.requestId } : {}),
      ...(args.querySha !== undefined ? { query_sha256: args.querySha } : {}),
      ...(args.slow ? { slow: true as const } : {}),
      ...(args.degraded ? { degraded: true as const } : {}),
      ...(args.minMs !== undefined ? { min_ms: args.minMs } : {}),
    },
    scanned_line_count: parsed.scannedLineCount,
    canonical_event_count: parsed.events.length,
    ignored_line_count: parsed.ignoredLineCount,
    malformed_canonical_line_count: parsed.malformedCanonicalLineCount,
    slow_event_count: parsed.events.filter((event) => event.slow === true).length,
    degraded_event_count: parsed.events.filter((event) => event.degraded === true).length,
    result_count: events.length,
    events: events.map(summarizeEvent),
    ...(args.action === 'summary'
      ? { summary: aggregateEvents(parsed.events, args.limit) }
      : {}),
  };
}

function formatLogsOutput(payload: LogsPayload, format: LogsFormat): string {
  if (format === 'json') return `${JSON.stringify(payload, null, 2)}\n`;
  if (format === 'md') return formatLogsMarkdown(payload);
  if (payload.summary !== undefined) {
    return renderRecords(logSummaryRows(payload.summary), format, { columns: LOG_SUMMARY_COLUMNS });
  }
  return renderRecords(payload.events.map(logEventRow), format, { columns: LOG_EVENT_COLUMNS });
}

const LOG_EVENT_COLUMNS = [
  'ts',
  'request_id',
  'process',
  'event',
  'cmd',
  'tool',
  'model_id',
  'kb_scope',
  'query_sha256',
  'took_ms',
  'slow',
  'degraded',
  'degraded_stages',
  'result_count',
  'top_score',
  'top_sources',
  'cache',
  'query_cache',
  'error',
  'recovery_hint',
  'timings',
  'gate',
  'rerank',
] as const;

const LOG_SUMMARY_COLUMNS = [
  'total_requests',
  'success',
  'error',
  'latency_count',
  'latency_min_ms',
  'latency_p50_ms',
  'latency_p95_ms',
  'latency_p99_ms',
  'latency_max_ms',
  'by_error_code',
  'by_error_category',
  'slowest',
] as const;

function logEventRow(event: CanonicalLogSummary): Record<string, unknown> {
  return {
    ts: event.ts,
    request_id: event.request_id,
    process: event.process,
    event: event.event,
    cmd: event.cmd,
    tool: event.tool,
    model_id: event.model_id,
    kb_scope: event.kb_scope,
    query_sha256: event.query_sha256,
    took_ms: event.took_ms,
    slow: event.slow,
    degraded: event.degraded,
    degraded_stages: event.degraded_stages,
    result_count: event.result_count,
    top_score: event.top_score,
    top_sources: event.top_sources,
    cache: event.cache,
    query_cache: event.query_cache,
    error: event.error,
    recovery_hint: event.recovery_hint,
    timings: event.timings,
    gate: event.gate,
    rerank: event.rerank,
  };
}

function logSummaryRows(summary: LogsAggregate): Record<string, unknown>[] {
  return [{
    total_requests: summary.total_requests,
    success: summary.outcomes.success,
    error: summary.outcomes.error,
    latency_count: summary.latency_ms?.count ?? null,
    latency_min_ms: summary.latency_ms?.min ?? null,
    latency_p50_ms: summary.latency_ms?.p50 ?? null,
    latency_p95_ms: summary.latency_ms?.p95 ?? null,
    latency_p99_ms: summary.latency_ms?.p99 ?? null,
    latency_max_ms: summary.latency_ms?.max ?? null,
    by_error_code: summary.by_error_code,
    by_error_category: summary.by_error_category,
    slowest: summary.slowest,
  }];
}

function aggregateEvents(events: CanonicalLogRecord[], topN: number): LogsAggregate {
  const byErrorCode: Record<string, number> = {};
  const byErrorCategory: Record<string, number> = {};
  let success = 0;
  let error = 0;
  const latencies: number[] = [];
  const timed: SlowestQuery[] = [];

  for (const event of events) {
    const errInfo = errorInfo(event.error);
    if (errInfo !== undefined) {
      error++;
      byErrorCode[errInfo.code] = (byErrorCode[errInfo.code] ?? 0) + 1;
      byErrorCategory[errInfo.category] = (byErrorCategory[errInfo.category] ?? 0) + 1;
    } else {
      success++;
    }

    const tookMs = numberField(event.took_ms);
    if (tookMs !== undefined) {
      latencies.push(tookMs);
      timed.push({
        ...(stringField(event.request_id) !== undefined ? { request_id: stringField(event.request_id) } : {}),
        ...(stringField(event.query_sha256) !== undefined ? { query_sha256: stringField(event.query_sha256) } : {}),
        took_ms: tookMs,
        ...(stringField(event.ts) !== undefined ? { ts: stringField(event.ts) } : {}),
        ...(stringField(event.cmd ?? event.tool) !== undefined ? { cmd: stringField(event.cmd ?? event.tool) } : {}),
        ...(errInfo !== undefined ? { error_code: errInfo.code } : {}),
      });
    }
  }

  const slowest = timed
    .slice()
    .sort((a, b) => (b.took_ms - a.took_ms) || compareStrings(a.request_id, b.request_id))
    .slice(0, topN);

  return {
    total_requests: events.length,
    outcomes: { success, error },
    by_error_code: sortRecordByCountDesc(byErrorCode),
    by_error_category: sortRecordByCountDesc(byErrorCategory),
    latency_ms: latencyStats(latencies),
    slowest,
  };
}

function latencyStats(values: number[]): LatencyStats | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

// Exact nearest-rank percentile over an ascending-sorted array. Suitable for
// the typical on-disk log sizes this command targets; for very large logs an
// approximate streaming digest would be needed, but exact sort keeps the math
// auditable in tests.
function percentile(sortedAsc: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[index];
}

function errorInfo(error: unknown): { code: string; category: string } | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === 'object') {
    const record = error as { code?: unknown; category?: unknown };
    const code = typeof record.code === 'string' ? record.code : 'ERROR';
    const category = typeof record.category === 'string' ? record.category : 'unknown';
    return { code, category };
  }
  return { code: String(error), category: 'unknown' };
}

function sortRecordByCountDesc(record: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key] of Object.entries(record).sort((a, b) => (b[1] - a[1]) || compareStrings(a[0], b[0]))) {
    out[key] = record[key];
  }
  return out;
}

function compareStrings(a: string | undefined, b: string | undefined): number {
  return (a ?? '').localeCompare(b ?? '');
}

function summarizeEvent(event: CanonicalLogRecord): CanonicalLogSummary {
  return {
    ts: stringField(event.ts),
    request_id: stringField(event.request_id),
    process: stringField(event.process),
    event: stringField(event.event),
    cmd: stringField(event.cmd),
    tool: stringField(event.tool),
    model_id: stringField(event.model_id),
    kb_scope: kbScopeField(event.kb_scope),
    query_sha256: stringField(event.query_sha256),
    took_ms: numberField(event.took_ms),
    slow: trueMarkerField(event.slow),
    degraded: trueMarkerField(event.degraded),
    degraded_stages: degradedStagesField(event.degraded_stages),
    timings: {
      embed_ms: numberField(event.embed_ms),
      faiss_ms: numberField(event.faiss_ms),
      format_ms: numberField(event.format_ms),
    },
    cache: stringField(event.cache),
    query_cache: event.query_cache,
    result_count: numberField(event.result_count),
    top_score: numberField(event.top_score),
    top_sources: stringArrayField(event.top_sources),
    error: event.error,
    recovery_hint: stringField(event.recovery_hint),
    gate: event.gate,
    rerank: extractRerankFields(event),
  };
}

function extractRerankFields(event: CanonicalLogRecord): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key.toLowerCase().includes('rerank')) {
      out[key] = value;
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function formatLogsMarkdown(payload: LogsPayload): string {
  const filterText = payload.filters.request_id !== undefined
    ? `request_id=${payload.filters.request_id}`
    : payload.filters.query_sha256 !== undefined
      ? `query_sha256=${payload.filters.query_sha256}`
      : 'none';
  const lines = [
    '# KB Logs',
    '',
    `- Source: \`${payload.source}\``,
    `- Filter: ${filterText}`,
    `- Scanned lines: ${payload.scanned_line_count}`,
    `- Canonical events: ${payload.canonical_event_count}`,
    `- Ignored lines: ${payload.ignored_line_count}`,
    `- Malformed canonical lines: ${payload.malformed_canonical_line_count}`,
    `- Slow events: ${payload.slow_event_count}`,
    `- Degraded events: ${payload.degraded_event_count}`,
    '',
  ];

  if (payload.summary !== undefined) {
    lines.push(...formatSummaryMarkdown(payload.summary));
    return lines.join('\n');
  }

  if (payload.events.length === 0) {
    lines.push('No matching canonical log events.', '');
    return lines.join('\n');
  }

  lines.push(
    '| Time | Request | Command/tool | Query SHA | Took | Slow | Degraded | Results | Error | Cache |',
    '| --- | --- | --- | --- | ---: | --- | --- | ---: | --- | --- |',
  );
  for (const event of payload.events) {
    lines.push([
      event.ts ?? '',
      code(event.request_id),
      code(event.cmd ?? event.tool ?? event.event ?? event.process ?? ''),
      code(event.query_sha256 ?? ''),
      event.took_ms === undefined ? '' : `${event.took_ms} ms`,
      event.slow === true ? 'yes' : '',
      event.degraded === true ? formatDegradedStages(event.degraded_stages) : '',
      event.result_count === undefined ? '' : String(event.result_count),
      code(formatError(event.error)),
      event.cache ?? '',
    ].map(escapeTableCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push('');
  for (const event of payload.events) {
    lines.push(...formatEventDetails(event));
  }
  return lines.join('\n');
}

function formatSummaryMarkdown(summary: LogsAggregate): string[] {
  const lines = [
    '## Summary',
    '',
    `- Total requests: ${summary.total_requests}`,
    `- Success: ${summary.outcomes.success}`,
    `- Error: ${summary.outcomes.error}`,
    '',
  ];

  const latency = summary.latency_ms;
  lines.push('### Latency (took_ms)', '');
  if (latency === null) {
    lines.push('No timed requests.', '');
  } else {
    lines.push(
      `- Count: ${latency.count}`,
      `- Min: ${latency.min} ms`,
      `- p50: ${latency.p50} ms`,
      `- p95: ${latency.p95} ms`,
      `- p99: ${latency.p99} ms`,
      `- Max: ${latency.max} ms`,
      '',
    );
  }

  lines.push('### By error code', '');
  const errorCodes = Object.entries(summary.by_error_code);
  if (errorCodes.length === 0) {
    lines.push('No errors.', '');
  } else {
    for (const [code_, count] of errorCodes) {
      lines.push(`- ${code(code_)}: ${count}`);
    }
    lines.push('');
  }

  lines.push('### By error category', '');
  const errorCategories = Object.entries(summary.by_error_category);
  if (errorCategories.length === 0) {
    lines.push('No errors.', '');
  } else {
    for (const [category, count] of errorCategories) {
      lines.push(`- ${code(category)}: ${count}`);
    }
    lines.push('');
  }

  lines.push('### Slowest queries', '');
  if (summary.slowest.length === 0) {
    lines.push('No timed requests.', '');
    return lines;
  }
  lines.push(
    '| Took | Request | Query SHA | Command/tool | Error | Time |',
    '| ---: | --- | --- | --- | --- | --- |',
  );
  for (const entry of summary.slowest) {
    lines.push([
      `${entry.took_ms} ms`,
      code(entry.request_id),
      code(entry.query_sha256),
      code(entry.cmd),
      code(entry.error_code),
      entry.ts ?? '',
    ].map(escapeTableCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('');
  return lines;
}

function formatEventDetails(event: CanonicalLogSummary): string[] {
  const title = event.request_id ?? event.ts ?? 'event';
  const lines = [`## ${title}`, ''];
  lines.push(`- Timings: ${formatTimings(event)}`);
  if (event.slow === true) lines.push('- Slow: yes');
  if (event.degraded === true) lines.push(`- Degraded: ${formatDegradedStages(event.degraded_stages)}`);
  if (event.model_id !== undefined) lines.push(`- Model: \`${event.model_id}\``);
  if (event.kb_scope !== undefined) lines.push(`- KB scope: \`${event.kb_scope ?? 'all'}\``);
  if (event.top_sources !== undefined && event.top_sources.length > 0) {
    lines.push(`- Top sources: ${event.top_sources.map(code).join(', ')}`);
  }
  if (event.gate !== undefined) lines.push(`- Gate: \`${compactJson(event.gate)}\``);
  if (event.rerank !== undefined) lines.push(`- Rerank: \`${compactJson(event.rerank)}\``);
  if (event.recovery_hint !== undefined) lines.push(`- Recovery hint: ${event.recovery_hint}`);
  lines.push('');
  return lines;
}

function formatTimings(event: CanonicalLogSummary): string {
  const parts = [
    event.took_ms === undefined ? undefined : `took=${event.took_ms}ms`,
    event.timings.embed_ms === undefined ? undefined : `embed=${event.timings.embed_ms}ms`,
    event.timings.faiss_ms === undefined ? undefined : `faiss=${event.timings.faiss_ms}ms`,
    event.timings.format_ms === undefined ? undefined : `format=${event.timings.format_ms}ms`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? 'unknown' : parts.join(', ');
}

function formatError(error: unknown): string {
  if (error === undefined) return '';
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; category?: unknown };
    const codeText = typeof record.code === 'string' ? record.code : 'ERROR';
    const categoryText = typeof record.category === 'string' ? `/${record.category}` : '';
    return `${codeText}${categoryText}`;
  }
  return String(error);
}

function isCanonicalLogRecord(value: unknown): value is CanonicalLogRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.schema_version === CANONICAL_SCHEMA_VERSION;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function trueMarkerField(value: unknown): true | undefined {
  return value === true ? true : undefined;
}

function kbScopeField(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function degradedStagesField(value: unknown): CanonicalLogSummaryDegradedStage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const stages = value.flatMap((item): CanonicalLogSummaryDegradedStage[] => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.stage !== 'string') return [];
    return [{
      stage: record.stage,
      ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    }];
  });
  return stages.length === 0 ? undefined : stages;
}

function formatDegradedStages(stages: CanonicalLogSummaryDegradedStage[] | undefined): string {
  if (stages === undefined || stages.length === 0) return 'yes';
  return stages
    .map((stage) => stage.reason === undefined ? stage.stage : `${stage.stage}:${stage.reason}`)
    .join(', ');
}

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function code(value: string | undefined): string {
  if (value === undefined || value === '') return '';
  return `\`${value.replace(/`/g, '\\`')}\``;
}

function escapeTableCell(value: string | number): string {
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
