import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  FaissIndexManager,
  type IndexUpdateProgress,
  MAX_NEIGHBOR_CONTEXT_WINDOW,
  type NeighborContextOptions,
  type SearchResultDocument,
  type SimilaritySearchTiming,
} from './FaissIndexManager.js';
import {
  resolveActiveModel,
  resolveFaissIndexBinaryPath,
} from './active-model.js';
import {
  classifyKbSearchError,
  exitCodeForFailure,
  formatKbSearchFailureJson,
  formatKbSearchFailureStderr,
  type SearchFailure,
} from './cli-search-errors.js';
import {
  FRONTMATTER_EXTRAS_WIRE_VISIBLE,
  KB_EDITOR_URI,
  KNOWLEDGE_BASES_ROOT_DIR,
} from './config.js';
import {
  formatRetrievalAsJson,
  formatRetrievalAsMarkdown,
  formatRetrievalAsVimgrep,
  formatRetrievalEmptyAsMarkdown,
  formatRetrievalGroupedBySourceAsMarkdown,
  groupRetrievalBySource,
  type ScoredDocument,
} from './formatter.js';
import { runPicker } from './cli-search-picker.js';
import { enumerateIngestableKbFiles, listKnowledgeBases } from './kb-fs.js';
import { mapBounded, resolveFsConcurrency } from './bounded-concurrency.js';
import { withWriteLock } from './write-lock.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';
import { readFreshnessManifest } from './freshness-manifest.js';
import {
  compactTimingPayload,
  elapsedMs,
  formatTimingFooter,
  nowMs,
  recordFreshnessScanTiming,
  recordRefreshProgressTiming,
  type FreshnessScanSource,
  type FreshnessScanScope,
  type TimingPayload,
} from './cli-timing.js';
import { LexicalIndex, type LexicalSearchResult } from './lexical-index.js';
import {
  HYBRID_RRF_C,
  fuseHybridResults,
  hybridFetchK,
  listLexicalKbs,
  runLexicalLeg,
  type HybridChunk,
} from './hybrid-retrieval.js';
import {
  buildEmptyResultGuidance,
  buildRefreshPreflightEstimate,
  maybeWriteRefreshPreflight,
  type EmptyResultGuidance,
} from './cli-search-staleness.js';

export const SEARCH_HELP = `kb search — semantic search across knowledge bases

Usage:
  kb search <query> [options]
  kb search --stdin [options]
  kb search <query> --refresh [options]

Default is dense (FAISS) similarity search, read-only. \`--refresh\` re-scans
KB files under a per-model write lock before searching. \`--mode=lexical\`
runs a BM25 debug surface; \`--mode=hybrid\` fuses dense + lexical via RRF.
\`--mode=auto\` currently keeps dense for prose queries and chooses hybrid for
code/path/error-token-shaped queries.

Output normally ends with a freshness footer (markdown) or staleness fields
(JSON) indicating whether the index is up-to-date relative to KB file mtimes.

Scope:
  --kb=<name>           Scope to one knowledge base. Omit to search ALL KBs.
  --model=<id>          Override the active model for this call (RFC 013).

Result tuning:
  --threshold=<float>   Max similarity score; lower = closer match (default 2).
  --threshold=auto      Pick a knee-based cutoff from the top-K score curve.
  --k=<int>             Top-K results (default 10).
  --mode=dense|lexical|hybrid|auto
                        Retrieval mode (default: dense). \`hybrid\` fuses
                        dense + BM25 via reciprocal rank fusion (#206).
  --context-before=<n>  Include up to n preceding chunks from the same source
                        around each dense semantic match (0-${MAX_NEIGHBOR_CONTEXT_WINDOW}).
  --context-after=<n>   Include up to n following chunks from the same source
                        around each dense semantic match (0-${MAX_NEIGHBOR_CONTEXT_WINDOW}).
  --context-window=<n>  Shorthand for --context-before=n --context-after=n.
  --no-cache            Bypass the query-embedding cache for this search.

Output:
  --format=md|json|vimgrep
                        Output format (default: md). vimgrep prints
                        path:line:col:preview for editor quickfix flows.
  --group-by-source     Collapse repeated chunks from the same source file
                        in markdown output. With \`--format=json\`, adds a
                        \`grouped_results\` field alongside raw results.
  --timing              Include elapsed milliseconds for retrieval stages.
  --no-freshness        Skip the staleness scan and omit freshness output.
  --explain-empty       Opt-in deep diagnostics for empty results: pre/post
                        filter candidate counts, per-filter drops, scope,
                        index freshness, and the nearest non-matching
                        candidates. Has no effect when results are non-empty.

Indexing:
  --refresh             Re-scan KB files; acquires the per-model write lock.
                        If the stale delta is larger than 100 files or
                        100 MiB, prints a nonblocking refresh preflight to
                        stderr before embedding starts.

Input:
  --stdin               Read query from stdin (multi-line safe).
  -i, --interactive     Open an interactive results picker (TTY only; ignored
                        when --format=json or --format=vimgrep is set).
  --help, -h            Show this help.

Examples:
  kb search "rollback procedure"
  kb search "deploy" --kb=work --k=5
  kb search "INDEX_NOT_INITIALIZED" --mode=lexical --refresh
  kb search "INDEX_NOT_INITIALIZED" --mode=hybrid
  kb search "src/cli.ts" --mode=auto --timing
  kb search --stdin --format=json < query.txt
`;

export type SearchMode = 'dense' | 'lexical' | 'hybrid' | 'auto';
export type EffectiveSearchMode = Exclude<SearchMode, 'auto'>;
type SearchFormat = 'md' | 'json' | 'vimgrep';

interface SearchArgs {
  query: string | null;
  kb?: string;
  model?: string;
  threshold?: number;
  thresholdAuto: boolean;
  k: number;
  format: SearchFormat;
  refresh: boolean;
  stdin: boolean;
  groupBySource: boolean;
  mode: SearchMode;
  timing: boolean;
  interactive: boolean;
  noCache: boolean;
  freshness: boolean;
  explainEmpty: boolean;
  neighborContext?: NeighborContextOptions;
}

export interface RunSearchDeps {
  bootstrapLayout: typeof FaissIndexManager.bootstrapLayout;
  resolveActiveModel: typeof resolveActiveModel;
  loadManagerForModel: typeof loadManagerForModel;
  loadWithJsonRetry: typeof loadWithJsonRetry;
}

const DEFAULT_RUN_SEARCH_DEPS: RunSearchDeps = {
  bootstrapLayout: FaissIndexManager.bootstrapLayout,
  resolveActiveModel,
  loadManagerForModel,
  loadWithJsonRetry,
};

export interface Staleness {
  indexMtime: string | null;
  modifiedFiles: number;
  newFiles: number;
  scope?: StalenessScope;
  global?: StalenessCounts;
  scan?: StalenessScanStats;
}

export interface StalenessCounts {
  modifiedFiles: number;
  newFiles: number;
}

export interface StalenessScope extends StalenessCounts {
  kb: string;
}

export interface StalenessScanStats {
  scope: FreshnessScanScope;
  source: FreshnessScanSource;
  filesScanned: number;
  globalFiles: number;
  scopedFiles?: number;
  kbsScanned: number;
}

export interface AutoThresholdDecision {
  threshold: number;
  kneeIndex: number | null;
  kept: number;
}

export interface AutoSearchModeDecision {
  mode: EffectiveSearchMode;
  reason: string;
}

