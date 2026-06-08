import * as fsp from 'fs/promises';
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
} from './search-errors-core.js';
import {
  FRONTMATTER_EXTRAS_WIRE_VISIBLE,
  KB_EDITOR_URI,
} from './config/retrieval.js';
import {
  KNOWLEDGE_BASES_ROOT_DIR,
} from './config/paths.js';
import {
  formatRetrievalAsJson,
  formatRetrievalAsCompactTable,
  formatRetrievalAsMarkdown,
  formatRetrievalAsVimgrep,
  formatRetrievalEmptyAsMarkdown,
  formatRetrievalGroupedBySourceAsMarkdown,
  groupRetrievalBySource,
  type RetrievalHighlightOptions,
  type ScoredDocument,
} from './formatter.js';
import { runPicker } from './cli-search-picker.js';
import { listKnowledgeBases } from './kb-fs.js';
import { withWriteLock } from './write-lock.js';
import { loadManagerForModel, loadWithJsonRetry } from './cli-shared.js';
import {
  compactTimingPayload,
  elapsedMs,
  formatTimingFooter,
  nowMs,
  recordFreshnessScanTiming,
  recordRefreshProgressTiming,
  type TimingPayload,
} from './timing-core.js';
import { LexicalIndex, type LexicalRankingUnit, type LexicalSearchResult } from './lexical-index.js';
import {
  HYBRID_RRF_C,
  fuseHybridResultsWithDiagnostics,
  hybridFetchK,
  listLexicalKbs,
  runLexicalLeg,
  type HybridChunk,
} from './hybrid-retrieval.js';
import {
  applyAdvancedRetrieval,
  computeAdvancedCandidateK,
  filterAdvancedRetrievalMetadata,
  hasAdvancedRetrieval,
  type AdvancedRetrievalMetadata,
  type AdvancedRetrievalPool,
} from './advanced-retrieval.js';
import {
  applyRelevanceGate,
  emitRelevanceGateDecision,
  formatGateDroppedList,
  formatGateVerdictFooter,
  type RelevanceGateOverride,
} from './relevance-gate.js';
import {
  RELEVANCE_GATE_SCHEMA_VERSION,
  type RelevanceGateVerdict,
} from './relevance-gate-schema.js';
import {
  applyRerankerIfEnabled,
  parseRerankFlag,
  resolveRerankerConfig,
  type RerankOverride,
  type RerankerConfig,
} from './reranker.js';
import { writeMaybePagedOutput, type PagerFlag } from './cli-pager.js';
import {
  inspectTaskContext,
  resolveTaskContextArgvMax,
  resolveTaskContextPolicyMode,
  type TaskContextSource,
} from './task-context-guard.js';
import { chunkIdFromMetadata } from './rrf.js';
import {
  buildEmptyResultGuidance,
  buildRefreshPreflightEstimate,
  maybeWriteRefreshPreflight,
  type EmptyResultGuidance,
} from './cli-search-staleness.js';
import {
  buildExplainEmptyDiagnostics,
  computeAutoThreshold,
  computeStaleness,
  explainEmptyDiagnosticsToJson,
  formatAutoModeHeader,
  formatAutoThresholdHeader,
  formatExplainEmptyDiagnosticsMarkdown,
  formatFreshnessFooter,
  hasStaleCounts,
  resolveAutoSearchMode,
  type AutoSearchModeDecision,
  type AutoThresholdDecision,
  type EffectiveSearchMode,
  type ExplainEmptyDiagnostics,
  type SearchMode,
  type Staleness,
} from './search-core.js';
import { hashQuery, type CanonicalLogInput } from './canonical-log.js';
import type { QueryCacheTelemetry } from './query-cache.js';

export const SEARCH_HELP = `kb search — semantic search across knowledge bases

Usage:
  kb search <query> [options]
  kb search --stdin [options]
  kb search --batch-jsonl [options]
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
  --lexical-unit=chunk|source
                        BM25 ranking unit for lexical and hybrid modes.
                        chunk ranks each chunk; source ranks each source file
                        and returns its best matching chunk (default: chunk).
  --context-before=<n>  Include up to n preceding chunks from the same source
                        around each dense semantic match (0-${MAX_NEIGHBOR_CONTEXT_WINDOW}).
  --context-after=<n>   Include up to n following chunks from the same source
                        around each dense semantic match (0-${MAX_NEIGHBOR_CONTEXT_WINDOW}).
  --context-window=<n>  Shorthand for --context-before=n --context-after=n.
  --no-cache            Bypass the query-embedding cache for this search.
  --gate                Run the relevance gate for this call even when
                        KB_RELEVANCE_GATE is off.
  --no-gate             Bypass the relevance gate for this call.
  --rerank              Run the RFC 019 cross-encoder reranker for this call
                        (currently applies to hybrid retrieval).
  --no-rerank           Bypass the reranker for this call.
  --diverse             Rerank a bounded dense candidate pool for
                        source-aware, non-duplicative coverage.
  --anti-query=<str>    Penalize candidates close to this negative query while
                        keeping only positive-query-supported candidates.
                        May be repeated.
  --plus=<str>          Add another positive query component for exploratory
                        vector-composition-style retrieval. May be repeated.
  --minus=<str>         Add another negative query component. May be repeated.
  --task-context=<str>  Task context used by the relevance judge. Prefer
                        --task-context-file for long or prompt-like text:
                        argv is exposed in 'ps', shell history, and hooks.
  --task-context-file=<path>
                        Read task context from a UTF-8 file.
                        KB_GATE_TASK_CONTEXT_MODE=off|warn|strict controls the
                        policy (default warn): warn advises on argv exposure
                        and prompt-injection signals; strict refuses task
                        context carrying injection signals.

Output:
  --format=md|json|vimgrep|compact
                        Output format (default: md). compact prints a
                        fixed-width scan table; vimgrep prints
                        path:line:col:preview for editor quickfix flows.
  --view=compact        Alias for --format=compact.
  --format=table        Alias for --format=compact.
  --batch-jsonl         Read JSONL rows from stdin and emit one compact JSON
                        result envelope per row. Each row accepts query plus
                        optional per-row search option fields such as kb, k,
                        mode, model, threshold, no_cache, freshness,
                        group_by_source, task_context, gate, refresh, and
                        context_window.
  --group-by-source     Collapse repeated chunks from the same source file
                        in markdown output. With \`--format=json\`, adds a
                        \`grouped_results\` field alongside raw results.
  --timing              Include elapsed milliseconds for retrieval stages.
                        For non-empty filtered dense searches, also surfaces
                        aggregate filter selectivity counters.
  --pager               Page markdown/compact output through KB_PAGER, PAGER,
                        or less -R when stdout is a TTY.
  --no-pager            Disable KB_PAGER for this search.
  --highlight=auto|always|never
                        Highlight query terms in markdown snippets with ANSI
                        emphasis. auto uses ANSI only on a TTY (default);
                        always also works through pipes; never disables it.
  --no-highlight        Alias for --highlight=never.
  --daemon              Use the local read-only daemon when available; falls
                        back to direct search when unreachable.
  --no-freshness        Skip the staleness scan and omit freshness output.
  --explain-empty       Opt-in deep diagnostics for empty results: pre/post
                        filter candidate counts, per-filter drops, scope,
                        index freshness, and the nearest non-matching
                        candidates. Has no effect when results are non-empty.
  --explain             Include relevance-gate dropped-candidate details in
                        markdown output. JSON always includes gate_verdict.

Indexing:
  --refresh             Re-scan KB files; acquires the per-model write lock.
                        If the stale delta is larger than 100 files or
                        100 MiB, prints a nonblocking refresh preflight to
                        stderr before embedding starts.

Input:
  --stdin               Read query from stdin (multi-line safe).
  -i, --interactive     Open an interactive results picker (TTY only; ignored
                        when a structured or compact format is set).
  --help, -h            Show this help.

Examples:
  kb search "rollback procedure"
  kb search "deploy" --kb=work --k=5
  kb search "INDEX_NOT_INITIALIZED" --mode=lexical --refresh
  kb search "retrieval benchmarks" --mode=lexical --lexical-unit=source
  kb search "INDEX_NOT_INITIALIZED" --mode=hybrid
  kb search "src/cli.ts" --mode=auto --timing
  kb search "retrieval safety" --diverse --format=json
  kb search "agent evidence" --anti-query="UI styling" --format=json
  kb search "queue triage" --plus="slow loop" --minus="frontend layout"
  kb search "rollback" --view=compact --k=20
  kb search --stdin --format=json < query.txt
  printf '%s\n' '{"query":"rollback","kb":"ops"}' | kb search --batch-jsonl
`;

