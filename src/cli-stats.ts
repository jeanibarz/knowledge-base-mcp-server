import { resolveActiveModel } from './active-model.js';
import { tryRunDaemonCommand } from './daemon-client.js';
import {
  classifyKbSearchError,
  exitCodeForFailure,
  formatKbSearchFailureJson,
  formatKbSearchFailureStderr,
} from './search-errors-core.js';
import {
  type DelimitedOutputFormat,
  loadManagerForModel,
  loadWithJsonRetry,
  renderRecords,
} from './cli-shared.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import {
  computeKbStats,
  type ComputeKbStatsOptions,
  type KbStatsContextualPrefaceBlock,
  type KbStatsPayload,
} from './kb-stats.js';
import { formatKbStatsOpenMetrics } from './prometheus-export.js';
import { readBuildInfo, type BuildInfo } from './build-info.js';

const CLI_STARTED_AT = Date.now();

export const STATS_HELP = `kb stats — read-only index/corpus stats

Usage:
  kb stats [--kb=<name>] [--format=md|json|csv|tsv|ndjson|openmetrics]

Mirrors the MCP \`kb_stats\` payload for local shell use: per-KB file/chunk/byte
counts, last-indexed time, embedding model, index path, and version context.
Includes filesystem enumeration diagnostics, process-lifetime relevance-gate
counters when the gate has run, and a Contextual Retrieval section with per-KB
preface coverage and failure counts (by error code) when contextual-preface
sidecars exist.
Strictly read-only — does not refresh the index.

Options:
  --kb=<name>           Scope to one knowledge base. Omit for all KBs.
  --format=md|json|csv|tsv|ndjson|openmetrics
                        Output format (default: md). \`json\` emits the
                        underlying \`KbStatsPayload\` shape verbatim; delimited
                        formats emit one row per knowledge base. \`openmetrics\`
                        emits a daemonless Prometheus/OpenMetrics text exposition
                        of the corpus, index, provider, cache, rerank, and
                        relevance-gate families derived from this one-shot run —
                        pipe-clean on stdout for cron scrapers and node-exporter
                        textfile collectors. Daemon-instance gauges (admission
                        control, circuit breaker) are omitted since they are
                        unavailable without a running \`kb serve\` daemon.
  --help, -h            Show this help.

Examples:
  kb stats
  kb stats --kb=work
  kb stats --format=json
  kb stats --format=openmetrics
`;

export interface StatsArgs {
  kb?: string;
  format: 'md' | 'json' | 'openmetrics' | DelimitedOutputFormat;
}