export async function runSearch(
  rest: string[],
  deps: RunSearchDeps = DEFAULT_RUN_SEARCH_DEPS,
): Promise<number> {
  const totalStartedAt = nowMs();
  let parsed: SearchArgs;
  try {
    parsed = parseSearchArgs(rest);
  } catch (err) {
    process.stderr.write(`kb search: ${(err as Error).message}\n`);
    return 2;
  }

  if (parsed.stdin && parsed.query === null) {
    parsed.query = await readAllStdin();
    if (parsed.query.trim() === '') {
      process.stderr.write('kb search: empty query from stdin\n');
      return 2;
    }
  } else if (parsed.query === null) {
    process.stderr.write('kb search: missing <query> (or use --stdin)\n');
    return 2;
  }

  if (shouldUsePicker(parsed) && !process.stdout.isTTY) {
    process.stderr.write('kb search: --interactive requires a TTY\n');
    return 2;
  }

  const autoModeDecision = parsed.mode === 'auto'
    ? resolveAutoSearchMode(parsed.query)
    : null;
  const effectiveMode: EffectiveSearchMode = autoModeDecision
    ? autoModeDecision.mode
    : (parsed.mode as EffectiveSearchMode);
  const timing: TimingPayload | null = parsed.timing
    ? {
        requested_mode: parsed.mode,
        effective_mode: effectiveMode,
      }
    : null;
  const effectiveParsed: SearchArgs = { ...parsed, mode: effectiveMode };
  if (hasNeighborContext(parsed) && effectiveMode !== 'dense') {
    process.stderr.write('kb search: neighbor context expansion is only supported with --mode=dense\n');
    return 2;
  }

  if (parsed.explainEmpty && effectiveMode !== 'dense') {
    process.stderr.write(
      `kb search: --explain-empty is dense-only; ignored under --mode=${effectiveMode}\n`,
    );
  }

  if (effectiveMode === 'lexical') {
    return runLexicalSearch(effectiveParsed, timing, totalStartedAt, autoModeDecision);
  }
  if (effectiveMode === 'hybrid') {
    return runHybridSearch(effectiveParsed, timing, totalStartedAt, autoModeDecision);
  }

  try {
    const startedAt = nowMs();
    await deps.bootstrapLayout();
    if (timing) timing.bootstrap_ms = elapsedMs(startedAt);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  let activeModelId: string;
  try {
    const startedAt = nowMs();
    activeModelId = await deps.resolveActiveModel({ explicitOverride: parsed.model });
    if (timing) timing.model_resolution_ms = elapsedMs(startedAt);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  let manager: FaissIndexManager;
  try {
    const startedAt = nowMs();
    manager = await deps.loadManagerForModel(activeModelId);
    if (timing) timing.manager_load_ms = elapsedMs(startedAt);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  try {
    const startedAt = nowMs();
    if (parsed.refresh) {
      await withWriteLock(manager.modelDir, async () => {
        await printRefreshPreflightIfLarge(activeModelId, manager, parsed.kb, parsed.format);
        await manager.initialize();
        await manager.updateIndex(parsed.kb, {
          onProgress: createRefreshProgressReporter(timing),
        });
      });
    } else {
      await deps.loadWithJsonRetry(manager);
    }
    if (timing) timing.index_load_ms = elapsedMs(startedAt);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  let results;
  let autoThresholdDecision: AutoThresholdDecision | null = null;
  const denseTiming: SimilaritySearchTiming = {};
  try {
    const startedAt = nowMs();
    if (parsed.thresholdAuto) {
      const rawResults = await manager.similaritySearch(
        parsed.query,
        parsed.k,
        Number.POSITIVE_INFINITY,
        parsed.kb,
        undefined,
        denseTiming,
        { noCache: parsed.noCache },
      );
      autoThresholdDecision = computeAutoThreshold(rawResults.map((r) => r.score));
      results = rawResults.slice(0, autoThresholdDecision.kept);
    } else {
      results = await manager.similaritySearch(
        parsed.query,
        parsed.k,
        parsed.threshold,
        parsed.kb,
        undefined,
        denseTiming,
        { noCache: parsed.noCache },
      );
    }
    if (parsed.neighborContext) {
      results = manager.expandWithNeighborContext(results, parsed.neighborContext);
    }
    if (timing) {
      timing.dense_search_ms = elapsedMs(startedAt);
      mergeDenseTiming(timing, denseTiming);
    }
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  const staleness = parsed.freshness
    ? await computeStalenessWithTiming(activeModelId, parsed.kb, timing)
    : null;

  const explainEmptyDiagnostics =
    parsed.explainEmpty && results.length === 0
      ? await gatherExplainEmptyDiagnostics({
          manager,
          query: parsed.query ?? '',
          threshold: parsed.thresholdAuto
            ? Number.POSITIVE_INFINITY
            : parsed.threshold ?? 2,
          scopedKb: parsed.kb,
          noCache: parsed.noCache,
          staleness,
        })
      : null;

  if (timing) timing.total_ms = elapsedMs(totalStartedAt);

  if (shouldUsePicker(parsed)) {
    return runPicker({ results: results as ScoredDocument[] });
  }

  if (parsed.format === 'json') {
    const payload = buildDenseSearchJsonPayload({
      results,
      requestedMode: parsed.mode,
      effectiveMode,
      autoModeDecision,
      groupBySource: parsed.groupBySource,
      refreshed: parsed.refresh,
      scopedKb: parsed.kb,
      query: parsed.query ?? undefined,
      staleness,
      autoThresholdDecision,
      timing,
      explainEmptyDiagnostics,
    });
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (parsed.format === 'vimgrep') {
    const out = formatRetrievalAsVimgrep(results);
    if (out !== '') process.stdout.write(`${out}\n`);
  } else {
    process.stdout.write(formatDenseSearchMarkdownOutput({
      results,
      groupBySource: parsed.groupBySource,
      staleness,
      refreshed: parsed.refresh,
      scopedKb: parsed.kb,
      query: parsed.query ?? undefined,
      autoModeDecision,
      autoThresholdDecision,
      timing,
      explainEmptyDiagnostics,
    }));
  }

  return 0;
}

/**
 * Issue #328 — gather inputs for `buildExplainEmptyDiagnostics`. Runs a
 * single FAISS top-K probe with `threshold=+Inf` and **no** KB scope so the
 * raw candidates can be locally classified into kb_scope/threshold/none
 * drops. We do not re-run the staleness scan; we consume whatever the main
 * search path already computed.
 *
 * Errors in either step degrade gracefully to empty inputs so diagnostics
 * never abort a search that otherwise succeeded.
 */
async function gatherExplainEmptyDiagnostics(input: {
  manager: FaissIndexManager;
  query: string;
  threshold: number;
  scopedKb: string | undefined;
  noCache: boolean;
  staleness: Staleness | null;
}): Promise<ExplainEmptyDiagnostics> {
  const rawCandidates = await fetchExplainEmptyRawCandidates(input);
  const allKbs = await listAvailableKbsForDiagnostics();
  return buildExplainEmptyDiagnostics({
    rawCandidates,
    threshold: input.threshold,
    scopedKb: input.scopedKb,
    allKbs,
    staleness: input.staleness,
    kbRoot: KNOWLEDGE_BASES_ROOT_DIR,
  });
}

async function fetchExplainEmptyRawCandidates(input: {
  manager: FaissIndexManager;
  query: string;
  noCache: boolean;
}): Promise<SearchResultDocument[]> {
  if (input.query === '') return [];
  try {
    return await input.manager.similaritySearch(
      input.query,
      EXPLAIN_EMPTY_PROBE_K,
      Number.POSITIVE_INFINITY,
      undefined,
      undefined,
      undefined,
      { noCache: input.noCache },
    );
  } catch {
    return [];
  }
}

async function listAvailableKbsForDiagnostics(): Promise<string[]> {
  try {
    return await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  } catch {
    return [];
  }
}

const EXPLAIN_EMPTY_PROBE_K = 10;

export function parseSearchArgs(rest: string[]): SearchArgs {
  const out: SearchArgs = {
    query: null,
    k: 10,
    format: 'md',
    refresh: false,
    stdin: false,
    thresholdAuto: false,
    groupBySource: false,
    mode: 'dense',
    timing: false,
    interactive: false,
    noCache: false,
    freshness: true,
    explainEmpty: false,
  };
  for (const raw of rest) {
    if (raw === '--refresh') { out.refresh = true; continue; }
    if (raw === '--stdin')   { out.stdin = true; continue; }
    if (raw === '--group-by-source') { out.groupBySource = true; continue; }
    if (raw === '--timing') { out.timing = true; continue; }
    if (raw === '--no-cache') { out.noCache = true; continue; }
    if (raw === '--no-freshness') { out.freshness = false; continue; }
    if (raw === '--explain-empty') { out.explainEmpty = true; continue; }
    if (raw === '--interactive' || raw === '-i') { out.interactive = true; continue; }
    if (raw.startsWith('--context-before=')) {
      out.neighborContext = {
        ...out.neighborContext,
        before: parseNeighborContextCount(raw, '--context-before='),
      };
      continue;
    }
    if (raw.startsWith('--context-after=')) {
      out.neighborContext = {
        ...out.neighborContext,
        after: parseNeighborContextCount(raw, '--context-after='),
      };
      continue;
    }
    if (raw.startsWith('--context-window=')) {
      const count = parseNeighborContextCount(raw, '--context-window=');
      out.neighborContext = { ...out.neighborContext, before: count, after: count };
      continue;
    }
    if (raw.startsWith('--kb=')) { out.kb = raw.slice('--kb='.length); continue; }
    if (raw.startsWith('--model=')) { out.model = raw.slice('--model='.length); continue; }
    if (raw.startsWith('--mode=')) {
      const v = raw.slice('--mode='.length);
      if (v !== 'dense' && v !== 'lexical' && v !== 'hybrid' && v !== 'auto') {
        throw new Error(`invalid --mode: ${raw} (expected 'dense', 'lexical', 'hybrid', or 'auto')`);
      }
      out.mode = v; continue;
    }
    if (raw.startsWith('--threshold=')) {
      const v = raw.slice('--threshold='.length);
      if (v === 'auto') { out.thresholdAuto = true; continue; }
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`invalid --threshold: ${raw}`);
      out.threshold = n; continue;
    }
    if (raw.startsWith('--k=')) {
      const n = Number(raw.slice('--k='.length));
      if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --k: ${raw}`);
      out.k = n; continue;
    }
    if (raw.startsWith('--format=')) {
      const v = raw.slice('--format='.length);
      if (v !== 'md' && v !== 'json' && v !== 'vimgrep') throw new Error(`invalid --format: ${raw}`);
      out.format = v; continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    if (out.query === null) { out.query = raw; continue; }
    throw new Error(`unexpected argument: ${raw}`);
  }
  return out;
}

function parseNeighborContextCount(raw: string, prefix: string): number {
  const n = Number(raw.slice(prefix.length));
  if (!Number.isInteger(n) || n < 0 || n > MAX_NEIGHBOR_CONTEXT_WINDOW) {
    throw new Error(`invalid ${prefix.slice(0, -1)}: ${raw} (expected integer 0-${MAX_NEIGHBOR_CONTEXT_WINDOW})`);
  }
  return n;
}

function hasNeighborContext(parsed: SearchArgs): boolean {
  const before = parsed.neighborContext?.before ?? 0;
  const after = parsed.neighborContext?.after ?? 0;
  return before > 0 || after > 0;
}

/**
 * `--interactive` opens a TTY picker, but only for human-readable output.
 * `--format=json` and `--format=vimgrep` are structured surfaces consumed by
 * agents and editors; if both `-i` and one of those formats are passed, the
 * format wins so agent shells that pass both stay deterministic (#215).
 */
export function shouldUsePicker(parsed: { interactive: boolean; format: 'md' | 'json' | 'vimgrep' }): boolean {
  if (!parsed.interactive) return false;
  if (parsed.format === 'json' || parsed.format === 'vimgrep') return false;
  return true;
}

export function resolveAutoSearchMode(query: string): AutoSearchModeDecision {
  const trimmed = query.trim();
  const hybridMatchers: Array<[RegExp, string]> = [
    [/(^|[\s`'"])-{1,2}[A-Za-z0-9][\w-]*/, 'CLI flag token'],
    [/\b[A-Z0-9]+_[A-Z0-9_]+\b/, 'constant or error-code token'],
    [/\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|go|rs|java|cpp|c|h|yaml|yml|toml|lock)\b/i, 'file-like token'],
    [/[./\\][A-Za-z0-9_.-]+/, 'path-like token'],
    [/\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b/, 'identifier-like token'],
    [/\b[A-Za-z_][A-Za-z0-9_]*\([^)]*\)/, 'function-call-like token'],
    [/\b(?:PR|issue)\s*#?\d+\b/i, 'issue or PR reference'],
    [/#\d+\b/, 'numbered reference'],
  ];

  for (const [pattern, reason] of hybridMatchers) {
    if (pattern.test(trimmed)) return { mode: 'hybrid', reason };
  }
  return { mode: 'dense', reason: 'prose query' };
}

export function formatAutoModeHeader(decision: AutoSearchModeDecision): string {
  return `> _Mode: auto -> ${decision.mode} (${decision.reason})._`;
}

export function createRefreshProgressReporter(
  timing: TimingPayload | null,
  writeStderr: (line: string) => void = (line) => process.stderr.write(line),
): (progress: IndexUpdateProgress) => void {
  return (progress) => {
    if (timing) recordRefreshProgressTiming(timing, progress);
    const line = formatRefreshProgressLine(progress);
    if (line !== null) writeStderr(`${line}\n`);
  };
}

export function formatRefreshProgressLine(progress: IndexUpdateProgress): string | null {
  const elapsed = formatElapsed(progress.elapsedMs);
  if (progress.phase === 'embed') {
    const batch = progress.batchIndex !== undefined && progress.batchCount !== undefined
      ? ` batch ${progress.batchIndex}/${progress.batchCount}`
      : '';
    const chunks = progress.processedChunks !== undefined && progress.totalChunks !== undefined
      ? `, ${progress.processedChunks}/${progress.totalChunks} chunks`
      : '';
    const rate = progress.throughputChunksPerSecond !== undefined
      ? `, ${formatRate(progress.throughputChunksPerSecond)} chunks/s`
      : '';
    return `kb search refresh: embed${batch}${chunks}${rate}${formatModel(progress)}${elapsed}`;
  }
  if (progress.phase === 'save') {
    const status = progress.phaseStatus === 'completed' ? 'completed' : 'started';
    return `kb search refresh: save ${status}${elapsed}`;
  }
  if (progress.phase === 'sidecar') {
    const status = progress.phaseStatus === 'completed' ? 'completed' : 'started';
    const count = progress.sidecarsWritten !== undefined
      ? ` (${progress.sidecarsWritten} hash sidecar${progress.sidecarsWritten === 1 ? '' : 's'})`
      : '';
    return `kb search refresh: sidecar ${status}${count}${elapsed}`;
  }
  if (progress.phase === 'manifest') {
    return `kb search refresh: manifest ${progress.phaseStatus ?? 'progress'}${elapsed}`;
  }
  if (progress.phase === 'scan') {
    const files = progress.filesScanned !== undefined
      ? `${progress.filesScanned}/${progress.totalFiles} files`
      : `${progress.processedFiles}/${progress.totalFiles} files`;
    return `kb search refresh: scan ${files}${elapsed}`;
  }
  if (progress.phase === 'load') {
    const files = progress.filesScanned !== undefined
      ? `${progress.filesScanned}/${progress.totalFiles} files`
      : `${progress.processedFiles}/${progress.totalFiles} files`;
    const chunks = progress.chunksDiscovered !== undefined
      ? `, ${progress.chunksDiscovered} chunks discovered`
      : '';
    return `kb search refresh: load ${files}${chunks}${elapsed}`;
  }
  return null;
}

function formatModel(progress: IndexUpdateProgress): string {
  if (!progress.provider || !progress.modelName) return '';
  return `, model=${progress.provider}/${progress.modelName}`;
}

function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `, elapsed=${Math.round(ms)}ms`;
  return `, elapsed=${(ms / 1000).toFixed(1)}s`;
}

function formatRate(value: number): string {
  if (value >= 10) return value.toFixed(0);
  return value.toFixed(1);
}

function mergeDenseTiming(target: TimingPayload, source: SimilaritySearchTiming): void {
  if (source.embed_query_ms !== undefined) target.embed_query_ms = source.embed_query_ms;
  if (source.faiss_search_ms !== undefined) target.faiss_search_ms = source.faiss_search_ms;
  if (source.query_search_ms !== undefined) target.query_search_ms = source.query_search_ms;
  if (source.post_filter_ms !== undefined) target.post_filter_ms = source.post_filter_ms;
  if (source.total_ms !== undefined) target.dense_total_ms = source.total_ms;
  if (source.fetch_k !== undefined) target.fetch_k = source.fetch_k;
  if (source.query_cache !== undefined) target.query_cache = source.query_cache;
}

export async function computeStaleness(modelId: string, scopedKb?: string): Promise<Staleness> {
  const binaryPath = await resolveFaissIndexBinaryPath(modelId);
  if (binaryPath === null) {
    return emptyStaleness(null, scopedKb);
  }
  let indexStat;
  try {
    indexStat = await fsp.stat(binaryPath);
  } catch {
    return emptyStaleness(null, scopedKb);
  }
  const indexMtimeMs = indexStat.mtimeMs;
  const indexMtime = new Date(indexMtimeMs).toISOString();
  const manifest = await readFreshnessManifest({
    modelId,
    modelDir: path.dirname(path.dirname(binaryPath)),
    indexMtimeMs,
  });
  if (manifest !== null) {
    const fromManifest = stalenessFromManifest(manifest, indexMtime, scopedKb);
    if (fromManifest !== null) return fromManifest;
  }

  let kbs: string[];
  try {
    kbs = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  } catch {
    return emptyStaleness(indexMtime, scopedKb);
  }

  const enumerations = await enumerateIngestableKbFiles(KNOWLEDGE_BASES_ROOT_DIR, kbs);
  const global = await countStaleness(enumerations, indexMtimeMs);
  const globalFiles = countEnumeratedFiles(enumerations);
  if (!scopedKb) {
    return {
      indexMtime,
      modifiedFiles: global.modifiedFiles,
      newFiles: global.newFiles,
      scan: buildStalenessScanStats({
        scopedKb,
        source: 'filesystem',
        globalFiles,
        scopedFiles: undefined,
        kbsScanned: enumerations.length,
      }),
    };
  }

  const scopedEnumeration = enumerations.filter((entry) => entry.kbName === scopedKb);
  const scopeCounts = await countStaleness(scopedEnumeration, indexMtimeMs);
  const scopedFiles = countEnumeratedFiles(scopedEnumeration);
  return {
    indexMtime,
    modifiedFiles: scopeCounts.modifiedFiles,
    newFiles: scopeCounts.newFiles,
    scope: { kb: scopedKb, ...scopeCounts },
    global,
    scan: buildStalenessScanStats({
      scopedKb,
      source: 'filesystem',
      globalFiles,
      scopedFiles,
      kbsScanned: enumerations.length,
    }),
  };
}

function countEnumeratedFiles(
  enumerations: Awaited<ReturnType<typeof enumerateIngestableKbFiles>>,
): number {
  return enumerations.reduce((sum, entry) => sum + entry.filePaths.length, 0);
}

async function countStaleness(
  enumerations: Awaited<ReturnType<typeof enumerateIngestableKbFiles>>,
  indexMtimeMs: number,
): Promise<StalenessCounts> {
  const fsConcurrency = resolveFsConcurrency();
  let modifiedFiles = 0;
  let newFiles = 0;
  for (const { kbPath, filePaths } of enumerations) {
    const modifiedFlags = await mapBounded(filePaths, fsConcurrency, async (filePath): Promise<number> => {
      try {
        const st = await fsp.stat(filePath);
        return st.mtimeMs > indexMtimeMs ? 1 : 0;
      } catch {
        // file vanished between the walker and stat; ignore it
        return 0;
      }
    });
    modifiedFiles += modifiedFlags.reduce((sum, value) => sum + value, 0);

    const sidecarCount = await countSidecarFiles(path.join(kbPath, '.index'));
    if (filePaths.length > sidecarCount) {
      newFiles += filePaths.length - sidecarCount;
    }
  }
  return { modifiedFiles, newFiles };
}

async function countSidecarFiles(dir: string): Promise<number> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const childCounts = await mapBounded(entries, resolveFsConcurrency(), async (entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return countSidecarFiles(entryPath);
    }
    if (entry.isFile()) {
      return 1;
    }
    return 0;
  });
  return childCounts.reduce((sum, value) => sum + value, 0);
}

function emptyStaleness(indexMtime: string | null, scopedKb?: string): Staleness {
  const scan = buildStalenessScanStats({
    scopedKb,
    source: 'none',
    globalFiles: 0,
    scopedFiles: scopedKb ? 0 : undefined,
    kbsScanned: 0,
  });
  if (!scopedKb) return { indexMtime, modifiedFiles: 0, newFiles: 0, scan };
  return {
    indexMtime,
    modifiedFiles: 0,
    newFiles: 0,
    scope: { kb: scopedKb, modifiedFiles: 0, newFiles: 0 },
    global: { modifiedFiles: 0, newFiles: 0 },
    scan,
  };
}

function stalenessFromManifest(
  manifest: Awaited<ReturnType<typeof readFreshnessManifest>>,
  indexMtime: string,
  scopedKb?: string,
): Staleness | null {
  if (manifest === null) return null;
  const global = Object.values(manifest.kbs).reduce<StalenessCounts>(
    (counts, entry) => ({
      modifiedFiles: counts.modifiedFiles + entry.modified_files,
      newFiles: counts.newFiles + entry.new_files,
    }),
    { modifiedFiles: 0, newFiles: 0 },
  );
  if (!scopedKb) {
    const globalFiles = Object.values(manifest.kbs)
      .reduce((sum, entry) => sum + entry.file_count, 0);
    return {
      indexMtime,
      modifiedFiles: global.modifiedFiles,
      newFiles: global.newFiles,
      scan: buildStalenessScanStats({
        scopedKb,
        source: 'manifest',
        globalFiles,
        scopedFiles: undefined,
        kbsScanned: Object.keys(manifest.kbs).length,
      }),
    };
  }
  const scopedEntry = manifest.kbs[scopedKb];
  if (scopedEntry === undefined) return null;
  const globalFiles = Object.values(manifest.kbs)
    .reduce((sum, entry) => sum + entry.file_count, 0);
  const scopeCounts = {
    modifiedFiles: scopedEntry.modified_files,
    newFiles: scopedEntry.new_files,
  };
  return {
    indexMtime,
    modifiedFiles: scopeCounts.modifiedFiles,
    newFiles: scopeCounts.newFiles,
    scope: { kb: scopedKb, ...scopeCounts },
    global,
    scan: buildStalenessScanStats({
      scopedKb,
      source: 'manifest',
      globalFiles,
      scopedFiles: scopedEntry.file_count,
      kbsScanned: 1,
    }),
  };
}

function buildStalenessScanStats(input: {
  scopedKb: string | undefined;
  source: FreshnessScanSource;
  globalFiles: number;
  scopedFiles: number | undefined;
  kbsScanned: number;
}): StalenessScanStats {
  const scope: FreshnessScanScope = input.scopedKb ? 'scoped' : 'global';
  const filesScanned = scope === 'scoped'
    ? input.scopedFiles ?? 0
    : input.globalFiles;
  return {
    scope,
    source: input.source,
    filesScanned,
    globalFiles: input.globalFiles,
    ...(input.scopedFiles !== undefined ? { scopedFiles: input.scopedFiles } : {}),
    kbsScanned: input.kbsScanned,
  };
}

async function computeStalenessWithTiming(
  activeModelId: string,
  scopedKb: string | undefined,
  timing: TimingPayload | null,
): Promise<Staleness> {
  const stalenessStartedAt = nowMs();
  const staleness = await computeStaleness(activeModelId, scopedKb);
  if (timing) {
    recordFreshnessScanTiming(timing, {
      elapsedMs: elapsedMs(stalenessStartedAt),
      ...(staleness.scan ?? buildStalenessScanStats({
        scopedKb,
        source: 'none',
        globalFiles: 0,
        scopedFiles: scopedKb ? 0 : undefined,
        kbsScanned: 0,
      })),
    });
  }
  return staleness;
}

export interface DenseSearchJsonPayloadInput {
  results: ScoredDocument[];
  requestedMode: SearchMode;
  effectiveMode: EffectiveSearchMode;
  autoModeDecision: AutoSearchModeDecision | null;
  groupBySource: boolean;
  refreshed: boolean;
  scopedKb: string | undefined;
  /** Original user query; embedded in the issue #335 empty-result refresh-command suggestion. */
  query?: string;
  staleness: Staleness | null;
  autoThresholdDecision: AutoThresholdDecision | null;
  timing: TimingPayload | null;
  /** Issue #328 — opt-in deep diagnostics for an empty result set. Ignored when results is non-empty. */
  explainEmptyDiagnostics?: ExplainEmptyDiagnostics | null;
}

export function buildDenseSearchJsonPayload(input: DenseSearchJsonPayloadInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    results: formatRetrievalAsJson(input.results, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI),
  };
  if (input.requestedMode === 'auto') {
    payload.mode = input.effectiveMode;
    payload.requested_mode = 'auto';
    payload.auto_mode = input.autoModeDecision;
  }
  if (input.groupBySource) {
    payload.grouped_results = groupRetrievalBySource(
      input.results,
      FRONTMATTER_EXTRAS_WIRE_VISIBLE,
      KB_EDITOR_URI,
    );
  }
  Object.assign(payload, buildFreshnessJsonFields(input));
  const emptyGuidance = computeEmptyResultGuidance(input);
  if (emptyGuidance?.json) {
    payload.empty_result_guidance = emptyGuidance.json;
  }
  if (input.results.length === 0 && input.explainEmptyDiagnostics) {
    payload.empty_result_diagnostics = explainEmptyDiagnosticsToJson(input.explainEmptyDiagnostics);
  }
  if (input.autoThresholdDecision !== null) {
    payload.auto_threshold = {
      threshold: input.autoThresholdDecision.threshold,
      knee_index: input.autoThresholdDecision.kneeIndex,
      kept: input.autoThresholdDecision.kept,
    };
  }
  if (input.timing) {
    payload.timing = compactTimingPayload(input.timing);
  }
  return payload;
}

function computeEmptyResultGuidance(input: {
  results: ScoredDocument[];
  refreshed: boolean;
  scopedKb: string | undefined;
  query?: string;
  staleness: Staleness | null;
}): EmptyResultGuidance | null {
  if (input.results.length > 0) return null;
  if (input.staleness === null) return null;
  return buildEmptyResultGuidance({
    query: input.query ?? '',
    scopedKb: input.scopedKb,
    refreshed: input.refreshed,
    staleness: {
      indexMtime: input.staleness.indexMtime,
      scoped: {
        modifiedFiles: input.staleness.scope?.modifiedFiles ?? input.staleness.modifiedFiles,
        newFiles: input.staleness.scope?.newFiles ?? input.staleness.newFiles,
      },
      global: input.staleness.scope
        ? {
            modifiedFiles: input.staleness.global?.modifiedFiles ?? 0,
            newFiles: input.staleness.global?.newFiles ?? 0,
          }
        : null,
    },
  });
}

function buildFreshnessJsonFields(input: DenseSearchJsonPayloadInput): Record<string, unknown> {
  const { refreshed, scopedKb, staleness } = input;
  if (staleness === null) return { freshness_omitted: true };

  const effectiveCounts = refreshed
    ? { modifiedFiles: 0, newFiles: 0 }
    : { modifiedFiles: staleness.modifiedFiles, newFiles: staleness.newFiles };
  const globalCounts = staleness.global ?? {
    modifiedFiles: staleness.modifiedFiles,
    newFiles: staleness.newFiles,
  };
  const scopedCounts = staleness.scope
    ? {
        modifiedFiles: refreshed ? 0 : staleness.scope.modifiedFiles,
        newFiles: refreshed ? 0 : staleness.scope.newFiles,
      }
    : null;
  const globalCountsForPayload = refreshed && !scopedKb
    ? { modifiedFiles: 0, newFiles: 0 }
    : globalCounts;

  return {
    index_mtime: staleness.indexMtime,
    stale: hasStaleCounts(effectiveCounts),
    modified_files: effectiveCounts.modifiedFiles,
    new_files: effectiveCounts.newFiles,
    global_stale: hasStaleCounts(globalCountsForPayload),
    global_modified_files: globalCountsForPayload.modifiedFiles,
    global_new_files: globalCountsForPayload.newFiles,
    ...(staleness.scope && scopedCounts
      ? {
          scope: {
            kb: staleness.scope.kb,
            stale: hasStaleCounts(scopedCounts),
            modified_files: scopedCounts.modifiedFiles,
            new_files: scopedCounts.newFiles,
          },
        }
      : {}),
  };
}

export interface DenseSearchMarkdownOutputInput {
  results: ScoredDocument[];
  groupBySource: boolean;
  staleness: Staleness | null;
  refreshed: boolean;
  scopedKb?: string;
  /** Original user query; embedded in the issue #335 empty-result refresh-command suggestion. */
  query?: string;
  autoModeDecision: AutoSearchModeDecision | null;
  autoThresholdDecision: AutoThresholdDecision | null;
  timing: TimingPayload | null;
  /** Issue #328 — opt-in deep diagnostics block, rendered only when results is empty. */
  explainEmptyDiagnostics?: ExplainEmptyDiagnostics | null;
}

export function formatDenseSearchMarkdownOutput(input: DenseSearchMarkdownOutputInput): string {
  let output = '';
  if (input.autoModeDecision !== null) {
    output += `${formatAutoModeHeader(input.autoModeDecision)}\n\n`;
  }
  if (input.autoThresholdDecision !== null) {
    output += `${formatAutoThresholdHeader(input.autoThresholdDecision)}\n\n`;
  }
  const emptyGuidance = computeEmptyResultGuidance({
    results: input.results,
    refreshed: input.refreshed,
    scopedKb: input.scopedKb,
    query: input.query,
    staleness: input.staleness,
  });
  const inlineEmptyGuidance = emptyGuidance?.markdown ?? null;
  let md: string;
  if (input.results.length === 0 && inlineEmptyGuidance !== null) {
    md = formatRetrievalEmptyAsMarkdown(inlineEmptyGuidance);
  } else if (input.groupBySource) {
    md = formatRetrievalGroupedBySourceAsMarkdown(input.results, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI);
  } else {
    md = formatRetrievalAsMarkdown(input.results, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI);
  }
  output += `${md}\n\n`;
  if (input.results.length === 0 && input.explainEmptyDiagnostics) {
    output += `${formatExplainEmptyDiagnosticsMarkdown(input.explainEmptyDiagnostics)}\n\n`;
  }
  if (input.staleness !== null && inlineEmptyGuidance === null) {
    // Suppress the trailing footer when the inline empty-result block already
    // includes the refresh command + stale counts — operators shouldn't see
    // the same suggestion twice (issue #335).
    output += `${formatFreshnessFooter(input.staleness, input.refreshed)}\n`;
  }
  if (input.timing) {
    output += `${formatTimingFooter('Timing', input.timing)}\n`;
  }
  return output;
}

export function formatFreshnessFooter(s: Staleness, refreshed: boolean): string {
  if (s.indexMtime === null) {
    return `> _Index not yet built. Run \`kb search --refresh\` to create it._`;
  }
  if (s.scope) {
    return formatScopedFreshnessFooter(s, refreshed);
  }
  if (refreshed) {
    return `> _Index refreshed at ${s.indexMtime}._`;
  }
  if (s.modifiedFiles === 0 && s.newFiles === 0) {
    return `> _Index up-to-date as of ${s.indexMtime}._`;
  }
  if (s.modifiedFiles === 0) {
    return (
      `> _${s.newFiles} new file(s) since ${s.indexMtime}; ` +
      `run \`kb search --refresh\` to include them._`
    );
  }
  return (
    `> _Index may be stale: ${s.modifiedFiles} modified, ${s.newFiles} new ` +
    `file(s) since ${s.indexMtime}. Run \`kb search --refresh\` to update._`
  );
}

function formatScopedFreshnessFooter(s: Staleness, refreshed: boolean): string {
  const scope = s.scope!;
  const global = s.global ?? { modifiedFiles: s.modifiedFiles, newFiles: s.newFiles };
  const globalText = `${global.modifiedFiles} modified, ${global.newFiles} new file(s)`;
  if (refreshed) {
    if (global.modifiedFiles === 0 && global.newFiles === 0) {
      return `> _Index refreshed for KB "${scope.kb}" at ${s.indexMtime}; global index drift is also 0 modified, 0 new file(s)._`;
    }
    return `> _Index refreshed for KB "${scope.kb}" at ${s.indexMtime}. Global index drift outside this scope: ${globalText}._`;
  }
  if (scope.modifiedFiles === 0 && scope.newFiles === 0) {
    if (global.modifiedFiles === 0 && global.newFiles === 0) {
      return `> _Index up-to-date for KB "${scope.kb}" as of ${s.indexMtime}; global index drift is also 0 modified, 0 new file(s)._`;
    }
    return `> _Index up-to-date for KB "${scope.kb}" as of ${s.indexMtime}. Global index drift outside this scope: ${globalText}._`;
  }
  return (
    `> _Index may be stale for KB "${scope.kb}": ${scope.modifiedFiles} modified, ${scope.newFiles} new ` +
    `file(s) since ${s.indexMtime}. Run \`kb search --kb=${scope.kb} --refresh\` to update this scope. ` +
    `Global index drift: ${globalText}._`
  );
}

function hasStaleCounts(counts: StalenessCounts): boolean {
  return counts.modifiedFiles + counts.newFiles > 0;
}

// -- Issue #328 — opt-in deep diagnostics for empty results ------------------
//
// When `kb search` returns zero results and the operator passed
// `--explain-empty`, we build a single self-describing record that explains
// *why* the run was empty in terms of state the CLI already has cheap access
// to:
//
//   - Pre-filter candidate count (raw FAISS top-K, no filters)
//   - Post-filter candidate count (always 0 here; included for symmetry)
//   - Per-filter drops (kb_scope and threshold). Classification order is
//     scope-first, threshold-second so the counts sum to pre_filter:
//     `kb_scope + threshold + post_filter == pre_filter`.
//   - Active scope: which KBs were searched, which were skipped + reason
//   - Index freshness summary (consumes the existing `Staleness` we already
//     scanned; never re-runs the staleness scan)
//   - 1-3 nearest non-matching candidates (with their similarity score) —
//     scored from the FAISS top-K we pulled with threshold=+Inf.
//
// We do NOT modify the existing `computeEmptyResultGuidance` core (issue
// #335); diagnostics are an additive sibling, rendered alongside it.

export type ExplainEmptyDropReason = 'kb_scope' | 'threshold' | 'none';

export interface ExplainEmptyDiagnosticsCandidate {
  score: number;
  source: string | null;
  kb: string | null;
  droppedBy: ExplainEmptyDropReason;
}

export interface ExplainEmptyDiagnosticsScope {
  requestedKb: string | null;
  kbsSearched: string[];
  kbsSkipped: Array<{ kb: string; reason: string }>;
}

export interface ExplainEmptyDiagnosticsFreshness {
  indexBuilt: boolean;
  indexMtime: string | null;
  scoped: { modifiedFiles: number; newFiles: number } | null;
  global: { modifiedFiles: number; newFiles: number };
}

export interface ExplainEmptyDiagnostics {
  threshold: number;
  candidatesPreFilter: number;
  candidatesPostFilter: number;
  filterDrops: {
    kbScope: number;
    threshold: number;
  };
  scope: ExplainEmptyDiagnosticsScope;
  freshness: ExplainEmptyDiagnosticsFreshness;
  nearestCandidates: ExplainEmptyDiagnosticsCandidate[];
}

export interface BuildExplainEmptyDiagnosticsInput {
  rawCandidates: ReadonlyArray<Pick<SearchResultDocument, 'score' | 'metadata'>>;
  threshold: number;
  scopedKb: string | undefined;
  allKbs: readonly string[];
  staleness: Staleness | null;
  kbRoot: string;
  /** Maximum number of nearest-candidate rows to emit. Defaults to 3. */
  nearestCount?: number;
}

export function buildExplainEmptyDiagnostics(
  input: BuildExplainEmptyDiagnosticsInput,
): ExplainEmptyDiagnostics {
  const nearestCount = input.nearestCount ?? 3;
  const classified = input.rawCandidates.map((c) => {
    const source = extractSourceString(c.metadata);
    const kb = source !== null ? extractKbNameFromSource(source, input.kbRoot) : null;
    const droppedBy = classifyDropReason({
      kb,
      score: c.score,
      threshold: input.threshold,
      scopedKb: input.scopedKb,
    });
    return { score: c.score, source, kb, droppedBy };
  });

  const kbScopeDrops = classified.filter((c) => c.droppedBy === 'kb_scope').length;
  const thresholdDrops = classified.filter((c) => c.droppedBy === 'threshold').length;
  const kept = classified.filter((c) => c.droppedBy === 'none').length;

  const kbsSearched = input.scopedKb ? [input.scopedKb] : [...input.allKbs];
  const kbsSkipped = input.scopedKb
    ? input.allKbs
        .filter((k) => k !== input.scopedKb)
        .map((k) => ({ kb: k, reason: `outside --kb=${input.scopedKb}` }))
    : [];

  const freshness: ExplainEmptyDiagnosticsFreshness = input.staleness === null
    ? {
        indexBuilt: false,
        indexMtime: null,
        scoped: null,
        global: { modifiedFiles: 0, newFiles: 0 },
      }
    : {
        indexBuilt: input.staleness.indexMtime !== null,
        indexMtime: input.staleness.indexMtime,
        scoped: input.staleness.scope
          ? {
              modifiedFiles: input.staleness.scope.modifiedFiles,
              newFiles: input.staleness.scope.newFiles,
            }
          : null,
        global: {
          modifiedFiles:
            input.staleness.global?.modifiedFiles ?? input.staleness.modifiedFiles,
          newFiles: input.staleness.global?.newFiles ?? input.staleness.newFiles,
        },
      };

  return {
    threshold: input.threshold,
    candidatesPreFilter: input.rawCandidates.length,
    candidatesPostFilter: kept,
    filterDrops: { kbScope: kbScopeDrops, threshold: thresholdDrops },
    scope: {
      requestedKb: input.scopedKb ?? null,
      kbsSearched,
      kbsSkipped,
    },
    freshness,
    nearestCandidates: classified.slice(0, nearestCount),
  };
}

function classifyDropReason(input: {
  kb: string | null;
  score: number;
  threshold: number;
  scopedKb: string | undefined;
}): ExplainEmptyDropReason {
  // Order matters: scope first, then threshold. This mirrors the structural
  // partitioning of similaritySearch's post-filter (scope is a hard
  // boundary; threshold is a score cutoff applied within scope) and keeps
  // drops mutually exclusive so per-filter counts sum to pre-filter total.
  if (input.scopedKb !== undefined && input.kb !== input.scopedKb) {
    return 'kb_scope';
  }
  if (input.score > input.threshold) {
    return 'threshold';
  }
  return 'none';
}

function extractSourceString(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const src = (metadata as { source?: unknown }).source;
  return typeof src === 'string' ? src : null;
}

function extractKbNameFromSource(source: string, kbRoot: string): string | null {
  const prefix = kbRoot.endsWith(path.sep) ? kbRoot : `${kbRoot}${path.sep}`;
  if (!source.startsWith(prefix)) return null;
  const rest = source.slice(prefix.length);
  const sepIdx = rest.indexOf(path.sep);
  if (sepIdx === -1) return rest.length > 0 ? rest : null;
  return rest.slice(0, sepIdx);
}

export interface ExplainEmptyDiagnosticsJson {
  threshold: number;
  candidates_pre_filter: number;
  candidates_post_filter: number;
  filter_drops: { kb_scope: number; threshold: number };
  scope: {
    requested_kb: string | null;
    kbs_searched: string[];
    kbs_skipped: Array<{ kb: string; reason: string }>;
  };
  freshness: {
    index_built: boolean;
    index_mtime: string | null;
    scoped: { modified_files: number; new_files: number } | null;
    global: { modified_files: number; new_files: number };
  };
  nearest_candidates: Array<{
    score: number;
    source: string | null;
    kb: string | null;
    dropped_by: ExplainEmptyDropReason;
  }>;
}

export function explainEmptyDiagnosticsToJson(
  d: ExplainEmptyDiagnostics,
): ExplainEmptyDiagnosticsJson {
  return {
    threshold: d.threshold,
    candidates_pre_filter: d.candidatesPreFilter,
    candidates_post_filter: d.candidatesPostFilter,
    filter_drops: {
      kb_scope: d.filterDrops.kbScope,
      threshold: d.filterDrops.threshold,
    },
    scope: {
      requested_kb: d.scope.requestedKb,
      kbs_searched: d.scope.kbsSearched,
      kbs_skipped: d.scope.kbsSkipped,
    },
    freshness: {
      index_built: d.freshness.indexBuilt,
      index_mtime: d.freshness.indexMtime,
      scoped: d.freshness.scoped
        ? {
            modified_files: d.freshness.scoped.modifiedFiles,
            new_files: d.freshness.scoped.newFiles,
          }
        : null,
      global: {
        modified_files: d.freshness.global.modifiedFiles,
        new_files: d.freshness.global.newFiles,
      },
    },
    nearest_candidates: d.nearestCandidates.map((c) => ({
      score: c.score,
      source: c.source,
      kb: c.kb,
      dropped_by: c.droppedBy,
    })),
  };
}

export function formatExplainEmptyDiagnosticsMarkdown(d: ExplainEmptyDiagnostics): string {
  const lines: string[] = ['### Diagnostics', ''];
  lines.push(`- Candidates inspected: ${d.candidatesPreFilter} (FAISS top-K, no filters)`);
  lines.push(`- Candidates kept after filters: ${d.candidatesPostFilter}`);
  lines.push(
    `- Per-filter drops: kb_scope=${d.filterDrops.kbScope}, threshold=${d.filterDrops.threshold}` +
      ` (threshold=${formatThresholdForDiagnostics(d.threshold)})`,
  );
  lines.push(formatScopeLine(d.scope));
  lines.push(formatFreshnessLine(d.freshness));
  if (d.nearestCandidates.length === 0) {
    lines.push('- Nearest candidates: none (index may be empty or never built)');
  } else {
    lines.push('- Nearest candidates (top-K from FAISS, before filters):');
    for (const c of d.nearestCandidates) {
      const where = c.source ?? '(unknown source)';
      const tag = c.droppedBy === 'none' ? 'kept' : `dropped by ${c.droppedBy}`;
      lines.push(`  - score=${c.score.toFixed(3)} ${where} — ${tag}`);
    }
  }
  return lines.join('\n');
}

function formatThresholdForDiagnostics(threshold: number): string {
  if (!Number.isFinite(threshold)) return 'infinity';
  return threshold.toFixed(2);
}

function formatScopeLine(scope: ExplainEmptyDiagnosticsScope): string {
  if (scope.requestedKb === null) {
    const kbs = scope.kbsSearched.length === 0
      ? '(none — no KBs available)'
      : scope.kbsSearched.join(', ');
    return `- Scope: global (${scope.kbsSearched.length} KB(s) searched: ${kbs})`;
  }
  const skippedCount = scope.kbsSkipped.length;
  const skippedText = skippedCount === 0
    ? 'no other KBs available'
    : `${skippedCount} skipped (outside --kb=${scope.requestedKb})`;
  return `- Scope: \`--kb=${scope.requestedKb}\` (1 searched; ${skippedText})`;
}

function formatFreshnessLine(f: ExplainEmptyDiagnosticsFreshness): string {
  if (!f.indexBuilt) {
    return '- Index: not yet built (run `kb search --refresh` to create it)';
  }
  const scopedPart = f.scoped
    ? `, scoped drift=${f.scoped.modifiedFiles}m+${f.scoped.newFiles}n`
    : '';
  return (
    `- Index: built ${f.indexMtime}${scopedPart}, ` +
    `global drift=${f.global.modifiedFiles}m+${f.global.newFiles}n`
  );
}

function reportFailure(failure: SearchFailure, format: SearchFormat): number {
  if (format === 'json') {
    process.stdout.write(formatKbSearchFailureJson(failure));
  } else {
    process.stderr.write(formatKbSearchFailureStderr(failure));
  }
  return exitCodeForFailure(failure);
}

async function printRefreshPreflightIfLarge(
  activeModelId: string,
  manager: FaissIndexManager,
  scopedKb: string | undefined,
  format: SearchFormat,
): Promise<void> {
  const binaryPath = await resolveFaissIndexBinaryPath(activeModelId);
  let indexMtimeMs: number | null = null;
  if (binaryPath !== null) {
    try {
      indexMtimeMs = (await fsp.stat(binaryPath)).mtimeMs;
    } catch {
      indexMtimeMs = null;
    }
  }
  const estimate = await buildRefreshPreflightEstimate({
    activeModel: {
      modelId: activeModelId,
      provider: manager.embeddingProvider,
      modelName: manager.modelName,
    },
    indexMtimeMs,
    scopedKb,
  });
  maybeWriteRefreshPreflight(estimate, { format });
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

/**
 * Pick a knee-based distance cutoff from FAISS top-K scores (lower = closer).
 *
 * Scores must already be sorted ascending — FAISS returns them this way.
 * The largest first-difference is the "knee" where relevance falls off; the
 * cutoff is the score at the elbow (the last result kept). When the largest
 * gap is within 10% of the mean gap the distribution is uniform and we keep
 * everything (no clear knee).
 */
export function computeAutoThreshold(scores: readonly number[]): AutoThresholdDecision {
  if (scores.length === 0) {
    return { threshold: 0, kneeIndex: null, kept: 0 };
  }
  if (scores.length === 1) {
    return { threshold: scores[0], kneeIndex: null, kept: 1 };
  }

  let sumDiff = 0;
  let maxDiff = -Infinity;
  let maxIdx = 0;
  for (let i = 0; i < scores.length - 1; i += 1) {
    const d = scores[i + 1] - scores[i];
    sumDiff += d;
    if (d > maxDiff) {
      maxDiff = d;
      maxIdx = i;
    }
  }
  const meanDiff = sumDiff / (scores.length - 1);

  if (maxDiff <= meanDiff * 1.1) {
    return {
      threshold: scores[scores.length - 1],
      kneeIndex: null,
      kept: scores.length,
    };
  }

  return {
    threshold: scores[maxIdx],
    kneeIndex: maxIdx,
    kept: maxIdx + 1,
  };
}

export function formatAutoThresholdHeader(d: AutoThresholdDecision): string {
  if (d.kept === 0) {
    return '> _Auto-threshold: no results to score._';
  }
  const t = d.threshold.toFixed(2);
  if (d.kneeIndex === null) {
    if (d.kept === 1) {
      return `> _Auto-threshold: ${t} (1 result; no knee detection)._`;
    }
    return `> _Auto-threshold: ${t} (no clear knee; kept all ${d.kept} results)._`;
  }
  return `> _Auto-threshold: ${t} (knee at result ${d.kneeIndex + 1}; kept ${d.kept})._`;
}

// -- #206 stage 1 — lexical search dispatch ----------------------------------

interface LexicalKbResult {
  kbName: string;
  kbPath: string;
  refreshSummary: { added: number; updated: number; removed: number; failed: number; totalFiles: number; totalChunks: number } | null;
  hits: LexicalSearchResult[];
  error?: Error;
}

async function runLexicalSearch(
  parsed: SearchArgs,
  timing: TimingPayload | null = null,
  totalStartedAt: number = nowMs(),
  autoModeDecision: AutoSearchModeDecision | null = null,
): Promise<number> {
  if (parsed.thresholdAuto || parsed.threshold !== undefined) {
    process.stderr.write('kb search: --threshold/--threshold=auto are dense-only; ignored under --mode=lexical\n');
  }
  if (parsed.groupBySource) {
    process.stderr.write('kb search: --group-by-source is dense-only in stage 1; ignored under --mode=lexical\n');
  }

  const query = parsed.query as string;

  let kbs: Array<{ kbName: string; kbPath: string }>;
  try {
    const startedAt = nowMs();
    kbs = await listLexicalKbs(parsed.kb);
    if (timing) timing.lexical_kb_list_ms = elapsedMs(startedAt);
  } catch (err) {
    process.stderr.write(`kb search (lexical): could not list KBs: ${(err as Error).message}\n`);
    return 1;
  }
  if (parsed.kb && kbs.length === 0) {
    process.stderr.write(`kb search (lexical): KB not found: ${parsed.kb}\n`);
    return 2;
  }

  const perKb: LexicalKbResult[] = [];
  const lexicalStartedAt = nowMs();
  for (const { kbName, kbPath } of kbs) {
    let index: LexicalIndex;
    try {
      index = await LexicalIndex.load(kbName, kbPath);
    } catch (err) {
      perKb.push({ kbName, kbPath, refreshSummary: null, hits: [], error: err as Error });
      continue;
    }

    let refreshSummary: LexicalKbResult['refreshSummary'] = null;
    if (parsed.refresh || index.numFiles() === 0) {
      try {
        refreshSummary = await index.refresh();
        await index.save();
      } catch (err) {
        perKb.push({ kbName, kbPath, refreshSummary: null, hits: [], error: err as Error });
        continue;
      }
    }

    let hits: LexicalSearchResult[];
    try {
      hits = await index.query(query, parsed.k);
    } catch (err) {
      perKb.push({ kbName, kbPath, refreshSummary, hits: [], error: err as Error });
      continue;
    }
    perKb.push({ kbName, kbPath, refreshSummary, hits });
  }
  if (timing) {
    timing.lexical_search_ms = elapsedMs(lexicalStartedAt);
    timing.total_ms = elapsedMs(totalStartedAt);
  }

  // Merge across KBs by score (BM25 score is positive; higher is better).
  const merged: LexicalSearchResult[] = [];
  for (const row of perKb) {
    for (const hit of row.hits) {
      merged.push(hit);
    }
  }
  merged.sort((a, b) => b.score - a.score);
  const topK = merged.slice(0, parsed.k);

  const errors = perKb.filter((r) => r.error);
  for (const e of errors) {
    process.stderr.write(`kb search (lexical): ${e.kbName} — ${e.error?.message ?? 'unknown error'}\n`);
  }

  // For format reuse, transform LexicalSearchResult into the dense
  // shape `{...Document, score}` that formatRetrievalAs* expect.
  const formatted = topK.map((h) => {
    const obj: Record<string, unknown> & { pageContent: string; metadata: Record<string, unknown>; score: number } = {
      pageContent: h.pageContent,
      metadata: h.metadata,
      score: h.score,
    };
    return obj;
  });

  if (shouldUsePicker(parsed)) {
    return runPicker({ results: formatted as ScoredDocument[] });
  }

  if (parsed.format === 'json') {
    const payload = {
      mode: 'lexical' as const,
      ...(autoModeDecision
        ? { requested_mode: 'auto' as const, auto_mode: autoModeDecision }
        : {}),
      results: formatRetrievalAsJson(formatted as never, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI),
      knowledge_bases: perKb.map((r) => ({
        kb: r.kbName,
        files: r.refreshSummary?.totalFiles ?? null,
        chunks: r.refreshSummary?.totalChunks ?? null,
        refresh: r.refreshSummary
          ? {
              added: r.refreshSummary.added,
              updated: r.refreshSummary.updated,
              removed: r.refreshSummary.removed,
              failed: r.refreshSummary.failed,
            }
          : null,
        error: r.error ? r.error.message : null,
      })),
      ...(timing ? { timing: compactTimingPayload(timing) } : {}),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (parsed.format === 'vimgrep') {
    const out = formatRetrievalAsVimgrep(formatted as never);
    if (out !== '') process.stdout.write(`${out}\n`);
  } else {
    if (autoModeDecision) {
      process.stdout.write(formatAutoModeHeader(autoModeDecision));
      process.stdout.write('\n\n');
    }
    process.stdout.write(`> _Mode: lexical (BM25). Stage 1 — debug surface; see #206._\n\n`);
    if (formatted.length === 0) {
      process.stdout.write(`_No matches._\n\n`);
    } else {
      process.stdout.write(formatRetrievalAsMarkdown(formatted as never, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI));
      process.stdout.write('\n\n');
    }
    const summaryLines = perKb.map((r) => {
      if (r.error) return `- ${r.kbName}: error — ${r.error.message}`;
      const f = r.refreshSummary;
      const counts = f
        ? `${f.totalFiles} file(s), ${f.totalChunks} chunk(s)` +
          (f.added || f.updated || f.removed || f.failed
            ? ` (refresh: +${f.added}/~${f.updated}/-${f.removed}, ${f.failed} failed)`
            : '')
        : '(no refresh this run)';
      return `- ${r.kbName}: ${counts}`;
    });
    process.stdout.write(`> _Lexical index status:_\n${summaryLines.join('\n')}\n`);
    if (timing) {
      process.stdout.write(`\n`);
      process.stdout.write(formatTimingFooter('Timing', timing));
      process.stdout.write('\n');
    }
  }

  return errors.length > 0 ? 1 : 0;
}

// -- #206 stage 2 — hybrid (RRF) dispatch ----------------------------------

async function runHybridSearch(
  parsed: SearchArgs,
  timing: TimingPayload | null = null,
  totalStartedAt: number = nowMs(),
  autoModeDecision: AutoSearchModeDecision | null = null,
): Promise<number> {
  if (parsed.thresholdAuto || parsed.threshold !== undefined) {
    process.stderr.write('kb search: --threshold/--threshold=auto are dense-only; ignored under --mode=hybrid\n');
  }
  if (parsed.groupBySource) {
    process.stderr.write('kb search: --group-by-source is dense-only in stage 2; ignored under --mode=hybrid\n');
  }

  const query = parsed.query as string;
  const fetchK = hybridFetchK(parsed.k);

  // -- dense leg -----------------------------------------------------------
  let densePromise: Promise<HybridChunk[]>;
  let denseError: Error | null = null;
  let activeModelId: string | null = null;
  try {
    let startedAt = nowMs();
    await FaissIndexManager.bootstrapLayout();
    if (timing) timing.bootstrap_ms = elapsedMs(startedAt);
    startedAt = nowMs();
    activeModelId = await resolveActiveModel({ explicitOverride: parsed.model });
    if (timing) timing.model_resolution_ms = elapsedMs(startedAt);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }
  let manager: FaissIndexManager;
  try {
    const startedAt = nowMs();
    manager = await loadManagerForModel(activeModelId);
    if (timing) timing.manager_load_ms = elapsedMs(startedAt);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }
  try {
    const startedAt = nowMs();
    if (parsed.refresh) {
      await withWriteLock(manager.modelDir, async () => {
        await printRefreshPreflightIfLarge(activeModelId, manager, parsed.kb, parsed.format);
        await manager.initialize();
        await manager.updateIndex(parsed.kb, {
          onProgress: createRefreshProgressReporter(timing),
        });
      });
    } else {
      await loadWithJsonRetry(manager);
    }
    if (timing) timing.index_load_ms = elapsedMs(startedAt);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }
  const denseTiming: SimilaritySearchTiming = {};
  const denseStartedAt = nowMs();
  densePromise = manager
    .similaritySearch(
      query,
      fetchK,
      Number.POSITIVE_INFINITY,
      parsed.kb,
      undefined,
      denseTiming,
      { noCache: parsed.noCache },
    )
    .then((rs) => {
      if (timing) {
        timing.dense_search_ms = elapsedMs(denseStartedAt);
        mergeDenseTiming(timing, denseTiming);
      }
      return rs.map((r) => ({ pageContent: r.pageContent, metadata: r.metadata, score: r.score }));
    })
    .catch((err) => {
      denseError = err as Error;
      return [];
    });

  // -- lexical leg ---------------------------------------------------------
  let lexicalKbs: Array<{ kbName: string; kbPath: string }>;
  try {
    const startedAt = nowMs();
    lexicalKbs = await listLexicalKbs(parsed.kb);
    if (timing) timing.lexical_kb_list_ms = elapsedMs(startedAt);
  } catch (err) {
    process.stderr.write(`kb search (hybrid): could not list KBs: ${(err as Error).message}\n`);
    return 1;
  }

  const lexicalStartedAt = nowMs();
  const lexicalPromise = runLexicalLeg({
    kbs: lexicalKbs,
    query,
    fetchK,
    refresh: parsed.refresh ? 'always' : 'when-empty',
    onError: (kbName, err) => {
      process.stderr.write(`kb search (hybrid lexical leg): ${kbName} — ${err.message}\n`);
    },
  }).then((row) => {
    if (timing) timing.lexical_search_ms = elapsedMs(lexicalStartedAt);
    return row;
  });

  const [denseResults, lexicalResultsRow] = await Promise.all([densePromise, lexicalPromise]);
  if (denseError) {
    return reportFailure(classifyKbSearchError(denseError), parsed.format);
  }
  const lexicalResults = lexicalResultsRow.hits;

  // -- fuse ----------------------------------------------------------------
  const fusionStartedAt = nowMs();
  const ranked = fuseHybridResults({
    denseResults,
    lexicalResults,
    k: parsed.k,
  });
  if (timing) {
    timing.fusion_ms = elapsedMs(fusionStartedAt);
    timing.total_ms = elapsedMs(totalStartedAt);
  }

  if (shouldUsePicker(parsed)) {
    return runPicker({ results: ranked as ScoredDocument[] });
  }

  if (parsed.format === 'json') {
    const payload = {
      mode: 'hybrid' as const,
      ...(autoModeDecision
        ? { requested_mode: 'auto' as const, auto_mode: autoModeDecision }
        : {}),
      results: formatRetrievalAsJson(ranked as never, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI),
      retrievers: {
        dense: { fetched: denseResults.length, model: activeModelId },
        lexical: { fetched: lexicalResults.length, refreshed: lexicalResultsRow.refreshed, failed: lexicalResultsRow.failed },
      },
      rrf: { c: HYBRID_RRF_C, fetch_k: fetchK },
      ...(timing ? { timing: compactTimingPayload(timing) } : {}),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (parsed.format === 'vimgrep') {
    const out = formatRetrievalAsVimgrep(ranked as never);
    if (out !== '') process.stdout.write(`${out}\n`);
  } else {
    if (autoModeDecision) {
      process.stdout.write(formatAutoModeHeader(autoModeDecision));
      process.stdout.write('\n\n');
    }
    process.stdout.write(`> _Mode: hybrid (RRF c=${HYBRID_RRF_C}). Stage 2 — dense ⨁ lexical; see #206._\n\n`);
    if (ranked.length === 0) {
      process.stdout.write(`_No matches._\n\n`);
    } else {
      process.stdout.write(formatRetrievalAsMarkdown(ranked as never, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI));
      process.stdout.write('\n\n');
    }
    process.stdout.write(
      `> _Hybrid status: dense fetched ${denseResults.length}, lexical fetched ${lexicalResults.length} (refreshed ${lexicalResultsRow.refreshed}, ${lexicalResultsRow.failed} failed); fused via RRF (c=${HYBRID_RRF_C}, fetch_k=${fetchK})._\n`,
    );
    if (timing) {
      process.stdout.write(formatTimingFooter('Timing', timing));
      process.stdout.write('\n');
    }
  }

  return 0;
}