export type SearchFormat = 'md' | 'json' | 'vimgrep' | 'compact';
export type SearchHighlightMode = 'auto' | 'always' | 'never';

let lastSearchCanonicalTelemetry: Partial<CanonicalLogInput> | null = null;

// `cli.ts` wraps `runSearch()` with canonical logging and drains this after
// the command returns. Keep only redacted query fields here because daemon
// handlers can call `runSearch()` directly without that wrapper.
export function takeLastSearchCanonicalTelemetry(): Partial<CanonicalLogInput> | null {
  const out = lastSearchCanonicalTelemetry;
  lastSearchCanonicalTelemetry = null;
  return out;
}

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
  pager: PagerFlag;
  interactive: boolean;
  batchJsonl: boolean;
  noCache: boolean;
  freshness: boolean;
  highlight: SearchHighlightMode;
  explainEmpty: boolean;
  explain: boolean;
  neighborContext?: NeighborContextOptions;
  gateOverride?: RelevanceGateOverride;
  rerankOverride?: RerankOverride;
  diverse: boolean;
  antiQueries: string[];
  plusQueries: string[];
  minusQueries: string[];
  taskContext?: string;
  taskContextFile?: string;
  lexicalUnit: LexicalRankingUnit;
}

export interface RunSearchDeps {
  bootstrapLayout: typeof FaissIndexManager.bootstrapLayout;
  resolveActiveModel: typeof resolveActiveModel;
  loadManagerForModel: typeof loadManagerForModel;
  loadWithJsonRetry: typeof loadWithJsonRetry;
  writeOutput?: typeof writeMaybePagedOutput;
  computeStaleness?: typeof computeStaleness;
  listLexicalKbs?: typeof listLexicalKbs;
  loadLexicalIndex?: typeof LexicalIndex.load;
  runLexicalLeg?: typeof runLexicalLeg;
}

const DEFAULT_RUN_SEARCH_DEPS: RunSearchDeps = {
  bootstrapLayout: FaissIndexManager.bootstrapLayout,
  resolveActiveModel,
  loadManagerForModel,
  loadWithJsonRetry,
  computeStaleness,
  listLexicalKbs,
  runLexicalLeg,
};

export function createRunSearchDeps(overrides: Partial<RunSearchDeps> = {}): RunSearchDeps {
  return { ...DEFAULT_RUN_SEARCH_DEPS, ...overrides };
}

