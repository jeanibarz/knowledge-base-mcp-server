import { existsSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CANONICAL_SCHEMA_VERSION, type CanonicalLogEvent } from './canonical-log.js';

export const LOGS_HELP = `kb logs — inspect historical canonical request logs

Usage:
  kb logs --slow [--min-ms=<n>] [--limit=<n>] [--file=<path>] [--format=md|json]
  kb logs recent [--slow] [--min-ms=<n>] [--limit=<n>] [--file=<path>] [--format=md|json]
  kb logs show --request-id=<id> [--file=<path>] [--format=md|json]
  kb logs show --query-sha=<hash> [--file=<path>] [--format=md|json]

Reads mixed text/canonical log files, keeps only \`kb-canonical.v1\` JSON lines,
and summarizes request ids, query hashes, timings, errors, cache state, gate
fields, rerank fields, top sources, and recovery hints.

Options:
  --file=<path>         Log file to read. Defaults to LOG_FILE, then known
                        local log paths if they exist.
  --format=md|json      Output format (default: md).
  --limit=<n>           Number of recent canonical events to show (default: 20).
  --slow                Show only events marked slow, or events matching
                        --min-ms when that filter is supplied.
  --min-ms=<n>          Minimum took_ms for the slow view; implies --slow.
  --request-id=<id>     Show canonical events for one request id.
  --query-sha=<hash>    Show canonical events for one query_sha256 value.
  --help, -h            Show this help.

Examples:
  kb logs recent
  kb logs --slow
  kb logs recent --slow --min-ms=1000
  kb logs recent --limit=5 --format=json
  kb logs show --request-id=maw6d3qfabcd1234
  kb logs show --query-sha=0123456789abcdef
`;

const LOGS_SCHEMA_VERSION = 'kb.logs.v1';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;

type LogsAction = 'recent' | 'show';
type LogsFormat = 'md' | 'json';

export interface LogsArgs {
  action: LogsAction;
  format: LogsFormat;
  file?: string;
  limit: number;
  slow: boolean;
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
    min_ms?: number;
  };
  scanned_line_count: number;
  canonical_event_count: number;
  ignored_line_count: number;
  malformed_canonical_line_count: number;
  slow_event_count: number;
  result_count: number;
  events: CanonicalLogSummary[];
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
  if (args.format === 'json') {
    deps.stdout(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    deps.stdout(formatLogsMarkdown(payload));
  }
  return 0;
}

export function parseLogsArgs(rest: string[]): LogsArgs {
  if (rest.length === 0) {
    throw new Error('missing action: expected recent or show');
  }
  let action: LogsAction;
  let optionStart = 1;
  if (rest[0] === 'recent' || rest[0] === 'show') {
    action = rest[0];
  } else if (rest[0] === '--slow' || rest[0] === '--min-ms' || rest[0].startsWith('--min-ms=')) {
    action = 'recent';
    optionStart = 0;
  } else {
    throw new Error(`unknown action: ${JSON.stringify(rest[0])}`);
  }

  const out: LogsArgs = { action, format: 'md', limit: DEFAULT_LIMIT, slow: false };
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
      if (value !== 'md' && value !== 'json') {
        throw new Error(`invalid --format: ${raw}`);
      }
      out.format = value;
      continue;
    }
    if (raw.startsWith('--limit=')) {
      out.limit = parseLimit(raw.slice('--limit='.length));
      continue;
    }
    if (raw === '--slow') {
      out.slow = true;
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

  if (out.action === 'recent') {
    if (out.requestId !== undefined || out.querySha !== undefined) {
      throw new Error('recent does not accept --request-id or --query-sha; use `kb logs show`');
    }
  } else if ((out.requestId === undefined) === (out.querySha === undefined)) {
    throw new Error('show requires exactly one of --request-id or --query-sha');
  }
  return out;
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
  const base = args.action === 'recent'
    ? events
    : args.requestId !== undefined
      ? events.filter((event) => event.request_id === args.requestId)
      : events.filter((event) => event.query_sha256 === args.querySha);
  const filtered = args.slow ? base.filter((event) => matchesSlowFilter(event, args)) : base;
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
      ...(args.minMs !== undefined ? { min_ms: args.minMs } : {}),
    },
    scanned_line_count: parsed.scannedLineCount,
    canonical_event_count: parsed.events.length,
    ignored_line_count: parsed.ignoredLineCount,
    malformed_canonical_line_count: parsed.malformedCanonicalLineCount,
    slow_event_count: parsed.events.filter((event) => event.slow === true).length,
    result_count: events.length,
    events: events.map(summarizeEvent),
  };
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
    slow: slowField(event.slow),
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
    '',
  ];

  if (payload.events.length === 0) {
    lines.push('No matching canonical log events.', '');
    return lines.join('\n');
  }

  lines.push(
    '| Time | Request | Command/tool | Query SHA | Took | Slow | Results | Error | Cache |',
    '| --- | --- | --- | --- | ---: | --- | ---: | --- | --- |',
  );
  for (const event of payload.events) {
    lines.push([
      event.ts ?? '',
      code(event.request_id),
      code(event.cmd ?? event.tool ?? event.event ?? event.process ?? ''),
      code(event.query_sha256 ?? ''),
      event.took_ms === undefined ? '' : `${event.took_ms} ms`,
      event.slow === true ? 'yes' : '',
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

function formatEventDetails(event: CanonicalLogSummary): string[] {
  const title = event.request_id ?? event.ts ?? 'event';
  const lines = [`## ${title}`, ''];
  lines.push(`- Timings: ${formatTimings(event)}`);
  if (event.slow === true) lines.push('- Slow: yes');
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

function slowField(value: unknown): true | undefined {
  return value === true ? true : undefined;
}

function kbScopeField(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
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
