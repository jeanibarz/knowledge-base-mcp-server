import * as fsp from 'fs/promises';
import * as path from 'path';
import {
  FaissIndexManager,
  MAX_NEIGHBOR_CONTEXT_WINDOW,
  type NeighborContextOptions,
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
  type TimingPayload,
} from './cli-timing.js';
import { LexicalIndex, type LexicalSearchResult } from './lexical-index.js';
import { chunkIdFromMetadata, reciprocalRankFusion, type RankedList } from './rrf.js';

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

Output ends with a freshness footer (markdown) or staleness fields (JSON)
indicating whether the index is up-to-date relative to KB file mtimes.

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

Indexing:
  --refresh             Re-scan KB files; acquires the per-model write lock.

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
  neighborContext?: NeighborContextOptions;
}

export interface Staleness {
  indexMtime: string | null;
  modifiedFiles: number;
  newFiles: number;
  scope?: StalenessScope;
  global?: StalenessCounts;
}

export interface StalenessCounts {
  modifiedFiles: number;
  newFiles: number;
}

export interface StalenessScope extends StalenessCounts {
  kb: string;
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

export async function runSearch(rest: string[]): Promise<number> {
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

  if (effectiveMode === 'lexical') {
    return runLexicalSearch(effectiveParsed, timing, totalStartedAt, autoModeDecision);
  }
  if (effectiveMode === 'hybrid') {
    return runHybridSearch(effectiveParsed, timing, totalStartedAt, autoModeDecision);
  }

  try {
    const startedAt = nowMs();
    await FaissIndexManager.bootstrapLayout();
    if (timing) timing.bootstrap_ms = elapsedMs(startedAt);
  } catch (err) {
    return reportFailure(classifyKbSearchError(err), parsed.format);
  }

  let activeModelId: string;
  try {
    const startedAt = nowMs();
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
        await manager.initialize();
        await manager.updateIndex(parsed.kb);
      });
    } else {
      await loadWithJsonRetry(manager);
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
        timing ? denseTiming : undefined,
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
        timing ? denseTiming : undefined,
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

  const stalenessStartedAt = nowMs();
  const staleness = await computeStaleness(activeModelId, parsed.kb);
  if (timing) timing.staleness_ms = elapsedMs(stalenessStartedAt);
  if (timing) timing.total_ms = elapsedMs(totalStartedAt);

  if (shouldUsePicker(parsed)) {
    return runPicker({ results: results as ScoredDocument[] });
  }

  if (parsed.format === 'json') {
    const body = formatRetrievalAsJson(results, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI);
    const effectiveCounts = parsed.refresh
      ? { modifiedFiles: 0, newFiles: 0 }
      : { modifiedFiles: staleness.modifiedFiles, newFiles: staleness.newFiles };
    const globalCounts = staleness.global ?? {
      modifiedFiles: staleness.modifiedFiles,
      newFiles: staleness.newFiles,
    };
    const scopedCounts = staleness.scope
      ? {
          modifiedFiles: parsed.refresh ? 0 : staleness.scope.modifiedFiles,
          newFiles: parsed.refresh ? 0 : staleness.scope.newFiles,
        }
      : null;
    const globalCountsForPayload = parsed.refresh && !parsed.kb
      ? { modifiedFiles: 0, newFiles: 0 }
      : globalCounts;
    const payload = {
      results: body,
      ...(parsed.mode === 'auto'
        ? {
            mode: effectiveMode,
            requested_mode: 'auto' as const,
            auto_mode: autoModeDecision,
          }
        : {}),
      ...(parsed.groupBySource
        ? { grouped_results: groupRetrievalBySource(results, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI) }
        : {}),
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
      ...(autoThresholdDecision !== null
        ? {
            auto_threshold: {
              threshold: autoThresholdDecision.threshold,
              knee_index: autoThresholdDecision.kneeIndex,
              kept: autoThresholdDecision.kept,
            },
          }
        : {}),
      ...(timing ? { timing: compactTimingPayload(timing) } : {}),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (parsed.format === 'vimgrep') {
    const out = formatRetrievalAsVimgrep(results);
    if (out !== '') process.stdout.write(`${out}\n`);
  } else {
    if (autoModeDecision !== null) {
      process.stdout.write(formatAutoModeHeader(autoModeDecision));
      process.stdout.write('\n\n');
    }
    if (autoThresholdDecision !== null) {
      process.stdout.write(formatAutoThresholdHeader(autoThresholdDecision));
      process.stdout.write('\n\n');
    }
    const md = parsed.groupBySource
      ? formatRetrievalGroupedBySourceAsMarkdown(results, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI)
      : formatRetrievalAsMarkdown(results, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI);
    process.stdout.write(md);
    process.stdout.write('\n\n');
    process.stdout.write(formatFreshnessFooter(staleness, parsed.refresh));
    process.stdout.write('\n');
    if (timing) {
      process.stdout.write(formatTimingFooter('Timing', timing));
      process.stdout.write('\n');
    }
  }

  return 0;
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
    interactive: false,
    noCache: false,
  };
  for (const raw of rest) {
    if (raw === '--refresh') { out.refresh = true; continue; }
    if (raw === '--stdin')   { out.stdin = true; continue; }
    if (raw === '--group-by-source') { out.groupBySource = true; continue; }
    if (raw === '--timing') { out.timing = true; continue; }
    if (raw === '--no-cache') { out.noCache = true; continue; }
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
  if (!scopedKb) {
    return { indexMtime, modifiedFiles: global.modifiedFiles, newFiles: global.newFiles };
  }

  const scopedEnumeration = enumerations.filter((entry) => entry.kbName === scopedKb);
  const scopeCounts = await countStaleness(scopedEnumeration, indexMtimeMs);
  return {
    indexMtime,
    modifiedFiles: scopeCounts.modifiedFiles,
    newFiles: scopeCounts.newFiles,
    scope: { kb: scopedKb, ...scopeCounts },
    global,
  };
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
  if (!scopedKb) return { indexMtime, modifiedFiles: 0, newFiles: 0 };
  return {
    indexMtime,
    modifiedFiles: 0,
    newFiles: 0,
    scope: { kb: scopedKb, modifiedFiles: 0, newFiles: 0 },
    global: { modifiedFiles: 0, newFiles: 0 },
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
    return { indexMtime, modifiedFiles: global.modifiedFiles, newFiles: global.newFiles };
  }
  const scopedEntry = manifest.kbs[scopedKb];
  if (scopedEntry === undefined) return null;
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
  };
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

function reportFailure(failure: SearchFailure, format: SearchFormat): number {
  if (format === 'json') {
    process.stdout.write(formatKbSearchFailureJson(failure));
  } else {
    process.stderr.write(formatKbSearchFailureStderr(failure));
  }
  return exitCodeForFailure(failure);
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

async function listLexicalKbs(scoped?: string): Promise<Array<{ kbName: string; kbPath: string }>> {
  const all = await listKnowledgeBases(KNOWLEDGE_BASES_ROOT_DIR);
  const filtered = scoped ? all.filter((n) => n === scoped) : all;
  return filtered.map((kbName) => ({
    kbName,
    kbPath: path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName),
  }));
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

const HYBRID_FETCH_MULTIPLIER = 4;
const HYBRID_RRF_C = 60;

interface HybridChunk {
  pageContent: string;
  metadata: Record<string, unknown>;
  score: number;
}

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
  const fetchK = Math.max(parsed.k * HYBRID_FETCH_MULTIPLIER, parsed.k);

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
        await manager.initialize();
        await manager.updateIndex(parsed.kb);
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
      timing ? denseTiming : undefined,
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
  const lexicalPromise: Promise<{ hits: HybridChunk[]; refreshed: number; failed: number }> = (async () => {
    let refreshed = 0;
    let failed = 0;
    const all: LexicalSearchResult[] = [];
    for (const { kbName, kbPath } of lexicalKbs) {
      try {
        const idx = await LexicalIndex.load(kbName, kbPath);
        if (parsed.refresh || idx.numFiles() === 0) {
          await idx.refresh();
          await idx.save();
          refreshed += 1;
        }
        const hits = await idx.query(query, fetchK);
        for (const h of hits) all.push(h);
      } catch (err) {
        failed += 1;
        process.stderr.write(`kb search (hybrid lexical leg): ${kbName} — ${(err as Error).message}\n`);
      }
    }
    all.sort((a, b) => b.score - a.score);
    const top = all.slice(0, fetchK);
    return {
      hits: top.map((h) => ({ pageContent: h.pageContent, metadata: h.metadata, score: h.score })),
      refreshed,
      failed,
    };
  })().then((row) => {
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
  const denseList: RankedList = {
    retriever: 'dense',
    results: denseResults.map((r, i) => ({ id: chunkIdFromMetadata(r.metadata), rank: i + 1 })),
  };
  const lexicalList: RankedList = {
    retriever: 'lexical',
    results: lexicalResults.map((r, i) => ({ id: chunkIdFromMetadata(r.metadata), rank: i + 1 })),
  };
  const fused = reciprocalRankFusion([denseList, lexicalList], { c: HYBRID_RRF_C });

  // Index chunks by id for output. When both legs return the same id, prefer
  // the dense entry (more complete metadata typically), but read from
  // whichever exists.
  const byId = new Map<string, HybridChunk>();
  for (const r of lexicalResults) byId.set(chunkIdFromMetadata(r.metadata), r);
  for (const r of denseResults) byId.set(chunkIdFromMetadata(r.metadata), r);
  const ranked = fused.slice(0, parsed.k).map((f) => {
    const chunk = byId.get(f.id);
    return chunk ? { ...chunk, score: f.fusedScore } : null;
  }).filter((x): x is HybridChunk => x !== null);
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