export async function runSearch(
  rest: string[],
  deps: RunSearchDeps = DEFAULT_RUN_SEARCH_DEPS,
): Promise<number> {
  lastSearchCanonicalTelemetry = null;
  const totalStartedAt = nowMs();
  let parsed: SearchArgs;
  try {
    parsed = parseSearchArgs(rest);
  } catch (err) {
    process.stderr.write(`kb search: ${(err as Error).message}\n`);
    return 2;
  }

  if (parsed.stdin && parsed.query === null) {
    if (parsed.batchJsonl) {
      process.stderr.write('kb search: --stdin cannot be combined with --batch-jsonl\n');
      return 2;
    }
    parsed.query = await readAllStdin();
    if (parsed.query.trim() === '') {
      process.stderr.write('kb search: empty query from stdin\n');
      return 2;
    }
  } else if (parsed.batchJsonl) {
    if (parsed.query !== null) {
      process.stderr.write('kb search: --batch-jsonl reads queries from stdin; do not pass <query>\n');
      return 2;
    }
    if (hasAdvancedRetrieval(parsed)) {
      process.stderr.write('kb search: advanced retrieval operators are not supported with --batch-jsonl\n');
      return 2;
    }
    if (parsed.interactive) {
      process.stderr.write('kb search: --interactive cannot be combined with --batch-jsonl\n');
      return 2;
    }
    return runBatchJsonlSearch(parsed, deps, totalStartedAt);
  } else if (parsed.query === null) {
    process.stderr.write('kb search: missing <query> (or use --stdin)\n');
    return 2;
  }

  let taskContextSource: TaskContextSource | null = null;
  if (parsed.taskContextFile !== undefined) {
    try {
      parsed.taskContext = await fsp.readFile(parsed.taskContextFile, 'utf-8');
      taskContextSource = 'file';
    } catch (err) {
      process.stderr.write(`kb search: could not read --task-context-file: ${(err as Error).message}\n`);
      return 2;
    }
  } else if (parsed.taskContext !== undefined) {
    taskContextSource = 'argv';
  }

  // Issue #412 — apply the strict/warn task-context policy before the gate
  // sees the text. Warnings are stderr-only (stdout/JSON unchanged); strict
  // mode refuses injection-signal-bearing task context with exit 2.
  if (parsed.taskContext !== undefined && taskContextSource !== null) {
    const inspection = inspectTaskContext({
      text: parsed.taskContext,
      source: taskContextSource,
      mode: resolveTaskContextPolicyMode(),
      argvMax: resolveTaskContextArgvMax(),
    });
    for (const warning of inspection.warnings) {
      process.stderr.write(`kb search: ${warning}\n`);
    }
    if (inspection.refused) {
      process.stderr.write(`kb search: ${inspection.refuseReason}\n`);
      return 2;
    }
  }
  const query = parsed.query;

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
  if (hasAdvancedRetrieval(parsed) && effectiveMode !== 'dense') {
    process.stderr.write('kb search: advanced retrieval operators are only supported with --mode=dense\n');
    return 2;
  }
  if (hasAdvancedRetrieval(parsed) && parsed.thresholdAuto) {
    process.stderr.write('kb search: --threshold=auto cannot be combined with advanced retrieval operators\n');
    return 2;
  }
  if (hasAdvancedRetrieval(parsed) && parsed.interactive) {
    process.stderr.write('kb search: --interactive cannot be combined with advanced retrieval operators\n');
    return 2;
  }

  if (parsed.explainEmpty && effectiveMode !== 'dense') {
    process.stderr.write(
      `kb search: --explain-empty is dense-only; ignored under --mode=${effectiveMode}\n`,
    );
  }

  if (effectiveMode === 'lexical') {
    warnIfRerankIgnored(parsed, effectiveMode);
    return runLexicalSearch(effectiveParsed, timing, totalStartedAt, autoModeDecision, deps);
  }
  if (effectiveMode === 'hybrid') {
    return runHybridSearch(effectiveParsed, timing, totalStartedAt, autoModeDecision, deps);
  }
  warnIfRerankIgnored(parsed, effectiveMode);

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
  let advancedRetrieval: AdvancedRetrievalMetadata | null = null;
  const denseTiming: SimilaritySearchTiming = {};
  try {
    const startedAt = nowMs();
    if (hasAdvancedRetrieval(parsed)) {
      const advanced = await runAdvancedDenseSearch({
        manager,
        query,
        parsed,
        denseTiming,
      });
      results = advanced.results;
      advancedRetrieval = advanced.metadata;
    } else if (parsed.thresholdAuto) {
      const rawResults = await manager.similaritySearch(
        query,
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
        query,
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

  const denseDistanceById = new Map<string, number>();
  for (const result of results) {
    denseDistanceById.set(chunkIdFromMetadata(result.metadata as Record<string, unknown>), result.score);
  }
  let gateVerdict: RelevanceGateVerdict;
  try {
    const gate = await applyRelevanceGate({
      query,
      taskContext: parsed.taskContext,
      candidates: results,
      denseDistanceById,
      gateOverride: parsed.gateOverride,
      process: 'cli',
    });
    results = gate.results;
    if (advancedRetrieval !== null) {
      advancedRetrieval = filterAdvancedRetrievalMetadata(advancedRetrieval, results);
    }
    gateVerdict = gate.verdict;
    emitRelevanceGateDecision({
      process: 'cli',
      query,
      kbScope: parsed.kb ?? null,
      searchMode: effectiveMode,
      verdict: gateVerdict,
      observability: gate.observability,
    });
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  const filterDiagnostics =
    timing && results.length > 0
      ? buildFilterSelectivityDiagnostics({
          parsed,
          denseTiming,
        })
      : null;

  const staleness = parsed.freshness
    ? await computeStalenessWithTiming(activeModelId, parsed.kb, timing)
    : null;

  const explainEmptyDiagnostics =
    parsed.explainEmpty && results.length === 0
      ? await gatherExplainEmptyDiagnostics({
          manager,
          query,
          threshold: parsed.thresholdAuto
            ? Number.POSITIVE_INFINITY
            : parsed.threshold ?? 2,
          scopedKb: parsed.kb,
          noCache: parsed.noCache,
          staleness,
        })
      : null;

  if (timing) timing.total_ms = elapsedMs(totalStartedAt);
  recordDenseSearchCanonicalTelemetry({
    query,
    activeModelId,
    scopedKb: parsed.kb,
    k: parsed.k,
    threshold: parsed.thresholdAuto ? autoThresholdDecision?.threshold : parsed.threshold,
    searchMode: effectiveMode,
    results,
    denseTiming,
  });

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
      query,
      staleness,
      autoThresholdDecision,
      timing,
      filterDiagnostics,
      explainEmptyDiagnostics,
      gateVerdict,
      advancedRetrieval,
      queryCache: denseTiming.query_cache_telemetry,
    });
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (parsed.format === 'vimgrep') {
    const out = formatRetrievalAsVimgrep(results);
    if (out !== '') process.stdout.write(`${out}\n`);
  } else if (parsed.format === 'compact') {
    await writeSearchOutput(parsed, deps, formatDenseSearchCompactOutput({
      results,
      mode: effectiveMode,
      staleness,
      refreshed: parsed.refresh,
      gateVerdict,
      timing,
      filterDiagnostics,
    }));
  } else {
    await writeSearchOutput(parsed, deps, formatDenseSearchMarkdownOutput({
      results,
      groupBySource: parsed.groupBySource,
      staleness,
      refreshed: parsed.refresh,
      scopedKb: parsed.kb,
      query,
      autoModeDecision,
      autoThresholdDecision,
      timing,
      filterDiagnostics,
      explainEmptyDiagnostics,
      gateVerdict,
      explain: parsed.explain,
      advancedRetrieval,
      highlight: buildSearchHighlightOptions(parsed, query),
    }));
  }

  return 0;
}

async function writeSearchOutput(
  parsed: SearchArgs,
  deps: RunSearchDeps,
  output: string,
): Promise<void> {
  await (deps.writeOutput ?? writeMaybePagedOutput)(output, {
    flag: parsed.pager,
    format: parsed.format,
    env: process.env,
    stdoutIsTTY: process.stdout.isTTY === true,
    stdout: process.stdout,
    stderr: process.stderr,
  });
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
    threshold: input.threshold ?? 2,
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

async function runAdvancedDenseSearch(input: {
  manager: FaissIndexManager;
  query: string;
  parsed: SearchArgs;
  denseTiming: SimilaritySearchTiming;
}): Promise<{ results: SearchResultDocument[]; metadata: AdvancedRetrievalMetadata }> {
  const candidateK = computeAdvancedCandidateK(input.parsed.k);
  const pools: AdvancedRetrievalPool[] = [];
  const searchComponent = async (role: AdvancedRetrievalPool['role'], query: string): Promise<void> => {
    const results = await input.manager.similaritySearch(
      query,
      candidateK,
      input.parsed.threshold,
      input.parsed.kb,
      undefined,
      input.denseTiming,
      { noCache: input.parsed.noCache },
    );
    pools.push({ role, query, results });
  };

  await searchComponent('primary', input.query);
  for (const query of input.parsed.plusQueries) {
    await searchComponent('plus', query);
  }
  for (const query of input.parsed.antiQueries) {
    await searchComponent('anti_query', query);
  }
  for (const query of input.parsed.minusQueries) {
    await searchComponent('minus', query);
  }

  return applyAdvancedRetrieval(pools, {
    k: input.parsed.k,
    candidateK,
    diverse: input.parsed.diverse,
    plusQueries: input.parsed.plusQueries,
    antiQueries: input.parsed.antiQueries,
    minusQueries: input.parsed.minusQueries,
    scopedKb: input.parsed.kb,
    threshold: input.parsed.threshold,
  });
}

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
    pager: null,
    interactive: false,
    batchJsonl: false,
    noCache: false,
    freshness: true,
    highlight: 'auto',
    explainEmpty: false,
    explain: false,
    diverse: false,
    antiQueries: [],
    plusQueries: [],
    minusQueries: [],
    lexicalUnit: 'chunk',
  };
  for (const raw of rest) {
    if (raw === '--refresh') { out.refresh = true; continue; }
    if (raw === '--stdin')   { out.stdin = true; continue; }
    if (raw === '--group-by-source') { out.groupBySource = true; continue; }
    if (raw === '--timing') { out.timing = true; continue; }
    if (raw === '--pager') { out.pager = true; continue; }
    if (raw === '--no-pager') { out.pager = false; continue; }
    if (raw === '--no-cache') { out.noCache = true; continue; }
    if (raw === '--highlight') { out.highlight = 'always'; continue; }
    if (raw === '--no-highlight') { out.highlight = 'never'; continue; }
    if (raw === '--gate') { out.gateOverride = 'on'; continue; }
    if (raw === '--no-gate') { out.gateOverride = 'off'; continue; }
    if (raw === '--rerank') { out.rerankOverride = 'on'; continue; }
    if (raw === '--no-rerank') { out.rerankOverride = 'off'; continue; }
    if (raw === '--no-freshness') { out.freshness = false; continue; }
    if (raw === '--explain-empty') { out.explainEmpty = true; continue; }
    if (raw === '--explain') { out.explain = true; continue; }
    if (raw === '--diverse') { out.diverse = true; continue; }
    if (raw === '--interactive' || raw === '-i') { out.interactive = true; continue; }
    if (raw === '--batch-jsonl') { out.batchJsonl = true; out.format = 'json'; continue; }
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
    if (raw.startsWith('--task-context=')) { out.taskContext = raw.slice('--task-context='.length); continue; }
    if (raw.startsWith('--task-context-file=')) { out.taskContextFile = raw.slice('--task-context-file='.length); continue; }
    if (raw.startsWith('--anti-query=')) {
      out.antiQueries.push(parseNonEmptyComponent(raw, '--anti-query='));
      continue;
    }
    if (raw.startsWith('--plus=')) {
      out.plusQueries.push(parseNonEmptyComponent(raw, '--plus='));
      continue;
    }
    if (raw.startsWith('--minus=')) {
      out.minusQueries.push(parseNonEmptyComponent(raw, '--minus='));
      continue;
    }
    if (raw.startsWith('--mode=')) {
      const v = raw.slice('--mode='.length);
      if (v !== 'dense' && v !== 'lexical' && v !== 'hybrid' && v !== 'auto') {
        throw new Error(`invalid --mode: ${raw} (expected 'dense', 'lexical', 'hybrid', or 'auto')`);
      }
      out.mode = v; continue;
    }
    if (raw.startsWith('--lexical-unit=')) {
      const v = raw.slice('--lexical-unit='.length);
      if (v !== 'chunk' && v !== 'source') {
        throw new Error(`invalid --lexical-unit: ${raw} (expected 'chunk' or 'source')`);
      }
      out.lexicalUnit = v; continue;
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
      if (v !== 'md' && v !== 'json' && v !== 'vimgrep' && v !== 'compact' && v !== 'table') {
        throw new Error(`invalid --format: ${raw}`);
      }
      out.format = v === 'table' ? 'compact' : v; continue;
    }
    if (raw.startsWith('--highlight=')) {
      const v = raw.slice('--highlight='.length);
      if (v !== 'auto' && v !== 'always' && v !== 'never') {
        throw new Error(`invalid --highlight: ${raw} (expected 'auto', 'always', or 'never')`);
      }
      out.highlight = v; continue;
    }
    if (raw.startsWith('--view=')) {
      const v = raw.slice('--view='.length);
      if (v !== 'compact') throw new Error(`invalid --view: ${raw} (expected 'compact')`);
      out.format = 'compact'; continue;
    }
    if (raw.startsWith('--')) throw new Error(`unknown flag: ${raw}`);
    if (out.query === null) { out.query = raw; continue; }
    throw new Error(`unexpected argument: ${raw}`);
  }
  return out;
}

function parseNonEmptyComponent(raw: string, prefix: string): string {
  const value = raw.slice(prefix.length);
  if (value.trim() === '') {
    throw new Error(`invalid ${prefix.slice(0, -1)}: value must not be empty`);
  }
  return value;
}

function buildSearchHighlightOptions(
  parsed: SearchArgs,
  query: string,
): RetrievalHighlightOptions | undefined {
  if (!shouldHighlightSearchOutput(parsed, process.env, process.stdout.isTTY === true)) {
    return undefined;
  }
  const terms = extractSearchHighlightTerms(query);
  return terms.length === 0 ? undefined : { terms };
}

export function shouldHighlightSearchOutput(
  parsed: { format: SearchFormat; highlight: SearchHighlightMode },
  env: NodeJS.ProcessEnv = process.env,
  stdoutIsTTY: boolean = process.stdout.isTTY === true,
): boolean {
  if (parsed.format !== 'md') return false;
  if (parsed.highlight === 'never') return false;
  if (env.NO_COLOR !== undefined) return false;
  if (parsed.highlight === 'always') return true;
  return stdoutIsTTY;
}

export function extractSearchHighlightTerms(query: string): string[] {
  const terms = query
    .normalize('NFKC')
    .match(/[\p{L}\p{N}_./:@+-]+/gu) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const trimmed = term.trim();
    if (trimmed === '') continue;
    if (!/[\p{L}\p{N}]/u.test(trimmed)) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out.sort((left, right) => right.length - left.length);
}

function warnIfRerankIgnored(parsed: SearchArgs, effectiveMode: EffectiveSearchMode): void {
  let enabled: boolean;
  if (parsed.rerankOverride === 'on') {
    enabled = true;
  } else if (parsed.rerankOverride === 'off') {
    enabled = false;
  } else {
    try {
      enabled = parseRerankFlag(process.env.KB_RERANK);
    } catch (err) {
      process.stderr.write(
        `kb search: invalid KB_RERANK ignored under --mode=${effectiveMode}: ${(err as Error).message}\n`,
      );
      return;
    }
  }
  if (enabled && effectiveMode !== 'hybrid') {
    process.stderr.write(`kb search: rerank is currently hybrid-only; ignored under --mode=${effectiveMode}\n`);
  }
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
 * Structured/compact surfaces are consumed by agents, editors, or scan-heavy
 * terminal workflows; if both `-i` and one of those formats are passed, the
 * format wins so callers that pass both stay deterministic (#215, #432).
 */
export function shouldUsePicker(parsed: { interactive: boolean; format: SearchFormat }): boolean {
  if (!parsed.interactive) return false;
  if (parsed.format === 'json' || parsed.format === 'vimgrep' || parsed.format === 'compact') return false;
  return true;
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
  if (source.post_filter_kept !== undefined) target.post_filter_kept = source.post_filter_kept;
  if (source.total_ms !== undefined) target.dense_total_ms = source.total_ms;
  if (source.fetch_k !== undefined) target.fetch_k = source.fetch_k;
  if (source.sidecar_candidates !== undefined) target.sidecar_candidates = source.sidecar_candidates;
  if (source.sidecar_fast_path !== undefined) target.sidecar_fast_path = source.sidecar_fast_path;
  if (source.query_cache_telemetry !== undefined) {
    target.query_cache = source.query_cache_telemetry.outcome;
    target.query_cache_enabled = source.query_cache_telemetry.enabled;
    target.query_cache_model_id = source.query_cache_telemetry.model_id;
    target.query_cache_elapsed_ms = source.query_cache_telemetry.elapsed_ms;
  } else if (source.query_cache !== undefined) {
    target.query_cache = source.query_cache;
  }
}

export interface FilterSelectivityDiagnostics {
  schemaVersion: 'kb.search.filter-diagnostics.v1';
  fetchK: number | null;
  sidecarCandidates: number | null;
  sidecarFastPath: SimilaritySearchTiming['sidecar_fast_path'] | null;
  postFilterKept: number | null;
  postFilterMs: number | null;
}

function buildFilterSelectivityDiagnostics(input: {
  parsed: SearchArgs;
  denseTiming: SimilaritySearchTiming;
}): FilterSelectivityDiagnostics | null {
  if (!input.parsed.timing) return null;
  if (hasAdvancedRetrieval(input.parsed)) return null;
  if (!hasFilterSelectivitySurface(input.parsed, input.denseTiming)) return null;
  return {
    schemaVersion: 'kb.search.filter-diagnostics.v1',
    fetchK: input.denseTiming.fetch_k ?? null,
    sidecarCandidates: input.denseTiming.sidecar_candidates ?? null,
    sidecarFastPath: input.denseTiming.sidecar_fast_path ?? null,
    postFilterKept: input.denseTiming.post_filter_kept ?? null,
    postFilterMs: input.denseTiming.post_filter_ms ?? null,
  };
}

function hasFilterSelectivitySurface(
  parsed: SearchArgs,
  denseTiming: SimilaritySearchTiming,
): boolean {
  return (
    typeof parsed.kb === 'string' && parsed.kb.length > 0
  ) || denseTiming.sidecar_candidates !== undefined
    || denseTiming.sidecar_fast_path !== undefined
    || denseTiming.post_filter_kept !== undefined;
}

function recordDenseSearchCanonicalTelemetry(input: {
  query: string;
  activeModelId: string;
  scopedKb: string | undefined;
  k: number;
  threshold: number | undefined;
  searchMode: EffectiveSearchMode;
  results: ScoredDocument[];
  denseTiming: SimilaritySearchTiming;
}): void {
  const queryCache = input.denseTiming.query_cache_telemetry;
  lastSearchCanonicalTelemetry = {
    query_sha256: hashQuery(input.query),
    query_len_chars: input.query.length,
    model_id: input.activeModelId,
    kb_scope: input.scopedKb ?? null,
    k: input.k,
    threshold: input.threshold,
    search_mode: input.searchMode,
    result_count: input.results.length,
    top_score: input.results[0]?.score,
    top_sources: topSourcesForCanonicalLog(input.results),
    embed_ms: input.denseTiming.embed_query_ms,
    faiss_ms: input.denseTiming.faiss_search_ms ?? input.denseTiming.query_search_ms,
    cache: queryCache?.outcome,
    query_cache: queryCache,
  };
}

function topSourcesForCanonicalLog(results: readonly ScoredDocument[]): string[] {
  const out: string[] = [];
  for (const result of results) {
    const source = (result.metadata as Record<string, unknown>).source;
    if (typeof source !== 'string') continue;
    out.push(source);
    if (out.length >= 3) break;
  }
  return out;
}

async function computeStalenessWithTiming(
  activeModelId: string,
  scopedKb: string | undefined,
  timing: TimingPayload | null,
  compute: typeof computeStaleness = computeStaleness,
): Promise<Staleness> {
  const stalenessStartedAt = nowMs();
  const staleness = await compute(activeModelId, scopedKb);
  if (timing) {
    recordFreshnessScanTiming(timing, {
      elapsedMs: elapsedMs(stalenessStartedAt),
      ...(staleness.scan ?? {
        scope: scopedKb ? 'scoped' as const : 'global' as const,
        source: 'none' as const,
        filesScanned: 0,
        globalFiles: 0,
        ...(scopedKb ? { scopedFiles: 0 } : {}),
        kbsScanned: 0,
      }),
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
  filterDiagnostics?: FilterSelectivityDiagnostics | null;
  /** Issue #328 — opt-in deep diagnostics for an empty result set. Ignored when results is non-empty. */
  explainEmptyDiagnostics?: ExplainEmptyDiagnostics | null;
  gateVerdict?: RelevanceGateVerdict;
  advancedRetrieval?: AdvancedRetrievalMetadata | null;
  queryCache?: QueryCacheTelemetry;
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
  if (input.results.length > 0 && input.filterDiagnostics) {
    payload.filter_diagnostics = filterSelectivityDiagnosticsToJson(input.filterDiagnostics);
  }
  if (input.autoThresholdDecision !== null) {
    payload.auto_threshold = {
      threshold: input.autoThresholdDecision.threshold,
      knee_index: input.autoThresholdDecision.kneeIndex,
      kept: input.autoThresholdDecision.kept,
    };
  }
  payload.gate_verdict = input.gateVerdict ?? defaultBypassedGateVerdict(input.results.length);
  if (input.advancedRetrieval !== undefined && input.advancedRetrieval !== null) {
    payload.advanced_retrieval = input.advancedRetrieval;
  }
  if (input.queryCache !== undefined) {
    payload.query_cache = input.queryCache;
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
  filterDiagnostics?: FilterSelectivityDiagnostics | null;
  /** Issue #328 — opt-in deep diagnostics block, rendered only when results is empty. */
  explainEmptyDiagnostics?: ExplainEmptyDiagnostics | null;
  gateVerdict?: RelevanceGateVerdict;
  explain?: boolean;
  advancedRetrieval?: AdvancedRetrievalMetadata | null;
  highlight?: RetrievalHighlightOptions;
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
    md = formatRetrievalGroupedBySourceAsMarkdown(
      input.results,
      FRONTMATTER_EXTRAS_WIRE_VISIBLE,
      KB_EDITOR_URI,
      input.highlight,
    );
  } else {
    md = formatRetrievalAsMarkdown(
      input.results,
      FRONTMATTER_EXTRAS_WIRE_VISIBLE,
      KB_EDITOR_URI,
      input.highlight,
    );
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
  if (input.advancedRetrieval !== undefined && input.advancedRetrieval !== null) {
    output += `${formatAdvancedRetrievalFooter(input.advancedRetrieval)}\n`;
  }
  if (input.results.length > 0 && input.filterDiagnostics) {
    output += `${formatFilterSelectivityDiagnosticsFooter(input.filterDiagnostics)}\n`;
  }
  const gateVerdict = input.gateVerdict ?? defaultBypassedGateVerdict(input.results.length);
  if (gateVerdict.state !== 'bypassed') {
    output += `${formatGateVerdictFooter(gateVerdict)}\n`;
  }
  if (input.explain) {
    output += `${formatGateDroppedList(gateVerdict)}\n`;
  }
  if (input.timing) {
    output += `${formatTimingFooter('Timing', input.timing)}\n`;
  }
  return output;
}

function formatAdvancedRetrievalFooter(metadata: AdvancedRetrievalMetadata): string {
  const positives = metadata.query_components
    .filter((component) => component.role === 'primary' || component.role === 'plus')
    .length;
  const negatives = metadata.query_components.length - positives;
  const scope = metadata.constraints.kb ? `, kb=${metadata.constraints.kb}` : '';
  return `> _Advanced retrieval: ${metadata.mode}; candidates ${metadata.candidate_pool_k}; ` +
    `${positives} positive component(s), ${negatives} negative component(s)${scope}; ` +
    'positive-support constrained._';
}

export function formatDenseSearchCompactOutput(input: {
  results: ScoredDocument[];
  mode: EffectiveSearchMode;
  staleness: Staleness | null;
  refreshed: boolean;
  gateVerdict?: RelevanceGateVerdict;
  timing: TimingPayload | null;
  filterDiagnostics?: FilterSelectivityDiagnostics | null;
  width?: number;
}): string {
  let output = `${formatRetrievalAsCompactTable(input.results, {
    mode: input.mode,
    gate: compactGateMarker(input.gateVerdict),
    width: input.width ?? process.stdout.columns,
  })}\n`;
  if (input.staleness !== null) {
    output += `${formatFreshnessFooter(input.staleness, input.refreshed)}\n`;
  }
  const gateVerdict = input.gateVerdict ?? defaultBypassedGateVerdict(input.results.length);
  if (gateVerdict.state !== 'bypassed') {
    output += `${formatGateVerdictFooter(gateVerdict)}\n`;
  }
  if (input.results.length > 0 && input.filterDiagnostics) {
    output += `${formatFilterSelectivityDiagnosticsFooter(input.filterDiagnostics)}\n`;
  }
  if (input.timing) {
    output += `${formatTimingFooter('Timing', input.timing)}\n`;
  }
  return output;
}

function compactGateMarker(gateVerdict: RelevanceGateVerdict | undefined): 'bypassed' | 'kept' {
  if (gateVerdict === undefined || gateVerdict.state === 'bypassed') return 'bypassed';
  return 'kept';
}

function filterSelectivityDiagnosticsToJson(
  diagnostics: FilterSelectivityDiagnostics,
): Record<string, unknown> {
  return {
    schema_version: diagnostics.schemaVersion,
    fetch_k: diagnostics.fetchK,
    sidecar_candidates: diagnostics.sidecarCandidates,
    sidecar_fast_path: diagnostics.sidecarFastPath,
    post_filter_kept: diagnostics.postFilterKept,
    post_filter_ms: diagnostics.postFilterMs,
  };
}

function formatFilterSelectivityDiagnosticsFooter(
  diagnostics: FilterSelectivityDiagnostics,
): string {
  const fields = [
    ['fetch_k', diagnostics.fetchK],
    ['sidecar_candidates', diagnostics.sidecarCandidates],
    ['sidecar_fast_path', diagnostics.sidecarFastPath],
    ['post_filter_kept', diagnostics.postFilterKept],
    ['post_filter_ms', diagnostics.postFilterMs],
  ]
    .filter((entry): entry is [string, string | number] => entry[1] !== null)
    .map(([key, value]) => `${key}=${formatFilterDiagnosticValue(key, value)}`);
  const body = fields.length > 0 ? fields.join(', ') : 'no aggregate counters';
  return `> _Filter diagnostics: ${body}._`;
}

function formatFilterDiagnosticValue(key: string, value: string | number): string {
  if (typeof value === 'number' && key.endsWith('_ms')) return `${Math.round(value)}ms`;
  return String(value);
}

function defaultBypassedGateVerdict(count: number): RelevanceGateVerdict {
  return {
    schema_version: RELEVANCE_GATE_SCHEMA_VERSION,
    state: 'bypassed',
    low_confidence: false,
    input_count: count,
    output_count: count,
    dropped: [],
    judge: { status: 'not-run', reason: 'gate disabled' },
    empty_verdict_enabled: false,
  };
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
  maybeWriteRefreshPreflight(estimate, { format: format === 'compact' ? 'md' : format });
}

const BATCH_JSONL_SCHEMA_VERSION = 'kb.search.batch-jsonl.v1';

interface BatchManagerState {
  manager: FaissIndexManager;
  loaded: boolean;
  refreshedScopes: Set<string>;
}

interface BatchSearchEnvelope {
  schema_version: typeof BATCH_JSONL_SCHEMA_VERSION;
  line: number;
  ok: boolean;
  query?: string;
  kb?: string | null;
  model?: string;
  mode?: EffectiveSearchMode;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    category: SearchFailure['category'] | 'input';
    message: string;
    next_action: string;
  };
}

async function runBatchJsonlSearch(
  parsed: SearchArgs,
  deps: RunSearchDeps,
  totalStartedAt: number,
): Promise<number> {
  const input = await readAllStdin();
  const lines = input.split(/\r?\n/);
  const activeModelCache = new Map<string, string>();
  const managers = new Map<string, BatchManagerState>();
  const stalenessCache = new Map<string, Staleness>();
  let bootstrapped = false;
  let exitCode = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineNumber = lineIndex + 1;
    const line = lines[lineIndex];
    if (line.trim() === '') continue;

    let row: SearchArgs;
    try {
      row = parseBatchJsonlRow(line, lineNumber, parsed);
    } catch (err) {
      writeBatchEnvelope(batchInputError(lineNumber, (err as Error).message));
      exitCode = Math.max(exitCode, 2);
      continue;
    }

    const query = row.query as string;
    const autoModeDecision = row.mode === 'auto'
      ? resolveAutoSearchMode(query)
      : null;
    const effectiveMode: EffectiveSearchMode = autoModeDecision
      ? autoModeDecision.mode
      : (row.mode as EffectiveSearchMode);
    if (effectiveMode !== 'dense') {
      writeBatchEnvelope(batchInputError(
        lineNumber,
        `--batch-jsonl currently supports dense search rows only; row resolved to mode=${effectiveMode}`,
        query,
        row.kb,
      ));
      exitCode = Math.max(exitCode, 2);
      continue;
    }
    const taskContextCheck = inspectBatchTaskContext(row);
    for (const warning of taskContextCheck.warnings) {
      process.stderr.write(`kb search: ${warning}\n`);
    }
    if (taskContextCheck.error) {
      writeBatchEnvelope(batchInputError(lineNumber, taskContextCheck.error, query, row.kb));
      exitCode = Math.max(exitCode, 2);
      continue;
    }

    const timing: TimingPayload | null = row.timing
      ? {
          requested_mode: row.mode,
          effective_mode: effectiveMode,
        }
      : null;

    try {
      if (!bootstrapped) {
        const startedAt = nowMs();
        await deps.bootstrapLayout();
        bootstrapped = true;
        if (timing) timing.bootstrap_ms = elapsedMs(startedAt);
      }

      const activeModelId = await resolveBatchActiveModel(row, deps, activeModelCache, timing);
      const state = await loadBatchManager(activeModelId, deps, managers, timing);
      const refreshedIndex = await loadBatchIndex(activeModelId, row, deps, state, timing);
      if (refreshedIndex) invalidateBatchStaleness(activeModelId, stalenessCache);

      const denseTiming: SimilaritySearchTiming = {};
      const searchStartedAt = nowMs();
      let results: SearchResultDocument[];
      let autoThresholdDecision: AutoThresholdDecision | null = null;
      if (row.thresholdAuto) {
        const rawResults = await state.manager.similaritySearch(
          query,
          row.k,
          Number.POSITIVE_INFINITY,
          row.kb,
          undefined,
          denseTiming,
          { noCache: row.noCache },
        );
        autoThresholdDecision = computeAutoThreshold(rawResults.map((r) => r.score));
        results = rawResults.slice(0, autoThresholdDecision.kept);
      } else {
        results = await state.manager.similaritySearch(
          query,
          row.k,
          row.threshold,
          row.kb,
          undefined,
          denseTiming,
          { noCache: row.noCache },
        );
      }
      if (row.neighborContext) {
        results = state.manager.expandWithNeighborContext(results, row.neighborContext);
      }
      if (timing) {
        timing.dense_search_ms = elapsedMs(searchStartedAt);
        mergeDenseTiming(timing, denseTiming);
      }

      const denseDistanceById = new Map<string, number>();
      for (const result of results) {
        denseDistanceById.set(chunkIdFromMetadata(result.metadata as Record<string, unknown>), result.score);
      }
      const gate = await applyRelevanceGate({
        query,
        taskContext: row.taskContext,
        candidates: results,
        denseDistanceById,
        gateOverride: row.gateOverride,
        process: 'cli',
      });
      results = gate.results;
      emitRelevanceGateDecision({
        process: 'cli',
        query,
        kbScope: row.kb ?? null,
        searchMode: effectiveMode,
        verdict: gate.verdict,
        observability: gate.observability,
      });

      const staleness = row.freshness
        ? await computeBatchStaleness(activeModelId, row.kb, stalenessCache, timing, deps)
        : null;
      const explainEmptyDiagnostics =
        row.explainEmpty && results.length === 0
          ? await gatherExplainEmptyDiagnostics({
              manager: state.manager,
              query,
              threshold: row.thresholdAuto ? Number.POSITIVE_INFINITY : row.threshold ?? 2,
              scopedKb: row.kb,
              noCache: row.noCache,
              staleness,
            })
          : null;
      if (timing) timing.total_ms = elapsedMs(totalStartedAt);

      writeBatchEnvelope({
        schema_version: BATCH_JSONL_SCHEMA_VERSION,
        line: lineNumber,
        ok: true,
        query,
        kb: row.kb ?? null,
        model: activeModelId,
        mode: effectiveMode,
        result: buildDenseSearchJsonPayload({
          results,
          requestedMode: row.mode,
          effectiveMode,
          autoModeDecision,
          groupBySource: row.groupBySource,
          refreshed: row.refresh,
          scopedKb: row.kb,
          query,
          staleness,
          autoThresholdDecision,
          timing,
          explainEmptyDiagnostics,
          gateVerdict: gate.verdict,
          queryCache: denseTiming.query_cache_telemetry,
        }),
      });
    } catch (err) {
      const failure = classifyKbSearchError(err);
      writeBatchEnvelope({
        schema_version: BATCH_JSONL_SCHEMA_VERSION,
        line: lineNumber,
        ok: false,
        query,
        kb: row.kb ?? null,
        error: {
          code: failure.code,
          category: failure.category,
          message: failure.message,
          next_action: failure.next_action,
        },
      });
      exitCode = Math.max(exitCode, exitCodeForFailure(failure));
    }
  }

  return exitCode;
}

async function resolveBatchActiveModel(
  row: SearchArgs,
  deps: RunSearchDeps,
  cache: Map<string, string>,
  timing: TimingPayload | null,
): Promise<string> {
  const cacheKey = row.model ?? '<active>';
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const startedAt = nowMs();
  const activeModelId = await deps.resolveActiveModel({ explicitOverride: row.model });
  cache.set(cacheKey, activeModelId);
  if (timing) timing.model_resolution_ms = elapsedMs(startedAt);
  return activeModelId;
}

async function loadBatchManager(
  activeModelId: string,
  deps: RunSearchDeps,
  managers: Map<string, BatchManagerState>,
  timing: TimingPayload | null,
): Promise<BatchManagerState> {
  const cached = managers.get(activeModelId);
  if (cached !== undefined) return cached;
  const startedAt = nowMs();
  const manager = await deps.loadManagerForModel(activeModelId);
  const state = { manager, loaded: false, refreshedScopes: new Set<string>() };
  managers.set(activeModelId, state);
  if (timing) timing.manager_load_ms = elapsedMs(startedAt);
  return state;
}

async function loadBatchIndex(
  activeModelId: string,
  row: SearchArgs,
  deps: RunSearchDeps,
  state: BatchManagerState,
  timing: TimingPayload | null,
): Promise<boolean> {
  const startedAt = nowMs();
  let refreshed = false;
  if (row.refresh) {
    const scopeKey = row.kb ?? '<all>';
    if (!state.refreshedScopes.has(scopeKey)) {
      await withWriteLock(state.manager.modelDir, async () => {
        await printRefreshPreflightIfLarge(activeModelId, state.manager, row.kb, row.format);
        await state.manager.initialize();
        await state.manager.updateIndex(row.kb, {
          onProgress: createRefreshProgressReporter(timing),
        });
      });
      state.refreshedScopes.add(scopeKey);
      state.loaded = true;
      refreshed = true;
    }
  } else if (!state.loaded) {
    await deps.loadWithJsonRetry(state.manager);
    state.loaded = true;
  }
  if (timing) timing.index_load_ms = elapsedMs(startedAt);
  return refreshed;
}

async function computeBatchStaleness(
  activeModelId: string,
  scopedKb: string | undefined,
  cache: Map<string, Staleness>,
  timing: TimingPayload | null,
  deps: RunSearchDeps,
): Promise<Staleness> {
  const cacheKey = `${activeModelId}\0${scopedKb ?? ''}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const staleness = await computeStalenessWithTiming(activeModelId, scopedKb, timing, deps.computeStaleness);
  cache.set(cacheKey, staleness);
  return staleness;
}

function invalidateBatchStaleness(activeModelId: string, cache: Map<string, Staleness>): void {
  const prefix = `${activeModelId}\0`;
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

function parseBatchJsonlRow(line: string, lineNumber: number, defaults: SearchArgs): SearchArgs {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    throw new Error(`line ${lineNumber}: invalid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(raw)) {
    throw new Error(`line ${lineNumber}: expected a JSON object`);
  }
  const query = readBatchString(raw, 'query', lineNumber, true);
  if (query.trim() === '') {
    throw new Error(`line ${lineNumber}: query must not be empty`);
  }

  const row: SearchArgs = {
    ...defaults,
    query,
    stdin: false,
    batchJsonl: false,
    interactive: false,
    format: 'json',
  };
  const kb = readBatchString(raw, 'kb', lineNumber, false);
  if (kb !== undefined) row.kb = kb;
  const model = readBatchString(raw, 'model', lineNumber, false);
  if (model !== undefined) row.model = model;
  const k = readBatchInteger(raw, 'k', lineNumber);
  if (k !== undefined) {
    if (k <= 0) throw new Error(`line ${lineNumber}: k must be a positive integer`);
    row.k = k;
  }
  const mode = readBatchString(raw, 'mode', lineNumber, false);
  if (mode !== undefined) {
    if (mode !== 'dense' && mode !== 'lexical' && mode !== 'hybrid' && mode !== 'auto') {
      throw new Error(`line ${lineNumber}: mode must be dense, lexical, hybrid, or auto`);
    }
    row.mode = mode;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'threshold')) {
    const threshold = raw.threshold;
    if (threshold === 'auto') {
      row.thresholdAuto = true;
      row.threshold = undefined;
    } else if (typeof threshold === 'number' && Number.isFinite(threshold)) {
      row.threshold = threshold;
      row.thresholdAuto = false;
    } else {
      throw new Error(`line ${lineNumber}: threshold must be a finite number or "auto"`);
    }
  }
  const noCache = readBatchBoolean(raw, 'no_cache', lineNumber);
  if (noCache !== undefined) row.noCache = noCache;
  const refresh = readBatchBoolean(raw, 'refresh', lineNumber);
  if (refresh !== undefined) row.refresh = refresh;
  const freshness = readBatchBoolean(raw, 'freshness', lineNumber);
  if (freshness !== undefined) row.freshness = freshness;
  const groupBySource = readBatchBoolean(raw, 'group_by_source', lineNumber);
  if (groupBySource !== undefined) row.groupBySource = groupBySource;
  const explainEmpty = readBatchBoolean(raw, 'explain_empty', lineNumber);
  if (explainEmpty !== undefined) row.explainEmpty = explainEmpty;
  const taskContext = readBatchString(raw, 'task_context', lineNumber, false);
  if (taskContext !== undefined) row.taskContext = taskContext;
  const gate = readBatchBoolean(raw, 'gate', lineNumber);
  if (gate !== undefined) row.gateOverride = gate ? 'on' : 'off';
  if (Object.prototype.hasOwnProperty.call(raw, 'rerank')) {
    throw new Error(`line ${lineNumber}: rerank is not supported in batch JSONL dense rows`);
  }
  for (const key of ['diverse', 'anti_query', 'plus', 'minus']) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new Error(`line ${lineNumber}: ${key} is not supported in batch JSONL dense rows`);
    }
  }

  const contextWindow = readBatchInteger(raw, 'context_window', lineNumber);
  const contextBefore = readBatchInteger(raw, 'context_before', lineNumber);
  const contextAfter = readBatchInteger(raw, 'context_after', lineNumber);
  if (contextWindow !== undefined) {
    row.neighborContext = {
      ...row.neighborContext,
      before: validateBatchNeighborContext(contextWindow, 'context_window', lineNumber),
      after: validateBatchNeighborContext(contextWindow, 'context_window', lineNumber),
    };
  }
  if (contextBefore !== undefined) {
    row.neighborContext = {
      ...row.neighborContext,
      before: validateBatchNeighborContext(contextBefore, 'context_before', lineNumber),
    };
  }
  if (contextAfter !== undefined) {
    row.neighborContext = {
      ...row.neighborContext,
      after: validateBatchNeighborContext(contextAfter, 'context_after', lineNumber),
    };
  }
  return row;
}

function inspectBatchTaskContext(row: SearchArgs): { warnings: string[]; error: string | null } {
  if (row.taskContext === undefined) return { warnings: [], error: null };
  const inspection = inspectTaskContext({
    text: row.taskContext,
    source: 'file',
    mode: resolveTaskContextPolicyMode(),
    argvMax: resolveTaskContextArgvMax(),
  });
  return {
    warnings: inspection.warnings,
    error: inspection.refused ? inspection.refuseReason : null,
  };
}

function batchInputError(
  line: number,
  message: string,
  query?: string,
  kb?: string,
): BatchSearchEnvelope {
  return {
    schema_version: BATCH_JSONL_SCHEMA_VERSION,
    line,
    ok: false,
    ...(query !== undefined ? { query } : {}),
    ...(kb !== undefined ? { kb } : {}),
    error: {
      code: 'BATCH_ROW_INVALID',
      category: 'input',
      message,
      next_action: 'Fix the JSONL row and retry.',
    },
  };
}

function writeBatchEnvelope(envelope: BatchSearchEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBatchString(
  row: Record<string, unknown>,
  key: string,
  lineNumber: number,
  required: true,
): string;
function readBatchString(
  row: Record<string, unknown>,
  key: string,
  lineNumber: number,
  required: false,
): string | undefined;
function readBatchString(
  row: Record<string, unknown>,
  key: string,
  lineNumber: number,
  required: boolean,
): string | undefined {
  const value = row[key];
  if (value === undefined) {
    if (required) throw new Error(`line ${lineNumber}: missing ${key}`);
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`line ${lineNumber}: ${key} must be a string`);
  }
  return value;
}

function readBatchBoolean(
  row: Record<string, unknown>,
  key: string,
  lineNumber: number,
): boolean | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`line ${lineNumber}: ${key} must be a boolean`);
  }
  return value;
}