export interface RunStatsDeps {
  bootstrapLayout: () => Promise<void>;
  resolveActiveModel: () => Promise<string>;
  loadManagerForModel: (modelId: string) => Promise<FaissIndexManager>;
  loadWithJsonRetry: (manager: FaissIndexManager) => Promise<void>;
  computeKbStats: (
    manager: FaissIndexManager,
    options: ComputeKbStatsOptions,
  ) => Promise<KbStatsPayload>;
  tryReadDaemonStatsPayload?: () => Promise<KbStatsPayload | null>;
  readBuildInfo: () => BuildInfo;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface RunStatsOptions {
  preferDaemon?: boolean;
}

const DEFAULT_DEPS: RunStatsDeps = {
  bootstrapLayout: () => FaissIndexManager.bootstrapLayout(),
  resolveActiveModel: () => resolveActiveModel(),
  loadManagerForModel,
  loadWithJsonRetry,
  computeKbStats,
  readBuildInfo,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runStats(
  rest: string[],
  deps: RunStatsDeps = DEFAULT_DEPS,
  options: RunStatsOptions = {},
): Promise<number> {
  let parsed: StatsArgs;
  try {
    parsed = parseStatsArgs(rest);
  } catch (err) {
    deps.stderr(`kb stats: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    if (options.preferDaemon !== false) {
      // Keep daemon probing after argument validation so invalid local CLI
      // input still fails locally instead of being hidden by a daemon fallback.
      const readDaemonStats = deps.tryReadDaemonStatsPayload
        ?? (deps === DEFAULT_DEPS ? tryReadDaemonStatsPayload : async () => null);
      const daemonStats = await readDaemonStats();
      if (daemonStats !== null) {
        deps.stdout(formatStatsOutput(daemonStats, parsed.format));
        return 0;
      }
    }

    await deps.bootstrapLayout();
    const activeModelId = await deps.resolveActiveModel();
    const manager = await deps.loadManagerForModel(activeModelId);
    await deps.loadWithJsonRetry(manager);
    const buildInfo = deps.readBuildInfo();
    const payload = await deps.computeKbStats(manager, {
      ...(parsed.kb !== undefined ? { knowledgeBaseName: parsed.kb } : {}),
      serverVersion: buildInfo.version,
      serverCommit: buildInfo.commit,
      startedAt: CLI_STARTED_AT,
    });

    deps.stdout(formatStatsOutput(payload, parsed.format));
    return 0;
  } catch (err) {
    const failure = classifyKbSearchError(err);
    if (parsed.format === 'json') {
      deps.stdout(formatKbSearchFailureJson(failure));
    } else {
      deps.stderr(formatKbSearchFailureStderr(failure).replace(/^kb search:/, 'kb stats:'));
    }
    return exitCodeForFailure(failure);
  }
}

export async function tryReadDaemonStatsPayload(
  options: { timeoutMs?: number } = {},
): Promise<KbStatsPayload | null> {
  try {
    const result = await tryRunDaemonCommand('stats', ['--format=json'], {
      timeoutMs: options.timeoutMs ?? 150,
    });
    if (result === null || result.exitCode !== 0) return null;
    return JSON.parse(result.stdout) as KbStatsPayload;
  } catch {
    return null;
  }
}

export function parseStatsArgs(rest: string[]): StatsArgs {
  const out: StatsArgs = { format: 'md' };
  for (const raw of rest) {
    if (raw.startsWith('--kb=')) {
      const value = raw.slice('--kb='.length);
      if (value === '') throw new Error('empty --kb value');
      out.kb = value;
      continue;
    }
    if (raw.startsWith('--format=')) {
      const value = raw.slice('--format='.length);
      if (!isStatsFormat(value)) {
        throw new Error(`invalid --format: ${raw}`);
      }
      out.format = value;
      continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    throw new Error(`unexpected argument: ${JSON.stringify(raw)}`);
  }
  return out;
}

function isStatsFormat(value: string): value is StatsArgs['format'] {
  return value === 'md' || value === 'json' || value === 'openmetrics'
    || value === 'csv' || value === 'tsv' || value === 'ndjson';
}

function formatStatsOutput(payload: KbStatsPayload, format: StatsArgs['format']): string {
  if (format === 'json') return `${JSON.stringify(payload, null, 2)}\n`;
  if (format === 'md') return formatStatsMarkdown(payload);
  if (format === 'openmetrics') return formatKbStatsOpenMetrics(payload);
  return renderRecords(statsRows(payload), format, { columns: STATS_COLUMNS });
}

const STATS_COLUMNS = [
  'knowledge_base',
  'file_count',
  'chunk_count',
  'total_bytes_indexed',
  'last_updated_at',
  'quarantined',
] as const;

function statsRows(payload: KbStatsPayload): Record<string, unknown>[] {
  return Object.entries(payload.knowledge_bases)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, row]) => ({
      knowledge_base: name,
      file_count: row.file_count,
      chunk_count: row.chunk_count,
      total_bytes_indexed: row.total_bytes_indexed,
      last_updated_at: row.last_updated_at,
      quarantined: payload.quarantined[name] ?? 0,
    }));
}

export function formatStatsMarkdown(payload: KbStatsPayload): string {
  const rows = Object.entries(payload.knowledge_bases)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, row]) => {
      return (
        `| ${escapeTableCell(name)} | ${formatInteger(row.file_count)} | ` +
        `${formatInteger(row.chunk_count)} | ${formatInteger(row.total_bytes_indexed)} | ` +
        `${row.last_updated_at ?? 'never'} |`
      );
    });

  const dim = payload.embedding.dim === null ? 'unknown' : String(payload.embedding.dim);
  const uptimeMs = Math.max(0, Math.round(payload.server.uptime_ms));

  return [
    '# KB Stats',
    '',
    '| Knowledge base | Files | Chunks | Bytes | Last indexed |',
    '| --- | ---: | ---: | ---: | --- |',
    ...rows,
    '',
    '## Index',
    '',
    `- Provider: ${payload.embedding.provider}`,
    `- Model: ${payload.embedding.model}`,
    `- Dimensions: ${dim}`,
    `- Index type: ${payload.embedding.index_type ?? 'flat'}`,
    `- Index factory: ${payload.embedding.index_factory ?? 'Flat'}`,
    `- Index path: \`${payload.index_path}\``,
    `- Server version: ${payload.server.version}`,
    `- Uptime: ${formatInteger(uptimeMs)} ms`,
    '',
    ...formatDenseSearchLatencySection(payload),
    ...formatFilesystemSection(payload),
    ...formatDenseCoverageSection(payload),
    '## Relevance Gate',
    '',
    `- Gated queries: ${formatInteger(payload.relevance_gate.gated_queries)}`,
    `- Verdicts: injected=${formatInteger(payload.relevance_gate.verdict_injected)}, ` +
      `no_relevant_context=${formatInteger(payload.relevance_gate.verdict_no_relevant_context)}, ` +
      `empty_index=${formatInteger(payload.relevance_gate.verdict_empty_index)}`,
    `- Low confidence rate: ${formatRate(payload.relevance_gate.low_confidence_rate)}`,
    `- Drop rates: A1=${formatRate(payload.relevance_gate.drop_rate_A1)}, ` +
      `A2=${formatRate(payload.relevance_gate.drop_rate_A2)}, B=${formatRate(payload.relevance_gate.drop_rate_B)}`,
    `- Judge degrade rate: ${formatRate(payload.relevance_gate.judge_degrade_rate)} ` +
      `(window ${formatInteger(payload.relevance_gate.judge_window.degraded)}/` +
      `${formatInteger(payload.relevance_gate.judge_window.size)}, ` +
      `warn>${formatRate(payload.relevance_gate.judge_window.warn_threshold)})`,
    '',
    ...formatRemoteTransportSection(payload),
    ...formatContextualSection(payload),
  ].join('\n');
}

export function formatDenseSearchLatencySection(payload: KbStatsPayload): string[] {
  const row = payload.dense_search_latency;
  if (row === undefined) return [];
  const lines = [
    '## Dense Search Latency',
    '',
    `- Active index: ${row.active_index.type} (factory ${row.active_index.factory})`,
    `- Dense faiss_search: samples=${formatInteger(row.sample_count)}, ` +
      `p50=${row.p50_ms} ms, p95=${row.p95_ms} ms, threshold=${row.threshold_ms} ms`,
  ];
  if (row.advisory !== null) {
    lines.push(`- Hint: ${row.advisory.message}`);
    lines.push(`- Docs: ${row.advisory.docs.join(', ')}`);
  }
  lines.push('');
  return lines;
}

export function formatFilesystemSection(payload: KbStatsPayload): string[] {
  const diagnostics = payload.filesystem.enumeration_failures;
  if (diagnostics.failure_count === 0) return [];

  const lines = [
    '## Filesystem',
    '',
    `- Enumeration failures: ${formatInteger(diagnostics.failure_count)}`,
  ];
  for (const failure of diagnostics.failures) {
    const code = failure.code === null ? 'unknown' : failure.code;
    lines.push(
      `- ${escapeTableCell(failure.kbName)}: ${failure.path} (${code}) ${failure.message}`,
    );
  }
  lines.push('');
  return lines;
}

export function formatDenseCoverageSection(payload: KbStatsPayload): string[] {
  const emptyDenseShelves = Object.entries(payload.knowledge_bases)
    .filter(([, row]) => row.file_count > 0 && row.chunk_count === 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (emptyDenseShelves.length === 0) return [];

  const lastUpdate = payload.last_index_update;
  const scopedElsewhere =
    (lastUpdate.status === 'success' || lastUpdate.status === 'partial') &&
    lastUpdate.scope !== null &&
    lastUpdate.scope !== 'global' &&
    !emptyDenseShelves.some(([name]) => name === lastUpdate.scope);
  const shelfSummary = emptyDenseShelves
    .map(([name, row]) => `\`${name}\` (${formatInteger(row.file_count)} file${row.file_count === 1 ? '' : 's'})`)
    .join(', ');
  const updateParts = [
    `status=${lastUpdate.status}`,
    `scope=${formatIndexUpdateScope(lastUpdate.scope)}`,
    `chunks_added=${formatInteger(lastUpdate.chunks_added)}`,
    `finished_at=${lastUpdate.finished_at ?? 'never'}`,
  ];

  return [
    '## Dense Coverage',
    '',
    `- Knowledge bases with files but 0 dense chunks: ${shelfSummary}.`,
    `- Last index update: ${updateParts.join(', ')}.`,
    scopedElsewhere
      ? '- Interpretation: the latest refresh was scoped outside these knowledge bases, so this is likely index-scope state rather than missing source files.'
      : '- Interpretation: source files exist on disk, but the active dense index has no chunks for these knowledge bases.',
    '- Next action: refresh a chosen knowledge base with `kb search "known phrase" --kb=<name> --refresh`; omit `--kb` only when you intend a global refresh.',
    '',
  ];
}

export function formatRemoteTransportSection(payload: KbStatsPayload): string[] {
  const stats = payload.remote_transport;
  if (stats === undefined) return [];

  const buckets = stats.response_status_buckets;
  const bucketSummary = [
    `1xx=${formatInteger(buckets['1xx'])}`,
    `2xx=${formatInteger(buckets['2xx'])}`,
    `3xx=${formatInteger(buckets['3xx'])}`,
    `4xx=${formatInteger(buckets['4xx'])}`,
    `5xx=${formatInteger(buckets['5xx'])}`,
  ].join(', ');
  const lastError = stats.last_error === null
    ? 'none'
    : `${stats.last_error.at} ${stats.last_error.message}`;

  return [
    '## Remote Transport',
    '',
    `- Mode: ${stats.transport}`,
    `- Sessions: current=${formatInteger(stats.current_sessions)}, ` +
      `opened=${formatInteger(stats.sessions_opened)}, closed=${formatInteger(stats.sessions_closed)}`,
    `- Requests: total=${formatInteger(stats.requests_total)}, ` +
      `in_flight=${formatInteger(stats.in_flight_requests)}, ${bucketSummary}`,
    `- Auth failures: ${formatInteger(stats.auth_failures)}`,
    `- Origin denials: ${formatInteger(stats.origin_denials)}`,
    `- Last error: ${lastError}`,
    '',
  ];
}

/**
 * #409 — render the per-KB `contextual_preface` block in the markdown
 * surface. The JSON output already carries it; without this section a
 * human running `kb stats` sees no contextual coverage or failure detail
 * at all. KBs that were never reindexed with contextual retrieval are
 * folded into a single line so the common (feature-off) case stays terse.
 */
export function formatContextualSection(payload: KbStatsPayload): string[] {
  const blocks = Object.entries(payload.knowledge_bases)
    .map(([name, row]) => [name, row.contextual_preface] as const)
    .filter((e): e is readonly [string, KbStatsContextualPrefaceBlock] => e[1] !== undefined);
  if (blocks.length === 0) return [];

  const enabled = blocks.some(([, block]) => block.enabled);
  const active = blocks
    .filter(([, block]) => block.reindex_state !== 'never')
    .sort(([a], [b]) => a.localeCompare(b));

  const lines: string[] = [
    '## Contextual Retrieval',
    '',
    `- Feature flag: ${enabled ? 'enabled' : 'disabled'}`,
  ];
  if (active.length === 0) {
    lines.push('- No contextual-preface sidecars on disk yet.', '');
    return lines;
  }
  lines.push(
    '',
    '| Knowledge base | State | Coverage | Covered | Failed | Retry-pending | Top errors |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
  );
  for (const [name, block] of active) {
    const errors = Object.entries(block.failures.by_error_code)
      .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
      .map(([code, count]) => `${code}=${count}`)
      .join(', ');
    lines.push(
      `| ${escapeTableCell(name)} | ${block.reindex_state} | ${block.coverage_pct.toFixed(1)}% | ` +
        `${formatInteger(block.covered_chunks)} | ${formatInteger(block.null_preface_chunks)} | ` +
        `${formatInteger(block.failures.retry_pending)} | ${errors.length > 0 ? errors : '—'} |`,
    );
  }
  lines.push('');
  return lines;
}

function escapeTableCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatIndexUpdateScope(scope: KbStatsPayload['last_index_update']['scope']): string {
  if (scope === null) return 'none';
  return scope === 'global' ? 'global' : `kb:${scope}`;
}
