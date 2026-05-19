import { readFileSync, realpathSync } from 'fs';
import * as path from 'path';
import { resolveActiveModel } from './active-model.js';
import {
  classifyKbSearchError,
  exitCodeForFailure,
  formatKbSearchFailureJson,
  formatKbSearchFailureStderr,
} from './search-errors-core.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';
import { FaissIndexManager } from './FaissIndexManager.js';
import {
  computeKbStats,
  type ComputeKbStatsOptions,
  type KbStatsContextualPrefaceBlock,
  type KbStatsPayload,
} from './kb-stats.js';

const CLI_STARTED_AT = Date.now();

export const STATS_HELP = `kb stats — read-only index/corpus stats

Usage:
  kb stats [--kb=<name>] [--format=md|json]

Mirrors the MCP \`kb_stats\` payload for local shell use: per-KB file/chunk/byte
counts, last-indexed time, embedding model, index path, and version context.
Includes process-lifetime relevance-gate counters when the gate has run, and a
Contextual Retrieval section with per-KB preface coverage and failure counts
(by error code) when contextual-preface sidecars exist.
Strictly read-only — does not refresh the index.

Options:
  --kb=<name>           Scope to one knowledge base. Omit for all KBs.
  --format=md|json      Output format (default: md). \`json\` emits the
                        underlying \`KbStatsPayload\` shape verbatim.
  --help, -h            Show this help.

Examples:
  kb stats
  kb stats --kb=work
  kb stats --format=json
`;

export interface StatsArgs {
  kb?: string;
  format: 'md' | 'json';
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
  readPackageVersion: () => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const DEFAULT_DEPS: RunStatsDeps = {
  bootstrapLayout: () => FaissIndexManager.bootstrapLayout(),
  resolveActiveModel: () => resolveActiveModel(),
  loadManagerForModel,
  loadWithJsonRetry,
  computeKbStats,
  readPackageVersion,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runStats(rest: string[], deps: RunStatsDeps = DEFAULT_DEPS): Promise<number> {
  let parsed: StatsArgs;
  try {
    parsed = parseStatsArgs(rest);
  } catch (err) {
    deps.stderr(`kb stats: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    await deps.bootstrapLayout();
    const activeModelId = await deps.resolveActiveModel();
    const manager = await deps.loadManagerForModel(activeModelId);
    await deps.loadWithJsonRetry(manager);
    const payload = await deps.computeKbStats(manager, {
      ...(parsed.kb !== undefined ? { knowledgeBaseName: parsed.kb } : {}),
      serverVersion: deps.readPackageVersion(),
      startedAt: CLI_STARTED_AT,
    });

    if (parsed.format === 'json') {
      deps.stdout(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      deps.stdout(formatStatsMarkdown(payload));
    }
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
      if (value !== 'md' && value !== 'json') {
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
    `- Index path: \`${payload.index_path}\``,
    `- Server version: ${payload.server.version}`,
    `- Uptime: ${formatInteger(uptimeMs)} ms`,
    '',
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
    ...formatContextualSection(payload),
  ].join('\n');
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

function readPackageVersion(): string {
  try {
    const here = realpathSync(process.argv[1] ?? path.join(process.cwd(), 'build', 'cli.js'));
    const pkgPath = path.join(path.dirname(here), '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