function readBatchInteger(
  row: Record<string, unknown>,
  key: string,
  lineNumber: number,
): number | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`line ${lineNumber}: ${key} must be an integer`);
  }
  return value;
}

function validateBatchNeighborContext(value: number, key: string, lineNumber: number): number {
  if (value < 0 || value > MAX_NEIGHBOR_CONTEXT_WINDOW) {
    throw new Error(`line ${lineNumber}: ${key} must be between 0 and ${MAX_NEIGHBOR_CONTEXT_WINDOW}`);
  }
  return value;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
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
  deps: RunSearchDeps = DEFAULT_RUN_SEARCH_DEPS,
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
    kbs = await (deps.listLexicalKbs ?? listLexicalKbs)(parsed.kb);
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
      const loadLexicalIndex = deps.loadLexicalIndex ?? LexicalIndex.load.bind(LexicalIndex);
      index = await loadLexicalIndex(kbName, kbPath);
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
      hits = await index.query(query, parsed.k, { unit: parsed.lexicalUnit });
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
      lexical: { unit: parsed.lexicalUnit },
      ...(timing ? { timing: compactTimingPayload(timing) } : {}),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (parsed.format === 'vimgrep') {
    const out = formatRetrievalAsVimgrep(formatted as never);
    if (out !== '') process.stdout.write(`${out}\n`);
  } else if (parsed.format === 'compact') {
    let output = '';
    if (autoModeDecision) {
      output += `${formatAutoModeHeader(autoModeDecision)}\n\n`;
    }
    output += `${formatRetrievalAsCompactTable(formatted as never, {
      mode: 'lexical',
      gate: 'bypassed',
      width: process.stdout.columns,
    })}\n`;
    const summary = `${perKb.length} KB(s), ${errors.length} error(s), unit=${parsed.lexicalUnit}`;
    output += `> _Lexical status: ${summary}._\n`;
    if (timing) {
      output += `${formatTimingFooter('Timing', timing)}\n`;
    }
    await writeSearchOutput(parsed, deps, output);
  } else {
    let output = '';
    if (autoModeDecision) {
      output += `${formatAutoModeHeader(autoModeDecision)}\n\n`;
    }
    output += `> _Mode: lexical (BM25, unit=${parsed.lexicalUnit}). Stage 1 — debug surface; see #206._\n\n`;
    if (formatted.length === 0) {
      output += `_No matches._\n\n`;
    } else {
      output += `${formatRetrievalAsMarkdown(
        formatted as never,
        FRONTMATTER_EXTRAS_WIRE_VISIBLE,
        KB_EDITOR_URI,
        buildSearchHighlightOptions(parsed, query),
      )}\n\n`;
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
    output += `> _Lexical index status:_\n${summaryLines.join('\n')}\n`;
    if (timing) {
      output += `\n${formatTimingFooter('Timing', timing)}\n`;
    }
    await writeSearchOutput(parsed, deps, output);
  }

  return errors.length > 0 ? 1 : 0;
}

// -- #206 stage 2 — hybrid (RRF) dispatch ----------------------------------

async function runHybridSearch(
  parsed: SearchArgs,
  timing: TimingPayload | null = null,
  totalStartedAt: number = nowMs(),
  autoModeDecision: AutoSearchModeDecision | null = null,
  deps: RunSearchDeps = DEFAULT_RUN_SEARCH_DEPS,
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
    await deps.bootstrapLayout();
    if (timing) timing.bootstrap_ms = elapsedMs(startedAt);
    startedAt = nowMs();
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
    lexicalKbs = await (deps.listLexicalKbs ?? listLexicalKbs)(parsed.kb);
    if (timing) timing.lexical_kb_list_ms = elapsedMs(startedAt);
  } catch (err) {
    process.stderr.write(`kb search (hybrid): could not list KBs: ${(err as Error).message}\n`);
    return 1;
  }

  const lexicalStartedAt = nowMs();
  const lexicalPromise = (deps.runLexicalLeg ?? runLexicalLeg)({
    kbs: lexicalKbs,
    query,
    fetchK,
    refresh: parsed.refresh ? 'always' : 'when-empty',
    rankingUnit: parsed.lexicalUnit,
    loadIndex: deps.loadLexicalIndex,
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
  let rerankConfig: RerankerConfig;
  try {
    rerankConfig = resolveRerankerConfig(process.env, parsed.rerankOverride, parsed.kb ?? null);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }
  const fusionK = rerankConfig.enabled ? Math.max(parsed.k, rerankConfig.topN) : parsed.k;
  const fusion = fuseHybridResultsWithDiagnostics({
    denseResults,
    lexicalResults,
    k: fusionK,
  });
  let ranked = fusion.results;
  if (timing) timing.fusion_ms = elapsedMs(fusionStartedAt);
  const rerankResult = await applyRerankerIfEnabled({
    query,
    results: ranked,
    k: parsed.k,
    override: parsed.rerankOverride,
    config: rerankConfig,
    process: 'cli',
    searchMode: 'hybrid',
    kbScope: parsed.kb ?? null,
  });
  ranked = rerankResult.results;
  if (timing) {
    if (rerankResult.candidatesIn > 0) {
      timing.rerank_ms = rerankResult.tookMs;
      timing.rerank_cache_hits = rerankResult.cacheHits;
      timing.rerank_candidates = rerankResult.candidatesIn;
      if (rerankResult.degraded) timing.rerank_degraded = true;
    }
    timing.total_ms = elapsedMs(totalStartedAt);
  }

  let gateVerdict: RelevanceGateVerdict;
  try {
    const gate = await applyRelevanceGate({
      query,
      taskContext: parsed.taskContext,
      candidates: ranked,
      denseDistanceById: fusion.denseDistanceById,
      lexicalHitIds: fusion.lexicalHitIds,
      gateOverride: parsed.gateOverride,
      process: 'cli',
    });
    ranked = gate.results;
    gateVerdict = gate.verdict;
    emitRelevanceGateDecision({
      process: 'cli',
      query,
      kbScope: parsed.kb ?? null,
      searchMode: 'hybrid',
      verdict: gateVerdict,
      observability: gate.observability,
    });
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
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
        lexical: {
          fetched: lexicalResults.length,
          refreshed: lexicalResultsRow.refreshed,
          failed: lexicalResultsRow.failed,
          unit: parsed.lexicalUnit,
        },
      },
      rrf: { c: HYBRID_RRF_C, fetch_k: fetchK },
      rerank: {
        enabled: rerankResult.candidatesIn > 0,
        model: rerankResult.model,
        candidates: rerankResult.candidatesIn,
        cache_hits: rerankResult.cacheHits,
        degraded: rerankResult.degraded,
        degrade_reason: rerankResult.degradeReason,
      },
      gate_verdict: gateVerdict,
      ...(timing ? { timing: compactTimingPayload(timing) } : {}),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (parsed.format === 'vimgrep') {
    const out = formatRetrievalAsVimgrep(ranked as never);
    if (out !== '') process.stdout.write(`${out}\n`);
  } else if (parsed.format === 'compact') {
    let output = '';
    if (autoModeDecision) {
      output += `${formatAutoModeHeader(autoModeDecision)}\n\n`;
    }
    output += `${formatRetrievalAsCompactTable(ranked as never, {
      mode: 'hybrid',
      gate: compactGateMarker(gateVerdict),
      width: process.stdout.columns,
    })}\n`;
    output += `> _Hybrid status: dense ${denseResults.length}, lexical ${lexicalResults.length} (${parsed.lexicalUnit}), refreshed ${lexicalResultsRow.refreshed}, failed ${lexicalResultsRow.failed}, RRF c=${HYBRID_RRF_C}._\n`;
    if (rerankResult.candidatesIn > 0) {
      const degraded = rerankResult.degraded ? '; degraded to fused order' : '';
      output += `> _Rerank: ${rerankResult.model}; rescored ${rerankResult.candidatesIn} candidate(s), cache hits ${rerankResult.cacheHits}${degraded}._\n`;
    }
    if (gateVerdict.state !== 'bypassed') {
      output += `${formatGateVerdictFooter(gateVerdict)}\n`;
    }
    if (parsed.explain) {
      output += `${formatGateDroppedList(gateVerdict)}\n`;
    }
    if (timing) {
      output += `${formatTimingFooter('Timing', timing)}\n`;
    }
    await writeSearchOutput(parsed, deps, output);
  } else {
    let output = '';
    if (autoModeDecision) {
      output += `${formatAutoModeHeader(autoModeDecision)}\n\n`;
    }
    output += `> _Mode: hybrid (RRF c=${HYBRID_RRF_C}). Stage 2 - dense + lexical; see #206._\n\n`;
    if (ranked.length === 0) {
      output += `_No matches._\n\n`;
    } else {
      output += `${formatRetrievalAsMarkdown(
        ranked as never,
        FRONTMATTER_EXTRAS_WIRE_VISIBLE,
        KB_EDITOR_URI,
        buildSearchHighlightOptions(parsed, query),
      )}\n\n`;
    }
    output += `> _Hybrid status: dense fetched ${denseResults.length}, lexical fetched ${lexicalResults.length} with unit=${parsed.lexicalUnit} (refreshed ${lexicalResultsRow.refreshed}, ${lexicalResultsRow.failed} failed); fused via RRF (c=${HYBRID_RRF_C}, fetch_k=${fetchK})._\n`;
    if (rerankResult.candidatesIn > 0) {
      const degraded = rerankResult.degraded ? '; degraded to fused order' : '';
      output += `> _Rerank: ${rerankResult.model}; rescored ${rerankResult.candidatesIn} candidate(s), cache hits ${rerankResult.cacheHits}${degraded}._\n`;
    }
    if (gateVerdict.state !== 'bypassed') {
      output += `${formatGateVerdictFooter(gateVerdict)}\n`;
    }
    if (parsed.explain) {
      output += `${formatGateDroppedList(gateVerdict)}\n`;
    }
    if (timing) {
      output += `${formatTimingFooter('Timing', timing)}\n`;
    }
    await writeSearchOutput(parsed, deps, output);
  }

  return 0;
}
