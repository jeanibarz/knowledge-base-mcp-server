// Pure search policy, freshness, and mode-resolution helpers shared by
// `cli-search`, `cli-eval`, `cli-explain`, `retrieval-eval`, and MCP.
//
// Lives here (not in `cli-search.ts`) so non-CLI consumers can import
// search behaviour without depending on a sibling CLI command module
// (issue #341 boundary fix). CLI argv parsing, stderr writers, and
// payload assembly stay in `cli-search.ts`; this module is the
// command-independent core.

import * as fsp from 'fs/promises';
import * as path from 'path';
import { resolveFaissIndexBinaryPath } from './active-model.js';
import { mapBounded, resolveFsConcurrency } from './bounded-concurrency.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import type { SearchResultDocument } from './FaissIndexManager.js';
import type {
  FreshnessScanScope,
  FreshnessScanSource,
} from './cli-timing.js';
import { readFreshnessManifest } from './freshness-manifest.js';
import { enumerateIngestableKbFiles, listKnowledgeBases } from './kb-fs.js';

// -- Search mode -------------------------------------------------------------

export type SearchMode = 'dense' | 'lexical' | 'hybrid' | 'auto';
export type EffectiveSearchMode = Exclude<SearchMode, 'auto'>;

export interface AutoSearchModeDecision {
  mode: EffectiveSearchMode;
  reason: string;
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

// -- Auto-threshold (knee detection) -----------------------------------------

export interface AutoThresholdDecision {
  threshold: number;
  kneeIndex: number | null;
  kept: number;
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

// -- Index freshness (staleness scan) ----------------------------------------

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

export function hasStaleCounts(counts: StalenessCounts): boolean {
  return counts.modifiedFiles + counts.newFiles > 0;
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
